/**
 * FileName:    backtest_core.cpp
 * Description: High-performance C++ backtest kernel exposed to Python via pybind11.
 *              Handles only the numeric hot-loop — no DataFrame/timestamp logic.
 *
 *              Covers all three execution styles the Python engine knows:
 *              legacy bar fills, synthetic bid/ask quotes, and stop/take-profit
 *              bracket exits. services/backtest_engine.py keeps a pure-Python
 *              twin of this loop that acts as the parity oracle in tests, so
 *              every rounding choice here deliberately mirrors Python's
 *              round() (ties-to-even via nearbyint, 10dp prices, 2dp money).
 *
 *              Two entry points:
 *                run_backtest_kernel(...)  — one signal set, one run
 *                run_backtest_batch(...)   — N signal sets over one shared
 *                                            OHLC series, fanned out across a
 *                                            thread pool with the GIL released.
 *                                            Threads share the read-only price
 *                                            arrays instead of copying them,
 *                                            which is the whole point on a
 *                                            memory-tight machine.
 */

#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <vector>

namespace py = pybind11;
using namespace pybind11::literals;

//********************************************************
// Internal data structures
//********************************************************

struct TradeRecord {
    int    entry_idx;
    int    exit_idx;
    int    side;          // +1 = long / buy, -1 = short / sell
    double entry_price;
    double exit_price;
    double pnl;           // net of commission, rounded to 2 decimals
    int    exit_reason;   // 0 flip, 1 stop, 2 target, 3 trail, 4 BE, 5 time, 6 session, 7 EOD
};

struct Position {
    bool   open        = false;
    int    side        = 0;
    int    entry_idx   = -1;
    double entry_price = 0.0;

    bool   has_stop      = false;
    double stop_price    = 0.0;
    int    stop_source   = 0;   // 0 initial, 1 breakeven, 2 trailing

    bool   has_target    = false;
    double target_price  = 0.0;

    bool   has_initial_risk = false;
    double initial_risk     = 0.0;
    double best_price       = 0.0;
    bool   breakeven_done   = false;

    bool   has_trailing      = false;
    bool   trailing_active   = false;
    double trailing_distance = 0.0;
};

struct Quote {
    double bid;
    double ask;
    double reference;
};

struct RunConfig {
    double initial_balance;
    double position_size;
    double commission;
    double tick_size;
    double tick_value;
    double slippage_ticks;
    std::optional<double> stop_loss_ticks;
    std::optional<double> take_profit_ticks;
    bool   use_synthetic_quotes;
    int    spread_ticks;
    int    volatile_bar_threshold_ticks;
    int    volatile_bar_extra_ticks;

    std::optional<double> stop_loss_atr;
    std::optional<double> take_profit_atr;
    std::optional<double> trailing_stop_atr;
    std::optional<double> trailing_stop_ticks;
    std::optional<double> trailing_activation_r;
    std::optional<double> breakeven_at_r;
    std::optional<int>    time_stop_bars;
    bool   exit_at_session_end;
    const double* atr;
    const int*    session_end;
};

struct RunResult {
    std::vector<TradeRecord> trades;
    std::vector<double>      equity_curve;
};

//********************************************************
// Rounding helpers — must match Python semantics
//********************************************************

// Python round() is ties-to-even; std::round is ties-away-from-zero.
// nearbyint under the default FE_TONEAREST mode matches Python.
static inline double py_round(double x) {
    return std::nearbyint(x);
}

// Python round(x, 2) / round(x, 10) equivalents. Not bit-perfect for every
// pathological double, but exact for tick-aligned futures prices, which is
// what the parity test locks in.
static inline double py_round2(double x) {
    return std::nearbyint(x * 100.0) / 100.0;
}

static inline double py_round10(double x) {
    return std::nearbyint(x * 1e10) / 1e10;
}

//********************************************************
// Core backtest loop — plain C++, safe to run without the GIL
//********************************************************

