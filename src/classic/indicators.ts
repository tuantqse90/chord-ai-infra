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

/** SMA of a series that starts with nulls (the stochastic's smoothing). */
function smaOf(x: Series, n: number): Series {
  const first = x.findIndex((v) => v != null);
  if (first < 0) return x.map(() => null);
  return [...new Array(first).fill(null), ...sma(x.slice(first) as number[], n)];
}
/** Highest high and lowest low of the n bars ending at bar i (a closed bar counts in its own window). */
function range(h: number[], l: number[], n: number): { hi: Series; lo: Series } {
  const hi: Series = [], lo: Series = [];
  for (let i = 0; i < h.length; i++) {
    if (i < n - 1) { hi.push(null); lo.push(null); continue; }
    let a = -Infinity, b = Infinity;
    for (let j = i - n + 1; j <= i; j++) { a = Math.max(a, h[j]); b = Math.min(b, l[j]); }
    hi.push(a); lo.push(b);
  }
  return { hi, lo };
}

/** Stochastic oscillator: %K = where the close sits in the n-bar range (0–100), smoothed by an SMA; %D = an SMA of %K. */
export function stochastic(h: number[], l: number[], c: number[], n = 14, smoothK = 3, dN = 3): { k: Series; d: Series } {
  const { hi, lo } = range(h, l, n);
  const raw: Series = c.map((x, i) => (hi[i] == null ? null : (hi[i] as number) > (lo[i] as number) ? (100 * (x - (lo[i] as number))) / ((hi[i] as number) - (lo[i] as number)) : 50));
  const k = smaOf(raw, smoothK);
  return { k, d: smaOf(k, dN) };
}

/** Wilder's directional movement: +DI, −DI (0–100) and ADX, the strength of the trend whatever its side. */
export function dmi(h: number[], l: number[], c: number[], n = 14): { plus: Series; minus: Series; adx: Series } {
  const len = c.length, plus: Series = new Array(len).fill(null), minus: Series = new Array(len).fill(null), adx: Series = new Array(len).fill(null);
  if (len <= n) return { plus, minus, adx };
  let tr = 0, pdm = 0, mdm = 0;
  const dx: Series = new Array(len).fill(null);
  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1], down = l[i - 1] - l[i];
    const p = up > down && up > 0 ? up : 0, m = down > up && down > 0 ? down : 0;
    const t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) { tr += t; pdm += p; mdm += m; if (i < n) continue; }
    else { tr = tr - tr / n + t; pdm = pdm - pdm / n + p; mdm = mdm - mdm / n + m; }
    const pi = tr ? (100 * pdm) / tr : 0, mi = tr ? (100 * mdm) / tr : 0;
    plus[i] = pi; minus[i] = mi; dx[i] = pi + mi ? (100 * Math.abs(pi - mi)) / (pi + mi) : 0;
  }
  // ADX: the mean of the first n DX values, then Wilder's smoothing
  let a = 0;
  for (let i = n; i < len; i++) {
    if (i < 2 * n - 1) { a += dx[i] as number; continue; }
    a = i === 2 * n - 1 ? (a + (dx[i] as number)) / n : (a * (n - 1) + (dx[i] as number)) / n;
    adx[i] = a;
  }
  return { plus, minus, adx };
}

/** Parabolic SAR (Wilder): a stop that trails the trend and accelerates with each new extreme; the side flips when price
 *  crosses it. */
export function psar(h: number[], l: number[], step = 0.02, max = 0.2): { sar: Series; dir: (1 | -1 | null)[] } {
  const sar: Series = [null], dir: (1 | -1 | null)[] = [null];
  if (h.length < 2) return { sar: h.map(() => null), dir: h.map(() => null) };
  let up = h[1] + l[1] >= h[0] + l[0], s = up ? l[0] : h[0], ep = up ? h[0] : l[0], af = step;
  for (let i = 1; i < h.length; i++) {
    s = s + af * (ep - s);
    if (up) {
      s = Math.min(s, l[i - 1], i > 1 ? l[i - 2] : l[i - 1]);
      if (l[i] < s) { up = false; s = ep; ep = l[i]; af = step; }
      else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
    } else {
      s = Math.max(s, h[i - 1], i > 1 ? h[i - 2] : h[i - 1]);
      if (h[i] > s) { up = true; s = ep; ep = h[i]; af = step; }
      else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
    }
    sar.push(s); dir.push(up ? 1 : -1);
  }
  return { sar, dir };
}

/** Kaufman's adaptive moving average: fast when the price moves in a straight line, nearly still when it chops. */
export function kama(x: number[], n = 10, fast = 2, slow = 30): Series {
  const out: Series = new Array(x.length).fill(null);
  if (x.length < n + 1) return out;
  const fsc = 2 / (fast + 1), ssc = 2 / (slow + 1);
  let k = x[n - 1];
  out[n - 1] = k;
  for (let i = n; i < x.length; i++) {
    let vol = 0;
    for (let j = i - n + 1; j <= i; j++) vol += Math.abs(x[j] - x[j - 1]);
    const er = vol ? Math.abs(x[i] - x[i - n]) / vol : 0, sc = (er * (fsc - ssc) + ssc) ** 2;
    k += sc * (x[i] - k);
    out[i] = k;
  }
  return out;
}

/** Ichimoku: tenkan and kijun (mid-ranges of 9 and 26 bars) and the cloud's two spans as they stand at bar i, i.e. computed
 *  `disp` bars earlier (the spans are drawn ahead of price, so nothing here reads a later bar). */
export function ichimoku(h: number[], l: number[], t = 9, k = 26, s = 52, disp = 26): { tenkan: Series; kijun: Series; spanA: Series; spanB: Series } {
  const mid = (n: number) => { const r = range(h, l, n); return r.hi.map((v, i) => (v == null ? null : (v + (r.lo[i] as number)) / 2)); };
  const tenkan = mid(t), kijun = mid(k), b = mid(s);
  const a: Series = tenkan.map((v, i) => (v != null && kijun[i] != null ? (v + (kijun[i] as number)) / 2 : null));
  const shift = (x: Series): Series => x.map((_, i) => (i >= disp ? x[i - disp] : null));
  return { tenkan, kijun, spanA: shift(a), spanB: shift(b) };
}
