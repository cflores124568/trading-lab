import type { Candle, PropFirmEvaluation, PropFirmRules, Trade } from "./api";
import { mffuSession } from "./mffuDrawdown.ts";
import holidayCalendar from "../data/cme_shared_holidays_2019_2025.json" with { type: "json" };

const holidayDates = Object.keys(holidayCalendar.dates).sort();
const sharedSymbol = /^(?:MES|MNQ|MGC|ES|NQ|GC)(?:$|[.=_-]|[FGHJKMNQUVXZ]\d{1,4}$)/;

const localClock = new Intl.DateTimeFormat("en-GB", {timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"});
const localCache = new Map<number, Record<string, string>>();
const localParts = (time: number) => {
  const cached = localCache.get(time);
  if (cached) return cached;
  const parts = Object.fromEntries(localClock.formatToParts(new Date(time * 1000)).map(({type, value}) => [type, value]));
  if (localCache.size >= 20_000) localCache.clear();
  localCache.set(time, parts);
  return parts;
};
const localDate = (parts: Record<string, string>) => `${parts.year}-${parts.month}-${parts.day}`;
const minutes = (parts: Record<string, string>) => Number(parts.hour) * 60 + Number(parts.minute);
export const parseMffuTime = (value: string) => Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`) / 1000;

export interface MffuEvidence {
  incomplete: boolean;
  reasons: string[];
  partial_first_session: boolean;
  partial_final_session: boolean;
  possible_intrabar_limit: boolean;
  first_intrabar_time: string | null;
  first_intrabar_rule: string | null;
  worst_equity: number | null;
}

export function evaluationStatus(evaluation: PropFirmEvaluation): "Passed" | "Failed" | "Inconclusive" {
  if (evaluation.daily_loss_breached || evaluation.drawdown_breached) return "Failed";
  const evidence = evaluation.details.mffu_evidence as MffuEvidence | undefined;
  if (evaluation.details.drawdown_evidence_incomplete || evidence?.incomplete || evidence?.possible_intrabar_limit) return "Inconclusive";
  return evaluation.passed ? "Passed" : "Failed";
}

export function evidenceSummary(evaluation: PropFirmEvaluation): string {
  const evidence = evaluation.details.mffu_evidence as MffuEvidence | undefined;
  const problems: string[] = [];
  if (evidence?.possible_intrabar_limit) problems.push(`A bar may have crossed the ${evidence.first_intrabar_rule === "daily_soft_pause" ? "daily soft-pause limit" : "maximum-loss floor"} at ${evidence.first_intrabar_time}; OHLC cannot establish fill order.`);
  if (evidence?.incomplete) {
    const labels: Record<string, string> = {holiday_calendar_outside_coverage: "holiday dates are only available for 2019–2025", holiday_trading_requires_rule_review: "a position was open on a holiday; the firm's holiday rule needs review", cme_equity_early_close_2025_01_09: "CME equity futures closed early on January 9, 2025; the MFFU holiday deadline is not modeled", missing_or_unaligned_session_close: "missing or unaligned 4:10 p.m. close (try 1-, 5-, or 10-minute bars)", missing_bars_within_session: "missing bars", position_over_regular_session_close: "position open past the regular close", entry_outside_regular_trading_hours: "entry outside regular hours", unsupported_or_missing_intraday_interval: "unsupported or missing interval"};
    problems.push(`Session or price evidence is incomplete: ${evidence.reasons.map((reason) => labels[reason] ?? reason.replace(/_/g, " ")).join(", ")}.`);
  } else if (evaluation.details.drawdown_evidence_incomplete) problems.push("Session or price evidence is incomplete.");
  if (problems.length) return problems.join(" ");
  if (evidence?.partial_first_session || evidence?.partial_final_session) return "The dataset covers only part of its first or final trading session.";
  return "";
}

/** Conservative OHLC envelope; extrema do not establish order of fills. */
export function assessMffuEvidence(candles: Candle[], trades: Trade[], equity: number[], initial: number, rules: PropFirmRules, interval: string | undefined, dollarsPerPoint: number, symbol?: string): MffuEvidence {
  const reasons = new Set<string>();
  const match = /^(\d+)(min|m|h)$/.exec((interval ?? "").toLowerCase());
  const seconds = match ? Number(match[1]) * (match[2] === "h" ? 3600 : 60) : 0;
  if (!(seconds > 0 && seconds < 86400)) reasons.add("unsupported_or_missing_intraday_interval");
  if (!candles.length || candles.length !== equity.length) reasons.add("missing_bar_or_equity_evidence");
  if (candles.some((bar, i) => !Number.isFinite(bar.time) || (i > 0 && bar.time <= candles[i - 1].time))) reasons.add("unordered_or_duplicate_timestamps");
  if (candles.some((bar) => ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) || bar.low > bar.high || bar.close < bar.low || bar.close > bar.high || bar.open < bar.low || bar.open > bar.high)) reasons.add("missing_or_invalid_ohlc");
  if (!Number.isFinite(dollarsPerPoint) || dollarsPerPoint <= 0) reasons.add("invalid_contract_value");
  if (!Number.isFinite(initial) || equity.some((value) => !Number.isFinite(value))) reasons.add("invalid_equity_evidence");
  const empty = (): MffuEvidence => ({incomplete: true, reasons: [...reasons].sort(), partial_first_session: false, partial_final_session: false, possible_intrabar_limit: false, first_intrabar_time: null, first_intrabar_rule: null, worst_equity: null});
  if (reasons.size) return empty();

  const sessions = candles.map((bar) => mffuSession(bar.time));
  if (/^(?:MES|MNQ|ES|NQ)(?:$|[.=_-]|[FGHJKMNQUVXZ]\d{1,4}$)/.test((symbol ?? "").trim().toUpperCase()) && sessions.includes("2025-01-09")) reasons.add("cme_equity_early_close_2025_01_09");
  const floors: number[] = [];
  const starts: number[] = [];
  let floor = rules.account_size * (1 - rules.max_drawdown);
  let highClose = rules.account_size;
  let sessionStart = initial;
  const sessionLast = new Map<string, number>();
  const lastEligible = new Map<string, number>();
  for (let i = 0; i < candles.length; i += 1) {
    if (i && sessions[i] !== sessions[i - 1]) {
      if (rules.evaluation_model === "mffu_eod") {
        highClose = Math.max(highClose, equity[i - 1]);
        floor = Math.min(rules.account_size + 100, Math.max(floor, highClose - rules.account_size * rules.max_drawdown));
      }
      sessionStart = equity[i - 1];
    }
    floors.push(floor);
    starts.push(sessionStart);
    sessionLast.set(sessions[i], i);
    const local = localParts(candles[i].time);
    if (localDate(local) < sessions[i] || minutes(local) < 970) lastEligible.set(sessions[i], i);
    if (i && sessions[i] === sessions[i - 1] && localDate(local) === sessions[i] && minutes(local) < 970 && candles[i].time - candles[i - 1].time > seconds) reasons.add("missing_bars_within_session");
  }
  const orderedSessions = [...sessionLast.keys()];
  const firstLocal = localParts(candles[0].time);
  const partialFirst = localDate(firstLocal) === sessions[0] || minutes(firstLocal) !== 1080 || Number(firstLocal.second) !== 0;
  let partialFinal = false;
  for (const session of orderedSessions) {
    const lastIndex = sessionLast.get(session)!;
    const lastLocal = localParts(candles[lastIndex].time);
    const lastEndSeconds = minutes(lastLocal) * 60 + Number(lastLocal.second) + seconds;
    if (session === orderedSessions[orderedSessions.length - 1] && (localDate(lastLocal) < session || lastEndSeconds < 970 * 60)) { partialFinal = true; continue; }
    const index = lastEligible.get(session);
    if (index === undefined) { reasons.add("missing_or_unaligned_session_close"); continue; }
    const local = localParts(candles[index].time);
    if (localDate(local) !== session || minutes(local) * 60 + Number(local.second) + seconds !== 970 * 60) reasons.add("missing_or_unaligned_session_close");
  }

  let priorBalance = initial;
  let firstIndex: number | null = null;
  let firstRule: string | null = null;
  let worst: number | null = null;
  let lastExit: number | null = null;
  const lowerBound = (value: number, inclusive: boolean) => {
    let low = 0, high = candles.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (candles[mid].time < value || (!inclusive && candles[mid].time === value)) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  for (const trade of trades) {
    const entry = parseMffuTime(trade.entry_time);
    const exit = trade.exit_time ? parseMffuTime(trade.exit_time) : NaN;
    const quantity = trade.quantity;
    if (![entry, exit, quantity, trade.entry_price, trade.pnl, trade.commission].every((v) => typeof v === "number" && Number.isFinite(v)) || quantity == null || quantity <= 0 || exit < entry || !["buy", "sell"].includes(trade.side)) {
      reasons.add("incomplete_trade_evidence"); continue;
    }
    if (lastExit !== null && entry < lastExit) reasons.add("overlapping_or_unordered_trades");
    lastExit = exit;
    if (entry < candles[0].time || exit > candles[candles.length - 1].time) reasons.add("trade_outside_evidence_window");
    const startLocal = localParts(entry), endLocal = localParts(exit);
    if (sharedSymbol.test((symbol ?? "").trim().toUpperCase())) {
      const startDay = localDate(startLocal), endDay = localDate(endLocal);
      if (startDay < holidayCalendar.coverage.start || endDay > holidayCalendar.coverage.end) reasons.add("holiday_calendar_outside_coverage");
      if (holidayDates.some((date) => startDay <= date && date <= endDay)) reasons.add("holiday_trading_requires_rule_review");
    }
    const entrySession = mffuSession(entry), exitSession = mffuSession(exit);
    if (minutes(startLocal) >= 970 && minutes(startLocal) < 1080) reasons.add("entry_outside_regular_trading_hours");
    if (entrySession !== exitSession || (localDate(endLocal) === entrySession && minutes(endLocal) >= 970 && (localDate(startLocal) !== entrySession || minutes(startLocal) < 970))) reasons.add("position_over_regular_session_close");
    const start = lowerBound(entry, true), end = lowerBound(exit, false);
    for (let i = start; i < end; i += 1) {
      const adverse = trade.side === "buy" ? candles[i].low : candles[i].high;
      const points = trade.side === "buy" ? adverse - trade.entry_price : trade.entry_price - adverse;
      const amount = priorBalance + points * quantity * dollarsPerPoint - trade.commission;
      const risk = amount < floors[i] ? "maximum_loss" : rules.daily_loss_mode === "soft_pause" && rules.daily_loss_limit != null && amount <= starts[i] - rules.account_size * rules.daily_loss_limit ? "daily_soft_pause" : null;
      if (risk && (firstIndex === null || i < firstIndex)) { firstIndex = i; firstRule = risk; worst = Math.round(amount * 100) / 100; }
    }
    priorBalance += trade.pnl;
  }
  return {incomplete: reasons.size > 0, reasons: [...reasons].sort(), partial_first_session: partialFirst, partial_final_session: partialFinal, possible_intrabar_limit: firstIndex !== null, first_intrabar_time: firstIndex === null ? null : new Date(candles[firstIndex].time * 1000).toISOString(), first_intrabar_rule: firstRule, worst_equity: worst};
}
