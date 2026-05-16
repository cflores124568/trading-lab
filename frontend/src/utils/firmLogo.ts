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

export function firmOf(name: string): string {
  let firm = name.split(/\s+\d/)[0].trim();
  firm = firm
    .replace(/^My Funded Futures (Rapid|Flex)?/i, "My Funded Futures")
    .replace(/^Lucid Trading /i, "Lucid Trading")
    .trim();
  return firm;
}

export function stripFirmPrefix(name: string, firm: string = firmOf(name)): string {
  if (name.toLowerCase().startsWith(firm.toLowerCase())) {
    return name.slice(firm.length).trim() || name;
  }
  return name;
}
