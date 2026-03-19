# Trading Lab 

A high-performance futures trading simulator and backtesting engine. Built to simulate prop firm evaluation rules (Apex, Topstep) with zero-latency visual feedback.

## Tech Stack
- **Frontend:** SolidJS (Fine-grained reactivity for 60fps chart updates)
- **Styling:** Tailwind CSS v4 (Rust-based engine)
- **Backend:** FastAPI (Python 3.12)
- **Calculations:** NumPy / Pandas (Vectorized backtesting)
- **Data:** yfinance API integration

## Project Structure
- `/backend`: FastAPI server, trading logic, and data providers.
- `/frontend`: SolidJS dashboard and TradingView charting.

## Getting Started
1. **Backend:** Install `requirements.txt` and run `uvicorn main:app --reload`
2. **Frontend:** Run `npm install` and `npm run dev` in the frontend folder.