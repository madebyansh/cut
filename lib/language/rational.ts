export type Rational = { numerator: string; denominator: string };

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left, b = right < 0n ? -right : right;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

export function rational(numerator: bigint | number | string, denominator: bigint | number | string = 1): Rational {
  let top = BigInt(numerator), bottom = BigInt(denominator);
  if (bottom === 0n) throw new Error("Rational denominator cannot be zero.");
  if (bottom < 0n) { top = -top; bottom = -bottom; }
  const divisor = gcd(top, bottom);
  return { numerator: String(top / divisor), denominator: String(bottom / divisor) };
}

export function decimalRational(raw: string): Rational {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match || (!match[2] && !match[3])) throw new Error(`Invalid exact decimal “${raw}”.`);
  const fraction = match[3] ?? ""; const digits = `${match[2] || "0"}${fraction}`;
  return rational(`${match[1] === "-" ? "-" : ""}${digits}`, 10n ** BigInt(fraction.length));
}

export function addRational(left: Rational, right: Rational): Rational {
  return rational(BigInt(left.numerator) * BigInt(right.denominator) + BigInt(right.numerator) * BigInt(left.denominator), BigInt(left.denominator) * BigInt(right.denominator));
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return rational(BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator), BigInt(left.denominator) * BigInt(right.denominator));
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(BigInt(left.numerator) * BigInt(right.numerator), BigInt(left.denominator) * BigInt(right.denominator));
}

export function divideRational(left: Rational, right: Rational): Rational {
  return rational(BigInt(left.numerator) * BigInt(right.denominator), BigInt(left.denominator) * BigInt(right.numerator));
}

export function compareRational(left: Rational, right: Rational) {
  const difference = BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function rationalToNumber(value: Rational) { return Number(value.numerator) / Number(value.denominator); }
export const zeroRational = rational(0);
