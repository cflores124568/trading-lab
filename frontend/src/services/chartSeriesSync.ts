/** Synchronize immutable, ordered chart data without rebuilding a replay's
 * growing prefix. Replacements and rewinds always take the full-data path. */
export function createSeriesSynchronizer<T>(target: {
  setData: (data: T[]) => void;
  update: (point: T) => void;
}) {
  let previousSource: readonly T[] | undefined;
  let previousCount = 0;
  return (source: readonly T[], visibleCount = source.length) => {
    const count = Math.max(0, Math.min(source.length, Math.floor(visibleCount)));
    if (source === previousSource && count >= previousCount) {
      for (let index = previousCount; index < count; index++) target.update(source[index]);
    } else {
      target.setData(source.slice(0, count));
    }
    previousSource = source;
    previousCount = count;
  };
}

/** Upper bound keeps unrevealed candles out of indicator series during replay. */
export function visiblePointCount(points: readonly { time: number }[], cutoff: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid].time <= cutoff) low = mid + 1;
    else high = mid;
  }
  return low;
}
