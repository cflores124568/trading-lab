import unittest
from copy import deepcopy
from unittest.mock import patch

from services import paper_market_event_service


class PaperMarketEventSequencerTests(unittest.TestCase):
    def test_bbo_is_normalized_and_accepted(self):
        disposition, cursor = paper_market_event_service.sequence_market_event(
            _bbo(sequence=10),
            {},
            expected_symbol="NQ",
            tick_size=0.25,
        )

        self.assertEqual(disposition.status, "accepted")
        self.assertEqual(disposition.normalized_quote["bid"], 19999.75)
        self.assertEqual(disposition.normalized_quote["ask"], 20000.25)
        self.assertEqual(disposition.normalized_quote["spread_ticks"], 2)
        self.assertFalse(disposition.normalized_quote["synthetic"])
        self.assertEqual(cursor["last_sequence"], 10)
        self.assertEqual(cursor["data_quality"], "good")

    def test_duplicate_and_stale_events_do_not_advance_the_cursor(self):
        first, cursor = paper_market_event_service.sequence_market_event(
            _bbo(sequence=10),
            {},
            expected_symbol="NQ",
            tick_size=0.25,
        )
        duplicate, duplicate_cursor = paper_market_event_service.sequence_market_event(
            _bbo(sequence=10),
            cursor,
            expected_symbol="NQ",
            tick_size=0.25,
        )
        stale, stale_cursor = paper_market_event_service.sequence_market_event(
            _trade(event_id="trade-stale", sequence=9),
            cursor,
            expected_symbol="NQ",
            tick_size=0.25,
        )

        self.assertEqual(first.status, "accepted")
        self.assertEqual(duplicate.status, "duplicate")
        self.assertEqual(stale.status, "stale")
        self.assertEqual(duplicate_cursor, cursor)
        self.assertEqual(stale_cursor, cursor)

    def test_sequence_gap_is_accepted_but_degrades_data_quality(self):
        _, cursor = paper_market_event_service.sequence_market_event(
            _bbo(sequence=10),
            {},
            expected_symbol="NQ",
            tick_size=0.25,
        )
        disposition, next_cursor = paper_market_event_service.sequence_market_event(
            _trade(event_id="trade-gap", sequence=14),
            cursor,
            expected_symbol="NQ",
            tick_size=0.25,
        )

        self.assertEqual(disposition.status, "accepted_with_gap")
        self.assertEqual(disposition.gap.expected_sequence, 11)
        self.assertEqual(disposition.gap.received_sequence, 14)
        self.assertEqual(disposition.gap.missing_count, 3)
        self.assertEqual(next_cursor["data_quality"], "degraded")
        self.assertEqual(next_cursor["sequence_gap_count"], 1)
        self.assertEqual(next_cursor["missing_sequence_count"], 3)

    def test_event_time_regression_is_stale_even_when_sequence_advances(self):
        _, cursor = paper_market_event_service.sequence_market_event(
            _bbo(
                sequence=10,
                event_time="2026-07-19T06:00:10+00:00",
                received_time="2026-07-19T06:00:10.001000+00:00",
            ),
            {},
            expected_symbol="NQ",
            tick_size=0.25,
        )
        disposition, next_cursor = paper_market_event_service.sequence_market_event(
            _trade(
                event_id="trade-late",
                sequence=11,
                event_time="2026-07-19T06:00:09+00:00",
                received_time="2026-07-19T06:00:11+00:00",
            ),
            cursor,
            expected_symbol="NQ",
            tick_size=0.25,
        )

        self.assertEqual(disposition.status, "stale")
        self.assertEqual(next_cursor, cursor)

    def test_locked_and_crossed_quotes_are_quarantined_but_consume_sequence(self):
        locked, locked_cursor = paper_market_event_service.sequence_market_event(
            _bbo(event_id="locked", sequence=1, bid=20000.0, ask=20000.0),
            {},
            expected_symbol="NQ",
            tick_size=0.25,
        )
        crossed, crossed_cursor = paper_market_event_service.sequence_market_event(
            _bbo(event_id="crossed", sequence=2, bid=20000.25, ask=20000.0),
            locked_cursor,
            expected_symbol="NQ",
            tick_size=0.25,
        )

        self.assertEqual(locked.status, "rejected_locked")
        self.assertIsNone(locked.normalized_quote)
        self.assertEqual(locked_cursor["last_sequence"], 1)
        self.assertEqual(crossed.status, "rejected_crossed")
        self.assertIsNone(crossed.normalized_quote)
        self.assertEqual(crossed_cursor["last_sequence"], 2)
        self.assertEqual(crossed_cursor["quarantined_event_count"], 2)

    def test_stream_and_timestamp_validation_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            paper_market_event_service.sequence_market_event(
                _bbo(sequence=1, symbol="ES"),
                {},
                expected_symbol="NQ",
                tick_size=0.25,
            )
        with self.assertRaisesRegex(ValueError, "timezone"):
            paper_market_event_service.normalize_market_event(
                _bbo(sequence=1, event_time="2026-07-19T06:00:00")
            )