static RunResult run_core(
    const double* opens,
    const double* highs,
    const double* lows,
    const double* closes,
    const int*    signals,
    std::size_t   n,
    const RunConfig& cfg
) {
    const double tick_size = cfg.tick_size;
    const bool uses_atr =
        cfg.stop_loss_atr.has_value() ||
        cfg.take_profit_atr.has_value() ||
        cfg.trailing_stop_atr.has_value();

    auto round_to_tick = [&](double price) -> double {
        return py_round10(py_round(price / tick_size) * tick_size);
    };

    auto apply_slippage = [&](double price, int side, bool is_exit) -> double {
        double direction = static_cast<double>(side);
        if (is_exit)
            direction *= -1.0;
        return round_to_tick(price + direction * cfg.slippage_ticks * tick_size);
    };

    auto position_pnl = [&](int side, double entry_price, double exit_price, double trade_commission) -> double {
        const double ticks = static_cast<double>(side) * (exit_price - entry_price) / tick_size;
        return ticks * cfg.tick_value * cfg.position_size - trade_commission;
    };

    // Same fake top-of-book as execution_model.synthetic_quote_for_bar:
    // anchor rounds to tick, spread widens on volatile bars, bid sits
    // floor(spread/2) ticks under the reference.
    auto synthetic_quote = [&](double anchor, double bar_high, double bar_low) -> Quote {
        const int base_spread = std::max(1, cfg.spread_ticks);
        const int threshold   = std::max(0, cfg.volatile_bar_threshold_ticks);
        const int extra       = std::max(0, cfg.volatile_bar_extra_ticks);

        const long long range_ticks =
            std::max(0LL, static_cast<long long>(py_round((bar_high - bar_low) / tick_size)));
        const bool is_volatile = threshold > 0 && extra > 0 && range_ticks >= threshold;
        const int spread = base_spread + (is_volatile ? extra : 0);

        const double reference = round_to_tick(anchor);
        const double bid = py_round10(reference - (spread / 2) * tick_size);
        const double ask = py_round10(bid + spread * tick_size);
        return {bid, ask, reference};
    };

    // Buys flatten into the bid, shorts cover at the ask.
    auto flatten_price = [](int side, const Quote& q) -> double {
        return side == 1 ? q.bid : q.ask;
    };

    auto barrier_price = [&](int side, double entry, double distance, bool is_target) -> double {
        const double raw = side == 1
            ? (is_target ? entry + distance : entry - distance)
            : (is_target ? entry - distance : entry + distance);
        return round_to_tick(raw);
    };

    auto stop_reason = [](int source) -> int {
        if (source == 2) return 3;   // trailing stop
        if (source == 1) return 4;   // breakeven stop
        return 1;                    // original stop
    };

    RunResult out;
    out.equity_curve.reserve(n + 1);
    out.trades.reserve(n / 4);        // rough guess — prevents many resizes

    double   balance = cfg.initial_balance;
    Position pos{};

    out.equity_curve.push_back(balance);  // starting equity (bar 0)

    auto close_position = [&](std::size_t exit_idx, double exit_price, int reason) {
        const double net_pnl = position_pnl(pos.side, pos.entry_price, exit_price, cfg.commission);
        balance += net_pnl;
        out.trades.push_back({
            pos.entry_idx,
            static_cast<int>(exit_idx),
            pos.side,
            pos.entry_price,
            exit_price,
            py_round2(net_pnl),
            reason
        });
        pos = {};   // reset position
    };

    // Main bar-by-bar loop. Signal from bar i - 1 fills at bar i open.
    for(std::size_t i = 1; i < n; ++i){
        const int signal = signals[i - 1];

        Quote  quote{};
        double execution_base;
        if (cfg.use_synthetic_quotes) {
            quote = synthetic_quote(opens[i], highs[i], lows[i]);
            execution_base = quote.reference;
        } else {
            execution_base = round_to_tick(opens[i]);
        }

        // Close existing position on signal flip
        if(pos.open){
            const bool should_close = (pos.side == 1 && signal == -1) || (pos.side ==-1 && signal ==  1);
            if(should_close){
                const double exit_price = cfg.use_synthetic_quotes
                    ? flatten_price(pos.side, quote)
                    : apply_slippage(execution_base, pos.side, true);
                close_position(i, exit_price, 0);
            }
        }

        // Open new position when flat, not on the final bar, and not on a bar
        // that is about to be flattened at session close.
        const bool session_is_closing =
            cfg.exit_at_session_end && cfg.session_end != nullptr && cfg.session_end[i] != 0;

        if(!pos.open && signal != 0 && i < n - 1 && !session_is_closing){
            double entry_atr = 0.0;
            bool atr_ok = true;
            if (uses_atr) {
                if (cfg.atr == nullptr || i == 0) {
                    atr_ok = false;
                } else {
                    entry_atr = cfg.atr[i - 1];
                    if (!std::isfinite(entry_atr) || entry_atr <= 0.0)
                        atr_ok = false;
                }
            }

            if (atr_ok) {
                pos.open = true;
                pos.side = signal;           // +1 or -1
                pos.entry_idx = static_cast<int>(i);
                pos.entry_price = cfg.use_synthetic_quotes
                    ? (signal == 1 ? quote.ask : quote.bid)
                    : apply_slippage(execution_base, pos.side, false);
                pos.best_price = pos.entry_price;
                pos.breakeven_done = false;

                double stop_distance = 0.0;
                bool has_stop_distance = false;
                if (cfg.stop_loss_atr.has_value()) {
                    stop_distance = *cfg.stop_loss_atr * entry_atr;
                    has_stop_distance = true;
                } else if (cfg.stop_loss_ticks.has_value()) {
                    stop_distance = *cfg.stop_loss_ticks * tick_size;
                    has_stop_distance = true;
                }
                if (has_stop_distance) {
                    pos.has_stop = true;
                    pos.stop_price = barrier_price(pos.side, pos.entry_price, stop_distance, false);
                    pos.stop_source = 0;
                    pos.initial_risk = stop_distance;
                    pos.has_initial_risk = true;
                }

                double target_distance = 0.0;
                bool has_target_distance = false;
                if (cfg.take_profit_atr.has_value()) {
                    target_distance = *cfg.take_profit_atr * entry_atr;
                    has_target_distance = true;
                } else if (cfg.take_profit_ticks.has_value()) {
                    target_distance = *cfg.take_profit_ticks * tick_size;
                    has_target_distance = true;
                }
                if (has_target_distance) {
                    pos.has_target = true;
                    pos.target_price = barrier_price(pos.side, pos.entry_price, target_distance, true);
                }

                double trailing_distance = 0.0;
                bool has_trailing = false;
                if (cfg.trailing_stop_atr.has_value()) {
                    trailing_distance = *cfg.trailing_stop_atr * entry_atr;
                    has_trailing = true;
                } else if (cfg.trailing_stop_ticks.has_value()) {
                    trailing_distance = *cfg.trailing_stop_ticks * tick_size;
                    has_trailing = true;
                }
                pos.has_trailing = has_trailing;
                pos.trailing_distance = trailing_distance;
                pos.trailing_active = has_trailing && !cfg.trailing_activation_r.has_value();
            }
        }

        // Bracket and trailing exits can fire inside the same bar off its
        // high/low. A candle that tags both levels resolves to the stop, so
        // the sim stays honest instead of quietly cherry-picking the target.
        if(pos.open && (pos.has_stop || pos.has_target)){
            bool hit_stop = false;
            bool hit_target = false;

            if (pos.has_stop) {
                hit_stop = pos.side == 1 ? lows[i] <= pos.stop_price : highs[i] >= pos.stop_price;
            }
            if (pos.has_target) {
                hit_target = pos.side == 1 ? highs[i] >= pos.target_price : lows[i] <= pos.target_price;
            }

            if(hit_stop || hit_target){
                // Bracket fills keep bar-style slippage even in quote mode,
                // matching the Python oracle.
                const double raw_exit = hit_stop ? pos.stop_price : pos.target_price;
                const int reason = hit_stop ? stop_reason(pos.stop_source) : 2;
                close_position(i, apply_slippage(raw_exit, pos.side, true), reason);
                out.equity_curve.push_back(py_round2(balance));
                continue;   // no mark-to-market on the exit bar
            }
        }

        // Intraday flat: market-on-close at the last bar of the session.
        if(pos.open && cfg.exit_at_session_end && cfg.session_end != nullptr && cfg.session_end[i] != 0){
            double exit_price;
            if (cfg.use_synthetic_quotes) {
                const Quote close_quote = synthetic_quote(closes[i], highs[i], lows[i]);
                exit_price = flatten_price(pos.side, close_quote);
            } else {
                exit_price = apply_slippage(round_to_tick(closes[i]), pos.side, true);
            }
            close_position(i, exit_price, 6);
            out.equity_curve.push_back(py_round2(balance));
            continue;
        }

        // Time stop: close at the Nth bar's close, counting the entry bar.
        if(pos.open && cfg.time_stop_bars.has_value() &&
           (i - static_cast<std::size_t>(pos.entry_idx) + 1) >= static_cast<std::size_t>(*cfg.time_stop_bars)){
            double exit_price;
            if (cfg.use_synthetic_quotes) {
                const Quote close_quote = synthetic_quote(closes[i], highs[i], lows[i]);
                exit_price = flatten_price(pos.side, close_quote);
            } else {
                exit_price = apply_slippage(round_to_tick(closes[i]), pos.side, true);
            }
            close_position(i, exit_price, 5);
            out.equity_curve.push_back(py_round2(balance));
            continue;
        }

        // Update breakeven and trailing levels from this bar's favorable
        // extreme. They become active on the next bar, so the loop never
        // assumes an intrabar high/low ordering it cannot actually know.
        if(pos.open){
            double favorable;
            if (pos.side == 1) {
                pos.best_price = std::max(pos.best_price, highs[i]);
                favorable = pos.best_price - pos.entry_price;
            } else {
                pos.best_price = std::min(pos.best_price, lows[i]);
                favorable = pos.entry_price - pos.best_price;
            }

            if (cfg.breakeven_at_r.has_value() && pos.has_initial_risk &&
                pos.initial_risk > 0.0 && !pos.breakeven_done &&
                favorable >= *cfg.breakeven_at_r * pos.initial_risk) {
                const double candidate = round_to_tick(pos.entry_price);
                const bool better = !pos.has_stop ||
                    (pos.side == 1 ? candidate > pos.stop_price : candidate < pos.stop_price);
                if (better) {
                    pos.has_stop = true;
                    pos.stop_price = candidate;
                    pos.stop_source = 1;
                }
                pos.breakeven_done = true;
            }

            if (pos.has_trailing) {
                if (!pos.trailing_active && cfg.trailing_activation_r.has_value() &&
                    pos.has_initial_risk && pos.initial_risk > 0.0 &&
                    favorable >= *cfg.trailing_activation_r * pos.initial_risk) {
                    pos.trailing_active = true;
                }
                if (pos.trailing_active) {
                    const double candidate = round_to_tick(
                        pos.side == 1 ? pos.best_price - pos.trailing_distance
                                      : pos.best_price + pos.trailing_distance
                    );
                    const bool better = !pos.has_stop ||
                        (pos.side == 1 ? candidate > pos.stop_price : candidate < pos.stop_price);
                    if (better) {
                        pos.has_stop = true;
                        pos.stop_price = candidate;
                        pos.stop_source = 2;
                    }
                }
            }
        }

        //Mark-to-market current equity, includes unrealized pnl
        double unrealised = 0.0;
        if(pos.open){
            const double mark_price = round_to_tick(closes[i]);
            unrealised = position_pnl(pos.side, pos.entry_price, mark_price, cfg.commission);
        }
        out.equity_curve.push_back(py_round2(balance + unrealised));
    }

    // Force-close any open position at last bar
    if(pos.open){
        double exit_price;
        if (cfg.use_synthetic_quotes) {
            const Quote final_quote = synthetic_quote(closes[n - 1], highs[n - 1], lows[n - 1]);
            exit_price = flatten_price(pos.side, final_quote);
        } else {
            exit_price = apply_slippage(round_to_tick(closes[n - 1]), pos.side, true);
        }
        close_position(n - 1, exit_price, 7);
        // Update final equity value (now fully realized)
        out.equity_curve.back() = py_round2(balance);
    }

    return out;
}

