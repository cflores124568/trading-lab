# Trading Lab

Full-stack futures trading backtesting platform focused on  
prop firm challenge simulation (FTMO, TopStep, Apex).

Replay historical data bar-by-bar, test manual strategies in real-time,  
and run algorithmic backtests against real prop firm rules — without spending money on failed challenges.

## Current status

Backend only (FastAPI + in-memory storage)

## Tech stack (so far)

- **Backend**: Python, FastAPI, pandas, pandas-ta
- **Future**: Next.js + TypeScript (frontend)

## Quick start (backend)

```bash
cd backend
python -m venv venv
source venv/bin/activate    # or venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload