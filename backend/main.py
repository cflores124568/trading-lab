from fastapi import FastAPI

app = FastAPI(
    title="Trading Lab API",
    description="Futures trading backtesting platform",
    version="0.1.0",
)

@app.get("/health")
async def health():
    return {"status": "ok"}