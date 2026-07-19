"""Process entrypoint for the durable Alpha Lab search worker."""
import sys
from dotenv import load_dotenv
from services.db import _conn
from services.research_repo import _ensure_research_schema
from services.research_search_worker import DurableResearchSearchWorker

load_dotenv()

def _healthcheck():
    with _conn() as conn:
        _ensure_research_schema(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            if cur.fetchone() != (1,): raise RuntimeError("Research worker database healthcheck failed.")

if __name__ == "__main__":
    _healthcheck() if "--healthcheck" in sys.argv[1:] else DurableResearchSearchWorker().run_forever()
