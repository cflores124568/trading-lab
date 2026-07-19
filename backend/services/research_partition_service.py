from datetime import datetime, timezone
from decimal import Decimal, ROUND_FLOOR


PARTITION_NAMES = ("development", "validation", "holdout")


def calculate_chronological_partitions(
    bar_timestamps: list[datetime],
    *,
    development_pct: float,
    validation_pct: float,
    holdout_pct: float,
) -> list[dict]:
    """Split ordered bars once, with no shuffling and no shared boundary bar."""
    percentages = _validated_percentages(
        development_pct,
        validation_pct,
        holdout_pct,
    )
    timestamps = [_as_utc(value) for value in bar_timestamps]
    if len(timestamps) < 3:
        raise ValueError("A research campaign needs at least three bars, one per partition.")
    if any(left >= right for left, right in zip(timestamps, timestamps[1:])):
        raise ValueError("Research bar timestamps must be unique and strictly chronological.")

    raw_counts = [Decimal(len(timestamps)) * value / Decimal("100") for value in percentages]
    counts = [int(value.to_integral_value(rounding=ROUND_FLOOR)) for value in raw_counts]
    remaining = len(timestamps) - sum(counts)
    remainder_order = sorted(
        range(3),
        key=lambda index: (-(raw_counts[index] - counts[index]), index),
    )
    for index in remainder_order[:remaining]:
        counts[index] += 1

    if any(count < 1 for count in counts):
        raise ValueError(
            "The requested percentages leave an empty partition for this bar window; "
            "use a larger window or less extreme percentages."
        )

    partitions = []
    cursor = 0
    for name, count in zip(PARTITION_NAMES, counts):
        partition_timestamps = timestamps[cursor : cursor + count]
        partitions.append(
            {
                "partition_name": name,
                "start_time": partition_timestamps[0],
                "end_time": partition_timestamps[-1],
                "bar_count": count,
            }
        )
        cursor += count
    return partitions


def _validated_percentages(*values: float) -> tuple[Decimal, Decimal, Decimal]:
    percentages = tuple(Decimal(str(value)) for value in values)
    if any(value <= 0 or value >= 100 for value in percentages):
        raise ValueError("Each research split percentage must be greater than 0 and less than 100.")
    if sum(percentages) != Decimal("100"):
        raise ValueError("development, validation, and holdout percentages must total exactly 100.")
    return percentages


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Research bar timestamps must include a timezone.")
    return value.astimezone(timezone.utc)
