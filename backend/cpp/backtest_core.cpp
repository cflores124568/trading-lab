/**
 * FileName:    backtest_core.cpp
 * Description: High-performance C++ backtest kernel exposed to Python via pybind11.
 *              Handles only the numeric hot-loop — no DataFrame/timestamp logic.
 *
 *              Main entry: run_backtest_kernel(closes, signals, ...)
 *              Returns equity curve + flat trade records as numpy arrays.
 *
 */

#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>

#include <cmath>
#include <stdexcept>
#include <vector>

namespace py = pybind11;

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

//********************************************************
// Core backtest kernel
//********************************************************

py::dict run_backtest_kernel(
    py::array_t<double> closes_arr,
    py::array_t<int>    signals_arr,
    double initial_balance,
    double position_size,
    double commission,
    double tick_value
) {
    // Input array views & basic validation
    auto closes  = closes_arr .unchecked<1>();
    auto signals = signals_arr.unchecked<1>();

    const py::ssize_t n = closes.shape(0);
    if (signals.shape(0) != n)
        throw std::invalid_argument("closes and signals must have the same length");
    if (n == 0)
        throw std::invalid_argument("Input arrays must not be empty");

    // Output containers (pre-reserve to reduce reallocations)
    std::vector<double> equity_curve;
    equity_curve.reserve(n + 1);

    std::vector<TradeRecord> records;
    records.reserve(n / 4);           // rough guess — prevents many resizes

    // Trading state
    double   balance = initial_balance;
    Position pos{};

    equity_curve.push_back(balance);  // starting equity (bar 0)

    // Main bar-by-bar loop
    for(py::ssize_t i = 0; i < n; ++i){
        const double close  = closes[i];
        const int    signal = signals[i];

        // Close existing position on signal flip
        if(pos.open){
            const bool should_close = (pos.side == 1 && signal == -1) || (pos.side ==-1 && signal ==  1);
            if(should_close){
                const double direction = static_cast<double>(pos.side);
                const double raw_pnl = direction * (close - pos.entry_price) * position_size * tick_value;
                const double net_pnl = raw_pnl - commission;
                balance += net_pnl;

                records.push_back({
                    pos.entry_idx,
                    static_cast<int>(i),
                    pos.side,
                    pos.entry_price,
                    close,
                    std::round(net_pnl * 100.0) * 0.01
                });
                pos = {};   // reset position
            }
        }

        //Open new position when flat and we have a signal
        if(!pos.open && signal != 0){
            pos.open = true;
            pos.side = signal;           // +1 or -1
            pos.entry_idx = static_cast<int>(i);
            pos.entry_price = close;
            balance -= commission;  //Commisions are inevitable... make sure to use Minis when using +10 micros xD
        }
        //Mark-to-market current equity, includes unrealized pnl
        double unrealised = 0.0;
        if(pos.open){
            unrealised = static_cast<double>(pos.side) * (close - pos.entry_price) * position_size * tick_value;
        }
        equity_curve.push_back(std::round((balance + unrealised) * 100.0) / 100.0);
    }

    // Force-close any open position at last bar
    if(pos.open){
        const double close = closes[n - 1];
        const double direction = static_cast<double>(pos.side);
        const double raw_pnl = direction * (close - pos.entry_price) * position_size * tick_value;
        const double net_pnl = raw_pnl - commission;
        balance += net_pnl;
        records.push_back({
            pos.entry_idx,
            static_cast<int>(n - 1),
            pos.side,
            pos.entry_price,
            close,
            std::round(net_pnl * 100.0) * 0.01
        });
        // Update final equity value (now fully realized)
        equity_curve.back() = std::round(balance * 100.0) / 100.0;
    }
    // Convert results to numpy arrays, ensuring zero-copy where possible
    const std::size_t nt = records.size();

    auto mk_int_arr = [&](auto getter) -> py::array_t<int> {
        auto arr = py::array_t<int>(nt);
        auto buf = arr.mutable_unchecked<1>();
        for(std::size_t k = 0; k < nt; ++k){
            buf(k) = getter(records[k]);
        }
        return arr;
    };

    auto mk_double_arr = [&](auto getter) -> py::array_t<double> {
        auto arr = py::array_t<double>(nt);
        auto buf = arr.mutable_unchecked<1>();
        for(std::size_t k = 0; k < nt; ++k){
            buf(k) = getter(records[k]);
        }
        return arr;
    };

    py::array_t<double> eq_curve(equity_curve.size());
    std::copy(equity_curve.begin(), equity_curve.end(), eq_curve.mutable_unchecked<1>().mutable_data(0));

    //Return dictionary to Python
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

//********************************************************
// Pybind11 module definition
//********************************************************

PYBIND11_MODULE(backtest_core, m) {
    m.doc() = "High-performance backtest kernel (C++17 + pybind11)";

    m.def(
        "run_backtest_kernel",
        &run_backtest_kernel,
        py::arg("closes"),
        py::arg("signals"),
        py::arg("initial_balance") = 100'000.0,
        py::arg("position_size")   = 1.0,
        py::arg("commission")      = 5.0,
        py::arg("tick_value")      = 12.50,
        R"pbdoc(
        Fast bar-by-bar backtest loop written in C++.

        Parameters
        ----------
        closes          : 1-D float64 array  — bar closing prices
        signals         : 1-D int32  array   — +1 = buy/long, -1 = sell/short, 0 = flat
        initial_balance : float              — starting cash
        position_size   : float              — contracts / shares per trade
        commission      : float              — round-trip commission per trade
        tick_value      : float              — dollar value of one point / tick

        Returns
        -------
        dict with numpy arrays:
            equity_curve   — length = len(closes) + 1
            entry_indices  — trade entry bar indices
            exit_indices   — trade exit bar indices
            sides          — +1 or -1
            entry_prices
            exit_prices
            pnls           — net profit/loss (after commission), rounded 2 decimals
        )pbdoc"
    );
}