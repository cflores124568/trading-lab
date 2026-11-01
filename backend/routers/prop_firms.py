"""
/api/prop-firms  –  preset rule sets & custom rule validation.
"""
from fastapi import APIRouter, HTTPException
from schemas import PropFirmRules
from services.mffu_catalog import MFFU_EVALUATION_CATALOG
from pydantic import BaseModel
from typing import Any, Literal

router = APIRouter()


class MffuEvaluationPlan(BaseModel):
    key: str
    name: str
    account_size: int
    profit_target: int
    max_loss: int
    daily_soft_pause: int | None
    max_mini_contracts: int
    max_micro_contracts: int
    consistency_threshold: float | None
    min_trading_days: int | None
    drawdown: Literal["static", "eod_trailing"]
    preset_key: str | None
    simulation_status: Literal["reference_only", "approximate"]
    source_url: str


class MffuEvaluationCatalog(BaseModel):
    reviewed_on: str
    stage: Literal["evaluation"]
    plans: list[MffuEvaluationPlan]

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
    evaluation_model: str = "legacy",
    daily_loss_mode: str = "breach",
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
        "evaluation_model": evaluation_model,
        "daily_loss_mode": daily_loss_mode,
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
        evaluation_model="mffu_eod",
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
        evaluation_model="mffu_eod",
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


def make_mff_rapid_eod(account_size: int) -> dict[str, Any]:
    return build_preset(
        name=f"My Funded Futures Rapid EOD {account_size:,}",
        evaluation_model="mffu_eod",
        account_size=account_size,
        daily_loss_limit=None,
        max_drawdown=0.04,
        profit_target=0.06,
        consistency_rule=True,
        consistency_threshold=0.30,
        drawdown_type="eod",
        min_trading_days=4,
        funded_account_label="Rapid EOD sim-funded payout path",
        funded_account_notes=[
            "Rapid EOD evaluations require 30% consistency and at least 4 trading days.",
            "Sim-funded account rules and payout eligibility are separate from the evaluation.",
        ],
    )


def make_mff_pro_one_day() -> dict[str, Any]:
    return build_preset(
        name="My Funded Futures Pro One-Day 50,000",
        evaluation_model="mffu_eod",
        account_size=50_000,
        daily_loss_limit=None,
        max_drawdown=0.04,
        profit_target=0.08,
        consistency_rule=False,
        consistency_threshold=None,
        drawdown_type="eod",
        min_trading_days=1,
        funded_account_label="Pro sim-funded payout path",
        funded_account_notes=[
            "The Pro One-Day add-on has a $4,000 evaluation target and no evaluation consistency rule.",
            "Sim-funded account rules and payout eligibility are separate from the evaluation.",
        ],
    )


def make_mff_builder(account_size: int, *, addon: bool = False) -> dict[str, Any]:
    max_loss = 1_500 if addon else {25_000: 1_000, 50_000: 2_000, 100_000: 3_000, 150_000: 4_500}[account_size]
    daily_loss = {25_000: 600, 50_000: 1_000, 100_000: 1_750, 150_000: 2_500}[account_size]
    return build_preset(
        name=f"My Funded Futures Builder{' Add-on' if addon else ''} {account_size:,}",
        account_size=account_size, daily_loss_limit=daily_loss / account_size,
        max_drawdown=max_loss / account_size, profit_target=0.06,
        consistency_rule=False, consistency_threshold=None, drawdown_type="eod",
        min_trading_days=1, evaluation_model="mffu_eod", daily_loss_mode="soft_pause",
        funded_account_label="Builder sim-funded payout path",
        funded_account_notes=["The daily loss limit is a soft pause rather than an account breach.",
                              "Sim-funded payout rules are separate from evaluation rules."],
    )


def make_mff_studio(number: str, account_size: int) -> dict[str, Any]:
    return build_preset(
        name=f"My Funded Futures Studio #{number} {account_size:,}",
        evaluation_model="mffu_static",
        account_size=account_size, daily_loss_limit=None, max_drawdown=0.05,
        profit_target=0.10, consistency_rule=False, consistency_threshold=None,
        drawdown_type="eod", min_trading_days=None,
        funded_account_label="Studio sim-funded payout path",
        funded_account_notes=[
            "Studio uses a static maximum loss limit and allows micro contracts only; the contract limit is not enforced here.",
            "Sim-funded payout requirements and daily profit caps are separate from the evaluation.",
        ],
    )


def make_mff_flex(account_size: int) -> dict[str, Any]:
    max_drawdown = {
        25_000: 0.04,
        50_000: 0.04,
    }[account_size]
    return build_preset(
        name=f"My Funded Futures Flex {account_size:,}",
        evaluation_model="mffu_eod",
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
            "Flex is a legacy plan; verify your account's original terms and size.",
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
    "mff_pro_one_day_50k": make_mff_pro_one_day(),
    "mff_builder_25k": make_mff_builder(25_000),
    "mff_builder_50k": make_mff_builder(50_000),
    "mff_builder_50k_addon": make_mff_builder(50_000, addon=True),
    "mff_builder_100k": make_mff_builder(100_000),
    "mff_builder_150k": make_mff_builder(150_000),
    #Rapid
    "mff_rapid_25k":  make_mff_rapid(25_000),
    "mff_rapid_50k":  make_mff_rapid(50_000),
    "mff_rapid_100k": make_mff_rapid(100_000),
    "mff_rapid_150k": make_mff_rapid(150_000),
    "mff_rapid_eod_25k": make_mff_rapid_eod(25_000),
    "mff_rapid_eod_50k": make_mff_rapid_eod(50_000),
    "mff_studio_001": make_mff_studio("001", 10_000),
    "mff_studio_002": make_mff_studio("002", 20_000),
    "mff_studio_003": make_mff_studio("003", 5_000),
    #Flex
    "mff_flex_25k":   make_mff_flex(25_000),
    "mff_flex_50k":   make_mff_flex(50_000),
    #Lucid (hardcoded per tier)
    **LUCID_PRESETS,
}

# Contract ceilings belong to the evaluation snapshot, not the current
# catalog lookup at execution time; saved runs retain their original terms.
for _plan in MFFU_EVALUATION_CATALOG:
    if _plan["preset_key"] in PRESETS:
        PRESETS[_plan["preset_key"]]["max_mini_contracts"] = _plan["max_mini_contracts"]
        PRESETS[_plan["preset_key"]]["max_micro_contracts"] = _plan["max_micro_contracts"]

#Routes
@router.get("/")
async def list_presets():
    """Return all available preset names + their rules."""
    return [{"key": k, **v} for k, v in PRESETS.items()]

@router.get("/mffu-catalog", response_model=MffuEvaluationCatalog)
async def get_mffu_catalog():
    """Reference terms, including plans the current simulator cannot run."""
    return {"reviewed_on": "2026-11-01", "stage": "evaluation", "plans": MFFU_EVALUATION_CATALOG}

@router.get("/{preset_name}", response_model=PropFirmRules)
async def get_preset(preset_name: str):
    """Fetch a single preset by slug (e.g. topstep_50k, mff_rapid_100k)."""
    key = preset_name.lower().replace(" ", "").replace("-", "")
    match = key if key in PRESETS else None
    if match is None:
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
