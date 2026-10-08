// Fractional ranks: strings that sort lexicographically, so moving a card rewrites one row
// instead of renumbering the whole column. Digits are base 62 in ASCII order.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`rank ${a} must sort before ${b}`);
  if (a.endsWith("0") || b?.endsWith("0")) throw new Error("rank must not end in 0");
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0] as string) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0] as string) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) / 2)] as string;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[digitA] as string) + midpoint(a.slice(1), null);
}

/** Smallest step past `rank`: bump its first non-max digit, so appends grow ~1 char per 61. */
function increment(rank: string): string {
  for (let i = 0; i < rank.length; i++) {
    const digit = DIGITS.indexOf(rank[i] as string);
    if (digit < DIGITS.length - 1) return rank.slice(0, i) + DIGITS[digit + 1];
  }
  return `${rank}1`;
}

/** Returns a rank strictly between `before` and `after`; null means the start or end of the list. */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && after === null) return increment(before);
  return midpoint(before ?? "", after);
}
