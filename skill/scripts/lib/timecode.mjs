// Single source of truth for rational fps ↔ frames ↔ seconds conversions.
// All artifact timestamps are source seconds; frame math goes through here.

export function parseRational(str) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(str).trim());
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (den === 0) return null;
    return { num, den };
  }
  const f = Number(str);
  if (!Number.isFinite(f) || f <= 0) return null;
  return { num: f, den: 1 };
}

export function rationalToFloat({ num, den }) {
  return num / den;
}

export function frameDuration(num, den) {
  return den / num;
}

export function secondsToFrames(s, num, den) {
  return Math.round((s * num) / den);
}

export function framesToSeconds(f, num, den) {
  return (f * den) / num;
}

// Snap a source-seconds timestamp to the exact start of its nearest frame.
export function snapToFrame(s, num, den) {
  return framesToSeconds(secondsToFrames(s, num, den), num, den);
}

// Standard CFR whitelist for VFR normalization targets.
export const STANDARD_RATES = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];

export function nearestStandardRate(fps) {
  let best = STANDARD_RATES[0];
  let bestDist = Infinity;
  for (const r of STANDARD_RATES) {
    const d = Math.abs(rationalToFloat(r) - fps);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}
