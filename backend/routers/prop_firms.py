"""
/api/prop-firms  –  preset rule sets & custom rule validation.
"""
from fastapi import APIRouter, HTTPException
from schemas import PropFirmRules
from typing import Any

router = APIRouter()

def build_preset(
    *,
    name: str,
    account_size: int,
    daily_loss_limit: float | None,
    max_drawdown: float,
    profit_target: float,
    consistency_rule: bool,
    consistency_threshold: float | None,
    drawdown_type: str,
    min_trading_days: int | None,
    funded_account_label: str,
    funded_account_notes: list[str],
    match_names: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "name": name,
        "account_size": account_size,
        "daily_loss_limit": daily_loss_limit,
        "max_drawdown": max_drawdown,
        "profit_target": profit_target,
        "consistency_rule": consistency_rule,
        "consistency_threshold": consistency_threshold,
        "drawdown_type": drawdown_type,
        "min_trading_days": min_trading_days,
        "rules_scope": "evaluation",
        "funded_account_label": funded_account_label,
        "funded_account_notes": funded_account_notes,
        "match_names": match_names or [],
    }


# Presets are evaluation-stage only. Funded-stage payout/account behavior is kept
# as metadata here and modeled separately in the frontend payout estimator.
def make_topstep(account_size: int) -> dict[str, Any]:
    max_drawdown = {
        50_000: 0.04,
        100_000: 0.03,
        150_000: 0.03,
    }[account_size]
    return build_preset(
        name=f"TopStep {account_size:,}",
        account_size=account_size,
        daily_loss_limit=None,
        max_drawdown=max_drawdown,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="Express Funded payout path",
        funded_account_notes=[
            "The Trading Combine does not publish a separate minimum-day rule. The 50% consistency target is what keeps it from being a one-day pass.",
            "Express Funded accounts do not have a profit target.",
            "Current payout paths are 5 winning days of $150+ (Standard) or 3 trading days at 40% consistency (Consistency).",
        ],
    )


def make_mff_pro(account_size: int) -> dict[str, Any]:
    max_drawdown = {
        50_000: 0.04,
        100_000: 0.03,
        150_000: 0.03,
    }[account_size]
    return build_preset(
        name=f"My Funded Futures Pro {account_size:,}",
        account_size=account_size,
        daily_loss_limit=None,
        max_drawdown=max_drawdown,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=2,
        funded_account_label="Pro sim-funded payout path",
        funded_account_notes=[
            "Pro evaluations use the current standardized 6% target, 50% consistency, and 2 trading-day rule.",
            "The sim-funded Pro stage has no profit target and no consistency rule.",
            "Current payout eligibility is 14 calendar days from the first trade plus the plan buffer.",
        ],
        match_names=[f"My Funded Futures {account_size:,}"],
    )


def make_mff_rapid(account_size: int) -> dict[str, Any]:
    max_drawdown = {
        25_000: 0.04,
        50_000: 0.04,
        100_000: 0.03,
        150_000: 0.03,
    }[account_size]
    return build_preset(
        name=f"My Funded Futures Rapid {account_size:,}",
        account_size=account_size,
        daily_loss_limit=None,
        max_drawdown=max_drawdown,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=2,
        funded_account_label="Rapid sim-funded payout path",
        funded_account_notes=[
            "Rapid evaluations now use the same standardized 6% target, 50% consistency, and 2 trading-day rule set.",
            "The Rapid sim-funded stage has no profit target and no consistency rule.",
            "Current payout eligibility is 24 hours from the first trade plus the plan buffer.",
        ],
    )


def make_mff_flex(account_size: int) -> dict[str, Any]:
    max_drawdown = {
        25_000: 0.04,
        50_000: 0.04,
    }[account_size]
    return build_preset(
        name=f"My Funded Futures Flex {account_size:,}",
        account_size=account_size,
        daily_loss_limit=None,
        max_drawdown=max_drawdown,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=2,
        funded_account_label="Flex sim-funded payout path",
        funded_account_notes=[
            "Flex evaluations use the current challenge numbers only.",
            "The Flex sim-funded stage has no profit target and no consistency rule.",
            "Current payout eligibility is 5 winning days plus the plan net-profit floor.",
        ],
    )


