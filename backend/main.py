from fastapi import FastAPI
from routers import data, prop_firms

app = FastAPI(
    title="Trading Lab API",
    description="Futures trading backtesting platform",
    version="0.1.0",
)

app.include_router(data.router, prefix="api/data", tags=["Market Data"])
app.include_router(prop_firms.router, prefix="/api/prop-firms", tags=["Prop Firms"])

@app.get("/health")
async def health():
    return {"status": "ok"}