//********************************************************
// Python conversion helpers (GIL required)
//********************************************************

static py::dict result_to_dict(const RunResult& result) {
    const std::size_t nt = result.trades.size();

    auto mk_int_arr = [&](auto getter) -> py::array_t<int> {
        auto arr = py::array_t<int>(nt);
        auto buf = arr.mutable_unchecked<1>();
        for(std::size_t k = 0; k < nt; ++k){
            buf(k) = getter(result.trades[k]);
        }
        return arr;
    };

    auto mk_double_arr = [&](auto getter) -> py::array_t<double> {
        auto arr = py::array_t<double>(nt);
        auto buf = arr.mutable_unchecked<1>();
        for(std::size_t k = 0; k < nt; ++k){
            buf(k) = getter(result.trades[k]);
        }
        return arr;
    };

    py::array_t<double> eq_curve(result.equity_curve.size());
    std::copy(result.equity_curve.begin(), result.equity_curve.end(),
              eq_curve.mutable_unchecked<1>().mutable_data(0));

    return py::dict(
        "equity_curve"_a  = eq_curve,
        "entry_indices"_a = mk_int_arr   ([](const TradeRecord& r){ return r.entry_idx;   }),
        "exit_indices"_a  = mk_int_arr   ([](const TradeRecord& r){ return r.exit_idx;    }),
        "sides"_a         = mk_int_arr   ([](const TradeRecord& r){ return r.side;        }),
        "entry_prices"_a  = mk_double_arr([](const TradeRecord& r){ return r.entry_price; }),
        "exit_prices"_a   = mk_double_arr([](const TradeRecord& r){ return r.exit_price;  }),
        "pnls"_a          = mk_double_arr([](const TradeRecord& r){ return r.pnl;         }),
        "exit_reasons"_a  = mk_int_arr   ([](const TradeRecord& r){ return r.exit_reason; })
    );
}

