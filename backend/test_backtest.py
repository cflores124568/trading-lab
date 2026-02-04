#!/usr/bin/env python3
#Quick test for the  backtesting pipeline 

import sys, os
sys.path.insert(0, os.path.dirname(__file__))       

from services.data_loader      import generate_sample_data, get_dataset
from services.indicators       import add_all_indicators
from services.strategy         import generate_signals
from services.backtest_engine  import run_backtest
from services.metrics          import calculate_metrics
from services.prop_firm_eval   import evaluate_prop_firm


def main():
    print("=" * 60)
    print(" Trading Lab – Backtest Pipeline Smoke Test")
    print("=" * 60)

    #1. Generate sample data
    print("\n[1/6] Generating sample OHLCV data …")
    info = generate_sample_data(name="ES_test", bars=2000, seed=42)
    print(f"      Dataset: {info['name']}  |  {info['rows']} bars  "
          f"|  {info['start_date']} → {info['end_date']}")

    dataset = get_dataset(info["dataset_id"])
    df = dataset["df"].copy()

    #2. Attach indicators
    strategy_params = {"fast_period": 9, "slow_period": 21}
    print("\n[2/6] Attaching indicators (SMA 9/21, RSI 14, BB 20/2) …")
    df = add_all_indicators(df, strategy_params)
    print(f"      Columns: {list(df.columns)}")

    #3. Generate signals 
    print("\n[3/6] Generating MA-crossover signals …")
    df = generate_signals(df, "ma_crossover", strategy_params)
    buy_count  = (df["signal"] == 1).sum()
    sell_count = (df["signal"] == -1).sum()
    print(f"      Buy signals: {buy_count}  |  Sell signals: {sell_count}")

    # 4. Run backtest engine
    print("\n[4/6] Running bar-by-bar backtest engine …")
    initial_balance = 100_000.0
    result = run_backtest(
        df,
        initial_balance=initial_balance,
        position_size=1.0,
        commission=5.0,
    )
    trades       = result["trades"]
    equity_curve = result["equity_curve"]
    print(f"      Trades executed: {len(trades)}")
    print(f"      Final equity:    ${equity_curve[-1]:,.2f}")

    #5. Calculate metrics 
    print("\n[5/6] Calculating performance metrics …")
    metrics = calculate_metrics(trades, equity_curve, initial_balance)
    print(f"      Win Rate        : {metrics['win_rate']*100:.1f} %")
    print(f"      Total PnL       : ${metrics['total_pnl']:>10,.2f}")
    print(f"      Profit Factor   : {metrics['profit_factor']}")
    print(f"      Sharpe Ratio    : {metrics['sharpe_ratio']}")
    print(f"      Sortino Ratio   : {metrics['sortino_ratio']}")
    print(f"      Max Drawdown    : {metrics['max_drawdown']*100:.2f} %")
    print(f"      Best / Worst    : ${metrics['best_trade']:,.2f} / ${metrics['worst_trade']:,.2f}")
    print(f"      Avg Duration    : {metrics['avg_trade_duration']:.1f} min")

    # 6. Prop-firm evaluation (FTMO preset) 
    print("\n[6/6] Evaluating against FTMO prop-firm rules …")
    ftmo_rules = {
        "name":                  "FTMO",
        "account_size":          100_000,
        "daily_loss_limit":      0.05,
        "max_drawdown":          0.10,
        "profit_target":         0.10,
        "consistency_rule":      True,
        "consistency_threshold": 0.30,
    }
    eval_result = evaluate_prop_firm(
        rules=ftmo_rules,
        trades=trades,
        equity_curve=equity_curve,
        initial_balance=initial_balance,
    )
    print(f"      Overall PASSED  : {'✅ YES' if eval_result['passed'] else '❌ NO'}")
    print(f"      Daily Loss OK   : {'✅' if not eval_result['daily_loss_breached'] else '❌'}")
    print(f"      Drawdown OK     : {'✅' if not eval_result['drawdown_breached'] else '❌'}")
    print(f"      Profit Target   : {'✅' if eval_result['profit_target_hit'] else '❌'}")
    print(f"      Consistency OK  : {'✅' if eval_result['consistency_passed'] else '❌'}")

    # sample trades 
    print("\n── First 5 trades ────────────────────────────────────────")
    for t in trades[:5]:
        print(f"  #{t['trade_id']:>3}  {t['side']:>4}  "
              f"entry={t['entry_price']:.2f}  exit={t['exit_price']:.2f}  "
              f"PnL=${t['pnl']:>8,.2f}")

    print("\n" + "=" * 60)
    print(" Smoke test complete ✅")
    print("=" * 60)


if __name__ == "__main__":
    main()