class PaperMarketEventAdapterTests(unittest.TestCase):
    def test_adapter_updates_quote_without_touching_trading_state(self):
        original = _session()
        saved = []
        with patch.object(
            paper_market_event_service,
            "_require_paper_session",
            return_value=original,
        ), patch.object(
            paper_market_event_service,
            "_ensure_session_defaults",
            side_effect=lambda session: session,
        ), patch.object(
            paper_market_event_service,
            "_save_paper_session_any",
            side_effect=lambda session: saved.append(deepcopy(session)),
        ), patch.object(
            paper_market_event_service,
            "_now",
            return_value="2026-07-19T06:01:00+00:00",
        ):
            result = paper_market_event_service.apply_paper_market_event(
                "paper-1",
                _bbo(sequence=1),
            )

        self.assertEqual(result["disposition"]["status"], "accepted")
        self.assertEqual(result["last_quote"]["source"], "synthetic-fixture")
        self.assertEqual(saved[0]["status"], "paused")
        self.assertEqual(saved[0]["current_position"], original["current_position"])
        self.assertEqual(saved[0]["active_orders"], original["active_orders"])
        self.assertEqual(saved[0]["trade_log"], original["trade_log"])
        self.assertEqual(saved[0]["runner_state"]["mode"], "paused")

    def test_trade_updates_last_trade_without_replacing_the_quote(self):
        session = _session()
        original_quote = deepcopy(session["last_quote"])
        with patch.object(
            paper_market_event_service,
            "_require_paper_session",
            return_value=session,
        ), patch.object(
            paper_market_event_service,
            "_ensure_session_defaults",
            side_effect=lambda value: value,
        ), patch.object(paper_market_event_service, "_save_paper_session_any"):
            result = paper_market_event_service.apply_paper_market_event(
                "paper-1",
                _trade(sequence=1),
            )

        self.assertEqual(result["last_quote"], original_quote)
        self.assertEqual(result["last_market_trade"]["price"], 20000.0)

    def test_duplicate_delivery_is_idempotent_and_does_not_save_again(self):
        session = _session()
        session["runner_state"]["market_event_cursor"] = {
            "stream_key": "synthetic-fixture:fixture-publisher:NQ.FUT",
            "last_sequence": 1,
            "last_event_time": "2026-07-19T06:00:00+00:00",
            "last_received_time": "2026-07-19T06:00:00.001000+00:00",
            "last_event_id": "bbo-1",
            "recent_event_ids": ["bbo-1"],
        }
        with patch.object(
            paper_market_event_service,
            "_require_paper_session",
            return_value=session,
        ), patch.object(
            paper_market_event_service,
            "_ensure_session_defaults",
            side_effect=lambda value: value,
        ), patch.object(
            paper_market_event_service,
            "_save_paper_session_any",
        ) as save:
            result = paper_market_event_service.apply_paper_market_event(
                "paper-1",
                _bbo(sequence=1),
            )

        self.assertEqual(result["disposition"]["status"], "duplicate")
        save.assert_not_called()

    def test_quarantined_quote_does_not_replace_last_good_quote(self):
        session = _session()
        original_quote = deepcopy(session["last_quote"])
        with patch.object(
            paper_market_event_service,
            "_require_paper_session",
            return_value=session,
        ), patch.object(
            paper_market_event_service,
            "_ensure_session_defaults",
            side_effect=lambda value: value,
        ), patch.object(paper_market_event_service, "_save_paper_session_any"):
            result = paper_market_event_service.apply_paper_market_event(
                "paper-1",
                _bbo(sequence=1, bid=20000.25, ask=20000.0),
            )

        self.assertEqual(result["disposition"]["status"], "rejected_crossed")
        self.assertEqual(result["last_quote"], original_quote)


def _bbo(
    *,
    event_id: str = "bbo-1",
    sequence: int,
    symbol: str = "NQ",
    bid: float = 19999.75,
    ask: float = 20000.25,
    event_time: str = "2026-07-19T06:00:00+00:00",
    received_time: str = "2026-07-19T06:00:00.001000+00:00",
) -> dict:
    return {
        "event_type": "bbo",
        "event_id": event_id,
        "source": "synthetic-fixture",
        "symbol": symbol,
        "instrument_id": "NQ.FUT",
        "publisher_id": "fixture-publisher",
        "event_time": event_time,
        "received_time": received_time,
        "sequence": sequence,
        "bid_price": bid,
        "ask_price": ask,
        "bid_size": 8,
        "ask_size": 7,
        "bid_order_count": 3,
        "ask_order_count": 2,
    }


def _trade(
    *,
    event_id: str = "trade-1",
    sequence: int,
    event_time: str = "2026-07-19T06:00:00+00:00",
    received_time: str = "2026-07-19T06:00:00.001000+00:00",
) -> dict:
    return {
        "event_type": "trade",
        "event_id": event_id,
        "source": "synthetic-fixture",
        "symbol": "NQ",
        "instrument_id": "NQ.FUT",
        "publisher_id": "fixture-publisher",
        "event_time": event_time,
        "received_time": received_time,
        "sequence": sequence,
        "price": 20000.0,
        "size": 2,
        "aggressor_side": "buy",
    }


def _session() -> dict:
    return {
        "paper_session_id": "paper-1",
        "candidate_id": "candidate-1",
        "symbol": "NQ",
        "tick_size": 0.25,
        "status": "paused",
        "current_position": {"side": "sell", "status": "open", "quantity": 1},
        "active_orders": [],
        "trade_log": [{"trade_id": 1}],
        "last_quote": {"bid": 19999.5, "ask": 20000.0, "reference": 19999.75},
        "runner_state": {"mode": "paused", "market_event_cursor": {}},
        "updated_at": "2026-07-19T05:00:00+00:00",
    }


if __name__ == "__main__":
    unittest.main()