using DoubleArr = py::array_t<double, py::array::c_style | py::array::forcecast>;
using IntArr    = py::array_t<int,    py::array::c_style | py::array::forcecast>;

static void validate_inputs(
    const DoubleArr& opens, const DoubleArr& highs, const DoubleArr& lows,
    const DoubleArr& closes, double tick_size
) {
    const py::ssize_t n = closes.shape(0);
    if (opens.shape(0) != n || highs.shape(0) != n || lows.shape(0) != n)
        throw std::invalid_argument("opens, highs, lows, and closes must have the same length");
    if (n == 0)
        throw std::invalid_argument("Input arrays must not be empty");
    if (tick_size <= 0.0)
        throw std::invalid_argument("tick_size must be greater than zero");
}

//********************************************************
// Entry points
//********************************************************

py::dict run_backtest_kernel(
    DoubleArr opens_arr,
    DoubleArr highs_arr,
    DoubleArr lows_arr,
    DoubleArr closes_arr,
    IntArr    signals_arr,
    double initial_balance,
    double position_size,
    double commission,
    double tick_size,
    double tick_value,
    double slippage_ticks,
    std::optional<double> stop_loss_ticks,
    std::optional<double> take_profit_ticks,
    bool   use_synthetic_quotes,
    int    spread_ticks,
    int    volatile_bar_threshold_ticks,
    int    volatile_bar_extra_ticks,
    std::optional<double> stop_loss_atr,
    std::optional<double> take_profit_atr,
    std::optional<double> trailing_stop_atr,
    std::optional<double> trailing_stop_ticks,
    std::optional<double> trailing_activation_r,
    std::optional<double> breakeven_at_r,
    std::optional<int>    time_stop_bars,
    bool   exit_at_session_end,
    DoubleArr atr_arr,
    IntArr    session_end_arr
) {
    validate_inputs(opens_arr, highs_arr, lows_arr, closes_arr, tick_size);
    if (signals_arr.shape(0) != closes_arr.shape(0))
        throw std::invalid_argument("signals must match the price arrays in length");

    const std::size_t n = static_cast<std::size_t>(closes_arr.shape(0));
    const bool uses_atr = stop_loss_atr.has_value() || take_profit_atr.has_value() || trailing_stop_atr.has_value();
    if (uses_atr && static_cast<std::size_t>(atr_arr.shape(0)) != n)
        throw std::invalid_argument("atr must match the price arrays in length when ATR exits are enabled");
    if (exit_at_session_end && static_cast<std::size_t>(session_end_arr.shape(0)) != n)
        throw std::invalid_argument("session_end must match the price arrays in length when session exits are enabled");

    RunConfig cfg{};
    cfg.initial_balance = initial_balance;
    cfg.position_size = position_size;
    cfg.commission = commission;
    cfg.tick_size = tick_size;
    cfg.tick_value = tick_value;
    cfg.slippage_ticks = slippage_ticks;
    cfg.stop_loss_ticks = stop_loss_ticks;
    cfg.take_profit_ticks = take_profit_ticks;
    cfg.use_synthetic_quotes = use_synthetic_quotes;
    cfg.spread_ticks = spread_ticks;
    cfg.volatile_bar_threshold_ticks = volatile_bar_threshold_ticks;
    cfg.volatile_bar_extra_ticks = volatile_bar_extra_ticks;
    cfg.stop_loss_atr = stop_loss_atr;
    cfg.take_profit_atr = take_profit_atr;
    cfg.trailing_stop_atr = trailing_stop_atr;
    cfg.trailing_stop_ticks = trailing_stop_ticks;
    cfg.trailing_activation_r = trailing_activation_r;
    cfg.breakeven_at_r = breakeven_at_r;
    cfg.time_stop_bars = time_stop_bars;
    cfg.exit_at_session_end = exit_at_session_end;
    cfg.atr = uses_atr ? atr_arr.data(0) : nullptr;
    cfg.session_end = exit_at_session_end ? session_end_arr.data(0) : nullptr;

    const RunResult result = run_core(
        opens_arr.data(0), highs_arr.data(0), lows_arr.data(0),
        closes_arr.data(0), signals_arr.data(0),
        static_cast<std::size_t>(closes_arr.shape(0)), cfg
    );
    return result_to_dict(result);
}

