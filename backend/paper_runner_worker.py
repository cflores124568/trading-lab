"""Process entrypoint for durable historical paper-runner execution."""

import sys

from dotenv import load_dotenv

from services.db import _conn
from services.paper_runner_worker import DurablePaperRunnerWorker

load_dotenv()


def _healthcheck() -> None:
    with _conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            if cur.fetchone() != (1,):
                raise RuntimeError("Paper runner database healthcheck failed.")


if __name__ == "__main__":
    if "--healthcheck" in sys.argv[1:]:
        _healthcheck()
    else:
        DurablePaperRunnerWorker().run_forever()
