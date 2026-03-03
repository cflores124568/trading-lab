from fastapi import FastAPI
from routers import data

app = FastAPI(
    title="Trading Lab API",
    description="Futures trading backtesting platform",
    version="0.1.0",
)

app.include_router(data.router, prefix="api/data", tags=["Market Data"])

@app.get("/health")
async def health():
    return {"status": "ok"}