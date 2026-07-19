import unittest
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError

from schemas import ResearchCampaignCreate
from services.research_partition_service import calculate_chronological_partitions


class ResearchPartitionTests(unittest.TestCase):
    def setUp(self):
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.timestamps = [start + timedelta(minutes=index) for index in range(10)]

    def test_partitions_are_deterministic_chronological_and_non_overlapping(self):
        first = calculate_chronological_partitions(
            self.timestamps,
            development_pct=60,
            validation_pct=20,
            holdout_pct=20,
        )
        second = calculate_chronological_partitions(
            self.timestamps,
            development_pct=60,
            validation_pct=20,
            holdout_pct=20,
        )

        self.assertEqual(first, second)
        self.assertEqual([item["bar_count"] for item in first], [6, 2, 2])
        self.assertLess(first[0]["end_time"], first[1]["start_time"])
        self.assertLess(first[1]["end_time"], first[2]["start_time"])
        self.assertEqual(sum(item["bar_count"] for item in first), len(self.timestamps))

    def test_invalid_split_percentages_fail_closed_at_protocol_boundary(self):
        with self.assertRaises(ValidationError):
            ResearchCampaignCreate(
                name="invalid split",
                symbol="NQ",
                interval="15min",
                start_time=self.timestamps[0],
                end_time=self.timestamps[-1],
                development_pct=60,
                validation_pct=25,
                holdout_pct=20,
            )
        with self.assertRaises(ValidationError):
            ResearchCampaignCreate(
                name="unsupported precision",
                symbol="NQ",
                interval="15min",
                start_time=self.timestamps[0],
                end_time=self.timestamps[-1],
                development_pct=33.33333,
                validation_pct=33.33333,
                holdout_pct=33.33334,
            )

    def test_empty_partition_and_unordered_timestamps_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "empty partition"):
            calculate_chronological_partitions(
                self.timestamps[:3],
                development_pct=98,
                validation_pct=1,
                holdout_pct=1,
            )
        with self.assertRaisesRegex(ValueError, "strictly chronological"):
            calculate_chronological_partitions(
                [self.timestamps[0], self.timestamps[2], self.timestamps[1]],
                development_pct=60,
                validation_pct=20,
                holdout_pct=20,
            )


if __name__ == "__main__":
    unittest.main()