LUCID_PRESETS = {
    "lucid_pro_25k": build_preset(
        name="Lucid Trading LucidPro 25,000",
        account_size=25_000,
        daily_loss_limit=None,
        max_drawdown=0.04,
        profit_target=0.05,
        consistency_rule=False,
        consistency_threshold=None,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidPro funded payout path",
        funded_account_notes=[
            "LucidPro evaluations can pass in one day and do not use consistency or minimum-day rules.",
            "Funded LucidPro payouts add a 40% consistency cap and a minimum profit goal for each payout cycle.",
            "LucidPro's DLL is a soft intraday lockout, not the evaluation pass/fail target itself.",
        ],
    ),
    "lucid_pro_50k": build_preset(
        name="Lucid Trading LucidPro 50,000",
        account_size=50_000,
        daily_loss_limit=0.024,
        max_drawdown=0.04,
        profit_target=0.06,
        consistency_rule=False,
        consistency_threshold=None,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidPro funded payout path",
        funded_account_notes=[
            "LucidPro evaluations can pass in one day and do not use consistency or minimum-day rules.",
            "Funded LucidPro payouts add a 40% consistency cap and a minimum profit goal for each payout cycle.",
            "LucidPro's DLL is a soft intraday lockout, not the evaluation pass/fail target itself.",
        ],
    ),
    "lucid_pro_100k": build_preset(
        name="Lucid Trading LucidPro 100,000",
        account_size=100_000,
        daily_loss_limit=0.018,
        max_drawdown=0.03,
        profit_target=0.06,
        consistency_rule=False,
        consistency_threshold=None,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidPro funded payout path",
        funded_account_notes=[
            "LucidPro evaluations can pass in one day and do not use consistency or minimum-day rules.",
            "Funded LucidPro payouts add a 40% consistency cap and a minimum profit goal for each payout cycle.",
            "LucidPro's DLL is a soft intraday lockout, not the evaluation pass/fail target itself.",
        ],
    ),
    "lucid_pro_150k": build_preset(
        name="Lucid Trading LucidPro 150,000",
        account_size=150_000,
        daily_loss_limit=0.018,
        max_drawdown=0.03,
        profit_target=0.06,
        consistency_rule=False,
        consistency_threshold=None,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidPro funded payout path",
        funded_account_notes=[
            "LucidPro evaluations can pass in one day and do not use consistency or minimum-day rules.",
            "Funded LucidPro payouts add a 40% consistency cap and a minimum profit goal for each payout cycle.",
            "LucidPro's DLL is a soft intraday lockout, not the evaluation pass/fail target itself.",
        ],
    ),
    "lucid_flex_25k": build_preset(
        name="Lucid Trading LucidFlex 25,000",
        account_size=25_000,
        daily_loss_limit=None,
        max_drawdown=0.04,
        profit_target=0.05,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidFlex funded payout path",
        funded_account_notes=[
            "LucidFlex evaluations use the profit target and 50% consistency only.",
            "The funded LucidFlex stage has no profit target and no consistency rule.",
            "Current payout eligibility is 5 profitable days in the payout cycle plus positive net profit.",
        ],
    ),
    "lucid_flex_50k": build_preset(
        name="Lucid Trading LucidFlex 50,000",
        account_size=50_000,
        daily_loss_limit=None,
        max_drawdown=0.04,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidFlex funded payout path",
        funded_account_notes=[
            "LucidFlex evaluations use the profit target and 50% consistency only.",
            "The funded LucidFlex stage has no profit target and no consistency rule.",
            "Current payout eligibility is 5 profitable days in the payout cycle plus positive net profit.",
        ],
    ),
    "lucid_flex_100k": build_preset(
        name="Lucid Trading LucidFlex 100,000",
        account_size=100_000,
        daily_loss_limit=None,
        max_drawdown=0.03,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidFlex funded payout path",
        funded_account_notes=[
            "LucidFlex evaluations use the profit target and 50% consistency only.",
            "The funded LucidFlex stage has no profit target and no consistency rule.",
            "Current payout eligibility is 5 profitable days in the payout cycle plus positive net profit.",
        ],
    ),
    "lucid_flex_150k": build_preset(
        name="Lucid Trading LucidFlex 150,000",
        account_size=150_000,
        daily_loss_limit=None,
        max_drawdown=0.03,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.50,
        drawdown_type="eod",
        min_trading_days=None,
        funded_account_label="LucidFlex funded payout path",
        funded_account_notes=[
            "LucidFlex evaluations use the profit target and 50% consistency only.",
            "The funded LucidFlex stage has no profit target and no consistency rule.",
            "Current payout eligibility is 5 profitable days in the payout cycle plus positive net profit.",
        ],
    ),
}

#Built in prop firm presets 
PRESETS: dict[str, dict] = {
    #TopStep
    "topstep_50k":    make_topstep(50_000),
    "topstep_100k":   make_topstep(100_000),
    "topstep_150k":   make_topstep(150_000),
    #MFF Pro
    "mff_50k":        make_mff_pro(50_000),
    "mff_100k":       make_mff_pro(100_000),
    "mff_150k":       make_mff_pro(150_000),
    #Rapid
    "mff_rapid_25k":  make_mff_rapid(25_000),
    "mff_rapid_50k":  make_mff_rapid(50_000),
    "mff_rapid_100k": make_mff_rapid(100_000),
    "mff_rapid_150k": make_mff_rapid(150_000),
    #Flex
    "mff_flex_25k":   make_mff_flex(25_000),
    "mff_flex_50k":   make_mff_flex(50_000),
    #Lucid (hardcoded per tier)
    **LUCID_PRESETS,
}

#Routes
@router.get("/")
async def list_presets():
    """Return all available preset names + their rules."""
    return [{"key": k, **v} for k, v in PRESETS.items()]

@router.get("/{preset_name}", response_model=PropFirmRules)
async def get_preset(preset_name: str):
    """Fetch a single preset by slug (e.g. topstep_50k, mff_rapid_100k)."""
    key = preset_name.lower().replace(" ", "").replace("-", "")
    match = None
    for k in PRESETS:
        if k.startswith(key) or key.startswith(k):
            match = k
            break
    if match is None:
        raise HTTPException(
            status_code=404,
            detail=f"Preset '{preset_name}' not found. Available: {list(PRESETS.keys())}",
        )
    return PRESETS[match]

@router.post("/validate", response_model=PropFirmRules)
async def validate_custom_rules(rules: PropFirmRules):
    """Validate that a custom rule set is internally consistent."""
    if (
        rules.daily_loss_limit is not None
        and rules.daily_loss_limit > rules.max_drawdown
    ):
        raise HTTPException(
            status_code=400,
            detail="daily_loss_limit cannot exceed max_drawdown.",
        )
    return rules