py::list run_backtest_batch(
    DoubleArr opens_arr,
    DoubleArr highs_arr,
    DoubleArr lows_arr,
    DoubleArr closes_arr,
    py::list  signals_list,
    double initial_balance,
    double position_size,
    double commission,
    double tick_size,
    double tick_value,
    double slippage_ticks,
    std::optional<double> stop_loss_ticks,
    std::optional<double> take_profit_ticks,
    bool   use_synthetic_quotes,
    int    spread_ticks,
    int    volatile_bar_threshold_ticks,
    int    volatile_bar_extra_ticks,
    std::optional<double> stop_loss_atr,
    std::optional<double> take_profit_atr,
    std::optional<double> trailing_stop_atr,
    std::optional<double> trailing_stop_ticks,
    std::optional<double> trailing_activation_r,
    std::optional<double> breakeven_at_r,
    std::optional<int>    time_stop_bars,
    bool   exit_at_session_end,
    DoubleArr atr_arr,
    IntArr    session_end_arr,
    int    max_threads
) {
    validate_inputs(opens_arr, highs_arr, lows_arr, closes_arr, tick_size);

    const std::size_t n = static_cast<std::size_t>(closes_arr.shape(0));
    const bool uses_atr = stop_loss_atr.has_value() || take_profit_atr.has_value() || trailing_stop_atr.has_value();
    if (uses_atr && static_cast<std::size_t>(atr_arr.shape(0)) != n)
        throw std::invalid_argument("atr must match the price arrays in length when ATR exits are enabled");
    if (exit_at_session_end && static_cast<std::size_t>(session_end_arr.shape(0)) != n)
        throw std::invalid_argument("session_end must match the price arrays in length when session exits are enabled");

    const std::size_t n_runs = signals_list.size();
    if (n_runs == 0)
        return py::list();

    // Coerce every signal array up front (needs the GIL) and hold the
    // references so the buffers stay alive while worker threads read them.
    std::vector<IntArr>     signal_arrays;
    std::vector<const int*> signal_ptrs;
    signal_arrays.reserve(n_runs);
    signal_ptrs.reserve(n_runs);
    for (std::size_t i = 0; i < n_runs; ++i) {
        auto arr = IntArr::ensure(signals_list[i]);
        if (!arr || arr.ndim() != 1)
            throw std::invalid_argument("each signals entry must be a 1-D int array");
        if (static_cast<std::size_t>(arr.shape(0)) != n)
            throw std::invalid_argument("each signals entry must match the price arrays in length");
        signal_ptrs.push_back(arr.data(0));
        signal_arrays.push_back(std::move(arr));
    }

    RunConfig cfg{};
    cfg.initial_balance = initial_balance;
    cfg.position_size = position_size;
    cfg.commission = commission;
    cfg.tick_size = tick_size;
    cfg.tick_value = tick_value;
    cfg.slippage_ticks = slippage_ticks;
    cfg.stop_loss_ticks = stop_loss_ticks;
    cfg.take_profit_ticks = take_profit_ticks;
    cfg.use_synthetic_quotes = use_synthetic_quotes;
    cfg.spread_ticks = spread_ticks;
    cfg.volatile_bar_threshold_ticks = volatile_bar_threshold_ticks;
    cfg.volatile_bar_extra_ticks = volatile_bar_extra_ticks;
    cfg.stop_loss_atr = stop_loss_atr;
    cfg.take_profit_atr = take_profit_atr;
    cfg.trailing_stop_atr = trailing_stop_atr;
    cfg.trailing_stop_ticks = trailing_stop_ticks;
    cfg.trailing_activation_r = trailing_activation_r;
    cfg.breakeven_at_r = breakeven_at_r;
    cfg.time_stop_bars = time_stop_bars;
    cfg.exit_at_session_end = exit_at_session_end;
    cfg.atr = uses_atr ? atr_arr.data(0) : nullptr;
    cfg.session_end = exit_at_session_end ? session_end_arr.data(0) : nullptr;

    const double* opens  = opens_arr.data(0);
    const double* highs  = highs_arr.data(0);
    const double* lows   = lows_arr.data(0);
    const double* closes = closes_arr.data(0);

    std::vector<RunResult> results(n_runs);
    std::exception_ptr first_error = nullptr;
    std::mutex error_mutex;
    std::atomic<std::size_t> next_run{0};

    {
        // Everything inside this scope is pure C++ on shared read-only
        // arrays, so the GIL can go away and the pool actually uses cores.
        py::gil_scoped_release release;

        std::size_t hw = std::thread::hardware_concurrency();
        if (hw == 0) hw = 4;
        if (max_threads > 0) hw = std::min(hw, static_cast<std::size_t>(max_threads));
        const std::size_t n_threads = std::min(hw, n_runs);

        auto worker = [&]() {
            while (true) {
                const std::size_t i = next_run.fetch_add(1);
                if (i >= n_runs) break;
                try {
                    results[i] = run_core(opens, highs, lows, closes, signal_ptrs[i], n, cfg);
                } catch (...) {
                    std::lock_guard<std::mutex> guard(error_mutex);
                    if (!first_error) first_error = std::current_exception();
                }
            }
        };

        std::vector<std::thread> pool;
        pool.reserve(n_threads);
        for (std::size_t t = 0; t < n_threads; ++t)
            pool.emplace_back(worker);
        for (auto& th : pool)
            th.join();
    }

    if (first_error)
        std::rethrow_exception(first_error);

    py::list out;
    for (const auto& result : results)
        out.append(result_to_dict(result));
    return out;
}

