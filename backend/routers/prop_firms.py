"""
/api/prop-firms  –  preset rule sets & custom rule validation.
"""
from fastapi import APIRouter, HTTPException
from schemas import PropFirmRules

router = APIRouter()

#Preset builder helpers 
def make_topstep(account_size: int) -> dict:
    return {
        "name":                  f"TopStep {account_size:,}",
        "account_size":          account_size,
        "daily_loss_limit":      0.05,
        "max_drawdown":          0.08,
        "profit_target":         0.08,
        "consistency_rule":      True,
        "consistency_threshold": 0.35,
        "drawdown_type":         "intraday",
        "min_trading_days":      30,
    }

def make_mff(account_size: int) -> dict:
    return {
        "name":                  f"My Funded Futures {account_size:,}",
        "account_size":          account_size,
        "daily_loss_limit":      0.04,
        "max_drawdown":          0.08,
        "profit_target":         0.08,
        "consistency_rule":      False,
        "consistency_threshold": None,
        "drawdown_type":         "intraday",
        "min_trading_days":      15,
    }

def make_mff_rapid(account_size: int) -> dict:
    return {
        "name":                  f"My Funded Futures Rapid {account_size:,}",
        "account_size":          account_size,
        "daily_loss_limit":      0.04,
        "max_drawdown":          0.08,
        "profit_target":         0.08,
        "consistency_rule":      False,
        "consistency_threshold": None,
        "drawdown_type":         "eod",
        "min_trading_days":      15,
    }

def make_mff_flex(account_size: int) -> dict:
    return {
        "name":                  f"My Funded Futures Flex {account_size:,}",
        "account_size":          account_size,
        "daily_loss_limit":      0.04,
        "max_drawdown":          0.08,
        "profit_target":         0.08,
        "consistency_rule":      False,
        "consistency_threshold": None,
        "drawdown_type":         "intraday",
        "min_trading_days":      15,
    }

# Lucid is hardcoded per tier since their rules are in fixed dollar amounts, not percentages so the percentages differ between account sizes
LUCID_PRESETS = {
    "lucid_pro_50k": {
        "name":                  "Lucid Trading LucidPro 50,000",
        "account_size":          50_000,
        "daily_loss_limit":      0.024,
        "max_drawdown":          0.04,
        "profit_target":         0.06,
        "consistency_rule":      True,
        "consistency_threshold": 0.40,
        "drawdown_type":         "eod",
        "min_trading_days":      5,
    },
    "lucid_pro_100k": {
        "name":                  "Lucid Trading LucidPro 100,000",
        "account_size":          100_000,
        "daily_loss_limit":      0.02,
        "max_drawdown":          0.03,
        "profit_target":         0.05,
        "consistency_rule":      True,
        "consistency_threshold": 0.40,
        "drawdown_type":         "eod",
        "min_trading_days":      5,
    },
    "lucid_pro_150k": {
        "name":                  "Lucid Trading LucidPro 150,000",
        "account_size":          150_000,
        "daily_loss_limit":      0.02,
        "max_drawdown":          0.03,
        "profit_target":         0.05,
        "consistency_rule":      True,
        "consistency_threshold": 0.40,
        "drawdown_type":         "eod",
        "min_trading_days":      5,
    },
    "lucid_flex_50k": {
        "name":                  "Lucid Trading LucidFlex 50,000",
        "account_size":          50_000,
        "daily_loss_limit":      None,
        "max_drawdown":          0.04,
        "profit_target":         0.06,
        "consistency_rule":      True,
        "consistency_threshold": 0.50,
        "drawdown_type":         "eod",
        "min_trading_days":      2,
    },
    "lucid_flex_100k": {
        "name":                  "Lucid Trading LucidFlex 100,000",
        "account_size":          100_000,
        "daily_loss_limit":      None,
        "max_drawdown":          0.03,
        "profit_target":         0.05,
        "consistency_rule":      True,
        "consistency_threshold": 0.50,
        "drawdown_type":         "eod",
        "min_trading_days":      2,
    },
    "lucid_flex_150k": {
        "name":                  "Lucid Trading LucidFlex 150,000",
        "account_size":          150_000,
        "daily_loss_limit":      None,
        "max_drawdown":          0.03,
        "profit_target":         0.05,
        "consistency_rule":      True,
        "consistency_threshold": 0.50,
        "drawdown_type":         "eod",
        "min_trading_days":      2,
    },
}

#Built in prop firm presets 
PRESETS: dict[str, dict] = {
    #TopStep
    "topstep_50k":    make_topstep(50_000),
    "topstep_100k":   make_topstep(100_000),
    "topstep_150k":   make_topstep(150_000),
    #MFF
    "mff_50k":        make_mff(50_000),
    "mff_100k":       make_mff(100_000),
    "mff_150k":       make_mff(150_000),
    #Rapid
    "mff_rapid_50k":  make_mff_rapid(50_000),
    "mff_rapid_100k": make_mff_rapid(100_000),
    "mff_rapid_150k": make_mff_rapid(150_000),
    #Flex
    "mff_flex_50k":   make_mff_flex(50_000),
    "mff_flex_100k":  make_mff_flex(100_000),
    "mff_flex_150k":  make_mff_flex(150_000),
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
