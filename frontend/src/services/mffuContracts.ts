import type { PropFirmRules } from "./api";

export function mffuContractLimit(symbol: string | undefined, rules: PropFirmRules): number | null {
  const mini = rules.max_mini_contracts;
  const micro = rules.max_micro_contracts;
  if (mini == null && micro == null) return null;
  const root = (symbol ?? "").trim().toUpperCase().match(/^(M2K|MES|MNQ|MYM|MGC|SIL|MCL|RTY|ES|NQ|YM|GC|SI|CL)(?=$|[.=_-]|[FGHJKMNQUVXZ]\d{1,4}$)/)?.[1];
  if (!root) throw new Error("Cannot verify the MFFU contract limit for this symbol; use a supported mini or micro futures symbol.");
  const isMicro = ["M2K", "MES", "MNQ", "MYM", "MGC", "SIL", "MCL"].includes(root);
  const limit = isMicro ? micro : mini;
  if (limit == null || limit < 1) throw new Error(`${root} is not permitted by this account's contract limits.`);
  return limit;
}
