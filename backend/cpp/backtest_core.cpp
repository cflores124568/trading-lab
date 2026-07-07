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
};

struct Position {
    bool   open        = false;
    int    side        = 0;
    int    entry_idx   = -1;
    double entry_price = 0.0;
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
    const bool uses_brackets = cfg.stop_loss_ticks.has_value() || cfg.take_profit_ticks.has_value();

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

    RunResult out;
    out.equity_curve.reserve(n + 1);
    out.trades.reserve(n / 4);        // rough guess — prevents many resizes

    double   balance = cfg.initial_balance;
    Position pos{};

    out.equity_curve.push_back(balance);  // starting equity (bar 0)

    auto close_position = [&](std::size_t exit_idx, double exit_price) {
        const double net_pnl = position_pnl(pos.side, pos.entry_price, exit_price, cfg.commission);
        balance += net_pnl;
        out.trades.push_back({
            pos.entry_idx,
            static_cast<int>(exit_idx),
            pos.side,
            pos.entry_price,
            exit_price,
            py_round2(net_pnl)
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
                close_position(i, exit_price);
            }
        }

        //Open new position when flat and we have a signal
        if(!pos.open && signal != 0 && i < n - 1){
            pos.open = true;
            pos.side = signal;           // +1 or -1
            pos.entry_idx = static_cast<int>(i);
            pos.entry_price = cfg.use_synthetic_quotes
                ? (signal == 1 ? quote.ask : quote.bid)
                : apply_slippage(execution_base, pos.side, false);
        }

        // Bracket exits can fire inside the same bar off its high/low.
        // A candle that tags both levels resolves to the stop, so the sim
        // stays honest instead of quietly cherry-picking the target.
        if(pos.open && uses_brackets){
            double stop_price   = 0.0;
            double target_price = 0.0;
            bool   hit_stop     = false;
            bool   hit_target   = false;

            if(cfg.stop_loss_ticks.has_value()){
                const double offset = *cfg.stop_loss_ticks * tick_size;
                stop_price = round_to_tick(pos.side == 1 ? pos.entry_price - offset
                                                         : pos.entry_price + offset);
                hit_stop = pos.side == 1 ? lows[i] <= stop_price : highs[i] >= stop_price;
            }
            if(cfg.take_profit_ticks.has_value()){
                const double offset = *cfg.take_profit_ticks * tick_size;
                target_price = round_to_tick(pos.side == 1 ? pos.entry_price + offset
                                                           : pos.entry_price - offset);
                hit_target = pos.side == 1 ? highs[i] >= target_price : lows[i] <= target_price;
            }

            if(hit_stop || hit_target){
                // Bracket fills keep bar-style slippage even in quote mode,
                // matching the Python oracle.
                const double raw_exit = hit_stop ? stop_price : target_price;
                close_position(i, apply_slippage(raw_exit, pos.side, true));
                out.equity_curve.push_back(py_round2(balance));
                continue;   // no mark-to-market on the exit bar
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
        close_position(n - 1, exit_price);
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
        "pnls"_a          = mk_double_arr([](const TradeRecord& r){ return r.pnl;         })
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
    int    volatile_bar_extra_ticks
) {
    validate_inputs(opens_arr, highs_arr, lows_arr, closes_arr, tick_size);
    if (signals_arr.shape(0) != closes_arr.shape(0))
        throw std::invalid_argument("signals must match the price arrays in length");

    const RunConfig cfg{
        initial_balance, position_size, commission, tick_size, tick_value,
        slippage_ticks, stop_loss_ticks, take_profit_ticks,
        use_synthetic_quotes, spread_ticks,
        volatile_bar_threshold_ticks, volatile_bar_extra_ticks
    };

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
    int    max_threads
) {
    validate_inputs(opens_arr, highs_arr, lows_arr, closes_arr, tick_size);

    const std::size_t n = static_cast<std::size_t>(closes_arr.shape(0));
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

    const RunConfig cfg{
        initial_balance, position_size, commission, tick_size, tick_value,
        slippage_ticks, stop_loss_ticks, take_profit_ticks,
        use_synthetic_quotes, spread_ticks,
        volatile_bar_threshold_ticks, volatile_bar_extra_ticks
    };

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
