import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from routers import data, prop_firms, backtests
from services.backtest_store import list_backtests

load_dotenv()
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "https://localhost:3000").split(",")

#Lifespan handler runs once on server startup and shutdown
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Initializing Trading Lab backend... ")
    yield
    print("Trading Lab backend powering off...")

app = FastAPI(
    title="Trading Lab API",
    description="Futures trading backtesting platform",
    version="0.1.0",
    lifespan=lifespan
)

#Enable CORS for frontend API access
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)
#Register API route groups
app.include_router(backtests.router, prefix="/api/backtests", tags=["Backtests"])
app.include_router(data.router, prefix="/api/data", tags=["Market Data"])
app.include_router(prop_firms.router, prefix="/api/prop-firms", tags=["Prop Firms"])

@app.get("/health") 
async def health():
    result = {"status": "ok", "backtests_in_memory": len(list_backtests())}
    # Show DB status; fails gracefully if not configured yet
    try:
        from services.db import health_check
        result.update(health_check())
    except Exception as exc:
        result["db_status"] = "unavailable"
        result["db_detail"] = str(exc)

    return result 
