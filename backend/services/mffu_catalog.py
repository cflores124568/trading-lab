"""Published MFFU evaluation terms, kept separate from executable presets.

Dollar amounts are reference data; listing a plan here does not implement its
trading rules or authorize its use in an actual account.
"""

EVALUATION_SOURCE = "https://help.myfundedfutures.com/en/articles/11802636-traders-evaluation-simplified"
STUDIO_SOURCE = "https://help.myfundedfutures.com/en/articles/17589665-studio-plans-a-comprehensive-guide"
ONE_DAY_SOURCE = "https://help.myfundedfutures.com/en/articles/12879226-pro-plan-1day-addon"
FLEX_SOURCE = "https://help.myfundedfutures.com/en/articles/13521620-flex-plan-the-path-forward-legacy"
FLEX_25_SOURCE = "https://help.myfundedfutures.com/en/articles/13536146-25k-flex-plan-legacy"


def _plan(key, name, balance, target, loss, daily_pause, minis, micros, consistency, days, floor, preset_key, source=EVALUATION_SOURCE):
    return {
        "key": key, "name": name, "account_size": balance,
        "profit_target": target, "max_loss": loss, "daily_soft_pause": daily_pause,
        "max_mini_contracts": minis, "max_micro_contracts": micros,
        "consistency_threshold": consistency, "min_trading_days": days,
        "drawdown": floor, "preset_key": preset_key, "source_url": source,
        "simulation_status": "approximate" if preset_key else "reference_only",
    }


MFFU_EVALUATION_CATALOG = [
    _plan("builder_25k", "Builder 25k", 25_000, 1_500, 1_000, 600, 2, 20, None, 1, "eod_trailing", "mff_builder_25k"),
    _plan("builder_50k", "Builder 50k", 50_000, 3_000, 2_000, 1_000, 4, 40, None, 1, "eod_trailing", "mff_builder_50k"),
    _plan("builder_50k_addon", "Builder 50k Add-on", 50_000, 3_000, 1_500, 1_000, 4, 40, None, 1, "eod_trailing", "mff_builder_50k_addon"),
    _plan("builder_100k", "Builder 100k", 100_000, 6_000, 3_000, 1_750, 6, 60, None, 1, "eod_trailing", "mff_builder_100k"),
    _plan("builder_150k", "Builder 150k", 150_000, 9_000, 4_500, 2_500, 9, 90, None, 1, "eod_trailing", "mff_builder_150k"),
    _plan("rapid_25k", "Rapid 25k", 25_000, 1_500, 1_000, None, 3, 30, .50, 2, "eod_trailing", "mff_rapid_25k"),
    _plan("rapid_50k", "Rapid 50k", 50_000, 3_000, 2_000, None, 5, 50, .50, 2, "eod_trailing", "mff_rapid_50k"),
    _plan("rapid_100k", "Rapid 100k", 100_000, 6_000, 3_000, None, 8, 80, .50, 2, "eod_trailing", "mff_rapid_100k"),
    _plan("rapid_150k", "Rapid 150k", 150_000, 9_000, 4_500, None, 10, 100, .50, 2, "eod_trailing", "mff_rapid_150k"),
    _plan("rapid_eod_25k", "Rapid EOD 25k", 25_000, 1_500, 1_000, None, 2, 20, .30, 4, "eod_trailing", "mff_rapid_eod_25k"),
    _plan("rapid_eod_50k", "Rapid EOD 50k", 50_000, 3_000, 2_000, None, 3, 30, .30, 4, "eod_trailing", "mff_rapid_eod_50k"),
    _plan("pro_50k", "Pro 50k", 50_000, 3_000, 2_000, None, 3, 30, .50, 2, "eod_trailing", "mff_50k"),
    _plan("pro_100k", "Pro 100k", 100_000, 6_000, 3_000, None, 6, 60, .50, 2, "eod_trailing", "mff_100k"),
    _plan("pro_150k", "Pro 150k", 150_000, 9_000, 4_500, None, 9, 90, .50, 2, "eod_trailing", "mff_150k"),
    _plan("pro_one_day_50k", "Pro One-Day 50k", 50_000, 4_000, 2_000, None, 3, 30, None, 1, "eod_trailing", "mff_pro_one_day_50k", ONE_DAY_SOURCE),
    _plan("studio_001", "Studio #001 10k", 10_000, 1_000, 500, None, 0, 10, None, None, "static", "mff_studio_001", STUDIO_SOURCE),
    _plan("studio_002", "Studio #002 20k", 20_000, 2_000, 1_000, None, 0, 20, None, None, "static", "mff_studio_002", STUDIO_SOURCE),
    _plan("studio_003", "Studio #003 5k", 5_000, 500, 250, None, 0, 5, None, None, "static", "mff_studio_003", STUDIO_SOURCE),
    _plan("flex_25k_legacy", "Flex 25k (legacy)", 25_000, 1_500, 1_000, None, 3, 30, .50, 2, "eod_trailing", "mff_flex_25k", FLEX_25_SOURCE),
    _plan("flex_50k_legacy", "Flex 50k (legacy)", 50_000, 3_000, 2_000, None, 5, 50, .50, 2, "eod_trailing", "mff_flex_50k", FLEX_SOURCE),
]
