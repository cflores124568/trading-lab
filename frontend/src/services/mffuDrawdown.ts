const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23",
});
const sessionCache = new Map<number, string>();

export function mffuSession(time: number): string {
  const cached = sessionCache.get(time);
  if (cached) return cached;
  const parts = Object.fromEntries(formatter.formatToParts(new Date(time * 1000)).map(({type, value}) => [type, value]));
  const key = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + (Number(parts.hour) >= 18 ? 1 : 0))).toISOString().slice(0, 10);
  if (sessionCache.size >= 20_000) sessionCache.clear();
  sessionCache.set(time, key);
  return key;
}

/** Bar-close approximation; timestamps are Unix seconds in increasing order. */
export function getMffuDrawdown(equity: number[], timestamps: number[], account: number, limit: number, staticFloor = false) {
  if (timestamps.length !== equity.length || timestamps.length === 0 ||
      timestamps.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= timestamps[index - 1]))) {
    return { incomplete: true, breached: false, actual: 0, floor: null, breachIndex: null as number | null, peak: null as number | null, peakIndex: null as number | null };
  }
  let floor = account * (1 - limit);
  let highClose = account;
  let highIndex: number | null = null;
  let peakIndex: number | null = null;
  let peak = account;
  let maximum = 0;
  let breachIndex: number | null = null;
  let previousSession = mffuSession(timestamps[0]);
  for (let i = 0; i < equity.length; i += 1) {
    const currentSession = mffuSession(timestamps[i]);
    if (!staticFloor && i > 0 && currentSession !== previousSession) {
      if (equity[i - 1] > highClose) { highClose = equity[i - 1]; highIndex = i - 1; }
      floor = Math.min(account + 100, Math.max(floor, highClose - account * limit));
    }
    const loss = highClose - equity[i];
    if (loss > maximum) { maximum = loss; peak = highClose; peakIndex = highIndex; }
    if (breachIndex === null && equity[i] < floor) breachIndex = i;
    previousSession = currentSession;
  }
  return { incomplete: false, breached: breachIndex !== null, actual: maximum / account, floor: Math.round(floor * 100) / 100, breachIndex, peak, peakIndex };
}
