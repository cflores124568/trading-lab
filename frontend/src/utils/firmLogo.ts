const FIRM_LOGO_MAP: [RegExp, string][] = [
  [/topstep/i, "/logos/topstep.svg"],
  [/my funded futures|myfundedfutures|mff/i, "/logos/mff.svg"],
  [/lucid/i, "/logos/lucid.svg"],
];

export function firmLogoSrc(firmName: string | null | undefined): string | null {
  if (!firmName) return null;
  for (const [pattern, src] of FIRM_LOGO_MAP) {
    if (pattern.test(firmName)) return src;
  }
  return null;
}
