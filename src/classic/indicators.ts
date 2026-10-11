// Textbook indicators over closed candles. Pure functions: an array in, an array of the same length out, null until the
// indicator has enough bars (no guessing on the first bars).
export type Series = (number | null)[];

export function sma(x: number[], n: number): Series {
  const out: Series = new Array(x.length).fill(null);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values. */
export function ema(x: number[], n: number): Series {
  const out: Series = new Array(x.length).fill(null);
  if (x.length < n) return out;
  const k = 2 / (n + 1);
  let e = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  for (let i = n; i < x.length; i++) { e = x[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
/** EMA of a series that starts with nulls (MACD's signal line). */
function emaOf(x: Series, n: number): Series {
  const first = x.findIndex((v) => v != null);
  if (first < 0) return x.map(() => null);
  const tail = ema(x.slice(first) as number[], n);
  return [...new Array(first).fill(null), ...tail];
}

/** RSI with Wilder's smoothing. */
export function rsi(x: number[], n = 14): Series {
  const out: Series = new Array(x.length).fill(null);
  if (x.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = x[i] - x[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

/** Bollinger bands: SMA ± k × the population standard deviation; width = (upper − lower) / middle. */
export function bollinger(x: number[], n = 20, k = 2): { mid: Series; upper: Series; lower: Series; width: Series } {
  const mid = sma(x, n), upper: Series = [], lower: Series = [], width: Series = [];
  for (let i = 0; i < x.length; i++) {
    const m = mid[i];
    if (m == null) { upper.push(null); lower.push(null); width.push(null); continue; }
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (x[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    upper.push(m + k * sd); lower.push(m - k * sd); width.push(m ? (2 * k * sd) / m : null);
  }
  return { mid, upper, lower, width };
}

export function macd(x: number[], fast = 12, slow = 26, signal = 9): { macd: Series; signal: Series; hist: Series } {
  const f = ema(x, fast), s = ema(x, slow);
  const line: Series = x.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
  const sig = emaOf(line, signal);
  return { macd: line, signal: sig, hist: line.map((v, i) => (v != null && sig[i] != null ? v - (sig[i] as number) : null)) };
}

/** Average true range, Wilder's smoothing. */
export function atr(h: number[], l: number[], c: number[], n = 14): Series {
  const out: Series = new Array(c.length).fill(null);
  const tr = c.map((_, i) => (i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  if (c.length < n) return out;
  let a = tr.slice(0, n).reduce((s, v) => s + v, 0) / n;
  out[n - 1] = a;
  for (let i = n; i < c.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
  return out;
}

/** Donchian channel over the n bars BEFORE bar i (the breakout bar itself is not part of its own channel). */
export function donchian(h: number[], l: number[], n: number): { upper: Series; lower: Series } {
  const upper: Series = [], lower: Series = [];
  for (let i = 0; i < h.length; i++) {
    if (i < n) { upper.push(null); lower.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n; j < i; j++) { hi = Math.max(hi, h[j]); lo = Math.min(lo, l[j]); }
    upper.push(hi); lower.push(lo);
  }
  return { upper, lower };
}

/** Supertrend: direction +1 / −1 per bar (null while ATR warms up). */
export function supertrend(h: number[], l: number[], c: number[], n = 10, mult = 3): { dir: (1 | -1 | null)[]; line: Series } {
  const a = atr(h, l, c, n), dir: (1 | -1 | null)[] = [], line: Series = [];
  let upperBand = 0, lowerBand = 0, d: 1 | -1 = 1, started = false;
  for (let i = 0; i < c.length; i++) {
    if (a[i] == null) { dir.push(null); line.push(null); continue; }
    const mid = (h[i] + l[i]) / 2, ub = mid + mult * (a[i] as number), lb = mid - mult * (a[i] as number);
    if (!started) { upperBand = ub; lowerBand = lb; d = c[i] >= mid ? 1 : -1; started = true; }
    else {
      upperBand = ub < upperBand || c[i - 1] > upperBand ? ub : upperBand;
      lowerBand = lb > lowerBand || c[i - 1] < lowerBand ? lb : lowerBand;
      if (d === -1 && c[i] > upperBand) d = 1;
      else if (d === 1 && c[i] < lowerBand) d = -1;
    }
    dir.push(d); line.push(d === 1 ? lowerBand : upperBand);
  }
  return { dir, line };
}