//********************************************************
// Pybind11 module definition
//********************************************************

PYBIND11_MODULE(backtest_core, m) {
    m.doc() = "High-performance backtest kernel (C++17 + pybind11)";

    m.def(
        "run_backtest_kernel",
        &run_backtest_kernel,
        py::arg("opens"),
        py::arg("highs"),
        py::arg("lows"),
        py::arg("closes"),
        py::arg("signals"),
        py::arg("initial_balance") = 100'000.0,
        py::arg("position_size")   = 1.0,
        py::arg("commission")      = 5.0,
        py::arg("tick_size")       = 0.25,
        py::arg("tick_value")      = 12.50,
        py::arg("slippage_ticks")  = 1.0,
        py::arg("stop_loss_ticks")   = py::none(),
        py::arg("take_profit_ticks") = py::none(),
        py::arg("use_synthetic_quotes") = false,
        py::arg("spread_ticks") = 1,
        py::arg("volatile_bar_threshold_ticks") = 0,
        py::arg("volatile_bar_extra_ticks") = 0,
        py::arg("stop_loss_atr") = py::none(),
        py::arg("take_profit_atr") = py::none(),
        py::arg("trailing_stop_atr") = py::none(),
        py::arg("trailing_stop_ticks") = py::none(),
        py::arg("trailing_activation_r") = py::none(),
        py::arg("breakeven_at_r") = py::none(),
        py::arg("time_stop_bars") = py::none(),
        py::arg("exit_at_session_end") = false,
        py::arg("atr") = py::array_t<double>(0),
        py::arg("session_end") = py::array_t<int>(0),
        R"pbdoc(
        Fast next-bar futures backtest loop written in C++.

        Parameters
        ----------
        opens           : 1-D float64 array  — bar opening prices
        highs           : 1-D float64 array  — bar highs (brackets + quote volatility)
        lows            : 1-D float64 array  — bar lows
        closes          : 1-D float64 array  — bar closing prices
        signals         : 1-D int32  array   — +1 long, -1 short, 0 flat
        initial_balance : float              — starting cash
        position_size   : float              — contracts per trade
        commission      : float              — round-trip commission per trade
        tick_size       : float              — minimum price increment
        tick_value      : float              — dollar value of one tick
        slippage_ticks  : float              — adverse ticks per fill (bar mode + brackets)
        stop_loss_ticks   : float or None    — bracket stop distance in ticks
        take_profit_ticks : float or None    — bracket target distance in ticks
        use_synthetic_quotes : bool          — fill at synthetic bid/ask instead of bar open
        spread_ticks    : int                — base synthetic spread
        volatile_bar_threshold_ticks : int   — bar range that counts as volatile
        volatile_bar_extra_ticks     : int   — extra spread on volatile bars
        stop_loss_atr / take_profit_atr : float or None — bracket distance as ATR multiples
        trailing_stop_atr / trailing_stop_ticks : float or None — trail distance
        trailing_activation_r : float or None — defer trailing until +N R
        breakeven_at_r : float or None — move stop to entry at +N R
        time_stop_bars : int or None — exit at the close of the Nth bar in a trade
        exit_at_session_end : bool — flatten at the last bar of each session
        atr : 1-D float64 array — ATR aligned to bars; value at i-1 sizes entries
        session_end : 1-D int32 array — 1 marks the last bar of a session

        Returns
        -------
        dict with numpy arrays:
            equity_curve   — length = len(closes)
            entry_indices  — trade entry bar indices
            exit_indices   — trade exit bar indices
            sides          — +1 or -1
            entry_prices
            exit_prices
            pnls           — net profit/loss (after commission), rounded 2 decimals
            exit_reasons   — 0 flip, 1 stop, 2 target, 3 trailing, 4 breakeven,
                             5 time, 6 session, 7 end of data
        )pbdoc"
    );

    m.def(
        "run_backtest_batch",
        &run_backtest_batch,
        py::arg("opens"),
        py::arg("highs"),
        py::arg("lows"),
        py::arg("closes"),
        py::arg("signals_list"),
        py::arg("initial_balance") = 100'000.0,
        py::arg("position_size")   = 1.0,
        py::arg("commission")      = 5.0,
        py::arg("tick_size")       = 0.25,
        py::arg("tick_value")      = 12.50,
        py::arg("slippage_ticks")  = 1.0,
        py::arg("stop_loss_ticks")   = py::none(),
        py::arg("take_profit_ticks") = py::none(),
        py::arg("use_synthetic_quotes") = false,
        py::arg("spread_ticks") = 1,
        py::arg("volatile_bar_threshold_ticks") = 0,
        py::arg("volatile_bar_extra_ticks") = 0,
        py::arg("stop_loss_atr") = py::none(),
        py::arg("take_profit_atr") = py::none(),
        py::arg("trailing_stop_atr") = py::none(),
        py::arg("trailing_stop_ticks") = py::none(),
        py::arg("trailing_activation_r") = py::none(),
        py::arg("breakeven_at_r") = py::none(),
        py::arg("time_stop_bars") = py::none(),
        py::arg("exit_at_session_end") = false,
        py::arg("atr") = py::array_t<double>(0),
        py::arg("session_end") = py::array_t<int>(0),
        py::arg("max_threads") = 0,
        R"pbdoc(
        Run many signal variants over one shared OHLC series in parallel.

        Same semantics as run_backtest_kernel, but `signals_list` is a list of
        1-D int arrays and the runs fan out across a thread pool with the GIL
        released. All threads read the same price arrays — no copies — so a
        250-run parameter grid costs one dataset in memory, not 250.

        `max_threads` caps the pool (0 = use every hardware thread).

        Returns a list of per-run dicts, in input order, each shaped exactly
        like run_backtest_kernel's return value.
        )pbdoc"
    );
}
