// The classic strategies: textbook systems with their usual defaults. Each one turns closed candles into a target position
// per bar (−1 short, 0 flat, +1 long; the grid holds a fraction in 0..1). The target decided at the close of bar i is traded at
// the open of bar i + 1 by the backtester and the runner, so no strategy ever sees the bar it trades on.
import type { Candle, Tf } from "./data";
import { atr, bollinger, dmi, donchian, ema, ichimoku, kama, macd, psar, rsi, sma, stochastic, supertrend, type Series } from "./indicators";

export type Params = Record<string, number>;
export interface ParamSpec { key: string; label: string; min: number; max: number; step: number; default: number }
export interface SignalCtx { fundingAnnualPct: Series; /** the bar whose close centres the grid (the backtest: the bar before the window; default 0) */ anchor?: number }
export interface ClassicStrategy {
  id: string; title: string; line: string; tf: Tf; days: number;
  /** "both" = can short (perps); "long" = long only */
  sides: "both" | "long";
  needsFunding?: boolean;
  /** holds a share of the size (0..1 in steps) instead of ±1: resized, not flipped */
  fractional?: boolean;
  /** state starts at a bar (the backtest: the last close before the window; the agent: its creation bar), passed as ctx.anchor */
  anchored?: boolean;
  params: ParamSpec[];
  /** bars a fresh signal needs before it means anything */
  warmup: (p: Params) => number;
  signal: (bars: Candle[], p: Params, ctx: SignalCtx) => (number | null)[];
  /** the rule in words, for the agent page and the fill's "why" */
  rule: (p: Params) => string;
}

const SHORTS: ParamSpec = { key: "shorts", label: "Shorts (1 = on)", min: 0, max: 1, step: 1, default: 1 };
const closes = (b: Candle[]) => b.map((x) => x.c);
const has = (...v: (number | null | undefined)[]) => v.every((x) => x != null && Number.isFinite(x));
const short = (p: Params) => (p.shorts ? -1 : 0);

/** A stateful long / short machine: enter and exit tests per bar, the position carried forward. */
function machine(n: number, ready: (i: number) => boolean, step: (i: number, pos: number) => number): (number | null)[] {
  const out: (number | null)[] = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    if (!ready(i)) { out.push(null); continue; }
    pos = step(i, pos);
    out.push(pos);
  }
  return out;
}

export const CLASSIC: ClassicStrategy[] = [
  {
    id: "golden-cross", title: "Golden cross", line: "Long while the 50-bar average is above the 200-bar average; short below it.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "fast", label: "Fast SMA", min: 5, max: 100, step: 1, default: 50 }, { key: "slow", label: "Slow SMA", min: 20, max: 400, step: 5, default: 200 }, SHORTS],
    warmup: (p) => p.slow,
    signal: (b, p) => { const f = sma(closes(b), p.fast), s = sma(closes(b), p.slow); return b.map((_, i) => (has(f[i], s[i]) ? ((f[i] as number) > (s[i] as number) ? 1 : short(p)) : null)); },
    rule: (p) => `SMA ${p.fast} above SMA ${p.slow} = long${p.shorts ? ", below = short" : ", below = flat"}`,
  },
  {
    id: "ema-cross", title: "EMA cross", line: "The fast trend follower: long while EMA 12 is above EMA 26, short below.", tf: "1h", days: 365, sides: "both",
    params: [{ key: "fast", label: "Fast EMA", min: 3, max: 50, step: 1, default: 12 }, { key: "slow", label: "Slow EMA", min: 10, max: 200, step: 1, default: 26 }, SHORTS],
    warmup: (p) => p.slow,
    signal: (b, p) => { const f = ema(closes(b), p.fast), s = ema(closes(b), p.slow); return b.map((_, i) => (has(f[i], s[i]) ? ((f[i] as number) > (s[i] as number) ? 1 : short(p)) : null)); },
    rule: (p) => `EMA ${p.fast} above EMA ${p.slow} = long${p.shorts ? ", below = short" : ", below = flat"}`,
  },
  {
    id: "rsi-reversion", title: "RSI reversion", line: "Buy the oversold dip (RSI under 30) and sell the overbought rip (over 70); out at 50.", tf: "1h", days: 365, sides: "both",
    params: [{ key: "period", label: "RSI period", min: 2, max: 50, step: 1, default: 14 }, { key: "lower", label: "Oversold", min: 5, max: 45, step: 1, default: 30 }, { key: "upper", label: "Overbought", min: 55, max: 95, step: 1, default: 70 }, { key: "exit", label: "Exit at", min: 30, max: 70, step: 1, default: 50 }, SHORTS],
    warmup: (p) => p.period + 1,
    signal: (b, p) => {
      const r = rsi(closes(b), p.period);
      return machine(b.length, (i) => has(r[i]), (i, pos) => {
        const v = r[i] as number;
        if (pos > 0 && v >= p.exit) pos = 0;
        if (pos < 0 && v <= p.exit) pos = 0;
        if (pos === 0 && v < p.lower) pos = 1;
        else if (pos === 0 && v > p.upper && p.shorts) pos = -1;
        return pos;
      });
    },
    rule: (p) => `RSI ${p.period} under ${p.lower} = long${p.shorts ? `, over ${p.upper} = short` : ""}; out when it crosses ${p.exit}`,
  },
  {
    id: "bollinger-reversion", title: "Bollinger reversion", line: "Fade a close outside the 2σ band, take profit back at the middle.", tf: "1h", days: 365, sides: "both",
    params: [{ key: "n", label: "Period", min: 5, max: 100, step: 1, default: 20 }, { key: "k", label: "Width (σ)", min: 1, max: 4, step: 0.1, default: 2 }, SHORTS],
    warmup: (p) => p.n,
    signal: (b, p) => {
      const c = closes(b), bb = bollinger(c, p.n, p.k);
      return machine(b.length, (i) => has(bb.mid[i]), (i, pos) => {
        const m = bb.mid[i] as number;
        if (pos > 0 && c[i] >= m) pos = 0;
        if (pos < 0 && c[i] <= m) pos = 0;
        if (pos === 0 && c[i] < (bb.lower[i] as number)) pos = 1;
        else if (pos === 0 && c[i] > (bb.upper[i] as number) && p.shorts) pos = -1;
        return pos;
      });
    },
    rule: (p) => `close under the lower ${p.k}σ band (${p.n}) = long${p.shorts ? ", over the upper band = short" : ""}; out at the middle band`,
  },
  {
    id: "bollinger-breakout", title: "Bollinger squeeze breakout", line: "After the bands squeeze tight, ride the close that breaks out of them.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "n", label: "Period", min: 5, max: 100, step: 1, default: 20 }, { key: "k", label: "Width (σ)", min: 1, max: 4, step: 0.1, default: 2 }, { key: "squeeze", label: "Squeeze (lowest %)", min: 5, max: 50, step: 1, default: 20 }, { key: "lookback", label: "Squeeze lookback", min: 30, max: 300, step: 10, default: 120 }, SHORTS],
    warmup: (p) => p.n + p.lookback,
    signal: (b, p) => {
      const c = closes(b), bb = bollinger(c, p.n, p.k);
      const tight = (i: number) => {
        const w = bb.width[i - 1]; if (w == null) return false;
        const hist = bb.width.slice(i - p.lookback, i).filter((x): x is number => x != null);
        if (hist.length < p.lookback * 0.8) return false;
        return hist.filter((x) => x <= w).length / hist.length <= p.squeeze / 100;
      };
      return machine(b.length, (i) => i > p.lookback && has(bb.mid[i]), (i, pos) => {
        const m = bb.mid[i] as number;
        if (pos > 0 && c[i] < m) pos = 0;
        if (pos < 0 && c[i] > m) pos = 0;
        if (pos === 0 && tight(i)) {
          if (c[i] > (bb.upper[i] as number)) pos = 1;
          else if (c[i] < (bb.lower[i] as number) && p.shorts) pos = -1;
        }
        return pos;
      });
    },
    rule: (p) => `band width in its lowest ${p.squeeze}% of ${p.lookback} bars, then a close outside the ${p.k}σ band = enter that way; out at the middle band`,
  },
  {
    id: "macd-cross", title: "MACD cross", line: "Long when MACD crosses above its signal line, short when it crosses below.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "fast", label: "Fast", min: 3, max: 30, step: 1, default: 12 }, { key: "slow", label: "Slow", min: 10, max: 60, step: 1, default: 26 }, { key: "signal", label: "Signal", min: 3, max: 30, step: 1, default: 9 }, SHORTS],
    warmup: (p) => p.slow + p.signal,
    signal: (b, p) => { const m = macd(closes(b), p.fast, p.slow, p.signal); return b.map((_, i) => (has(m.macd[i], m.signal[i]) ? ((m.macd[i] as number) > (m.signal[i] as number) ? 1 : short(p)) : null)); },
    rule: (p) => `MACD (${p.fast}, ${p.slow}, ${p.signal}) above its signal = long${p.shorts ? ", below = short" : ", below = flat"}`,
  },
  {
    id: "donchian", title: "Donchian breakout (Turtle)", line: "The Turtle rule: buy a new 20-bar high, sell a new 10-bar low.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "entry", label: "Entry channel", min: 5, max: 100, step: 1, default: 20 }, { key: "exit", label: "Exit channel", min: 2, max: 60, step: 1, default: 10 }, SHORTS],
    warmup: (p) => Math.max(p.entry, p.exit) + 1,
    signal: (b, p) => {
      const h = b.map((x) => x.h), l = b.map((x) => x.l), c = closes(b), en = donchian(h, l, p.entry), ex = donchian(h, l, p.exit);
      return machine(b.length, (i) => has(en.upper[i], ex.lower[i]), (i, pos) => {
        if (pos > 0 && c[i] < (ex.lower[i] as number)) pos = 0;
        if (pos < 0 && c[i] > (ex.upper[i] as number)) pos = 0;
        if (pos <= 0 && c[i] > (en.upper[i] as number)) pos = 1;
        else if (pos >= 0 && c[i] < (en.lower[i] as number) && p.shorts) pos = -1;
        return pos;
      });
    },
    rule: (p) => `close above the ${p.entry}-bar high = long, below the ${p.exit}-bar low = out${p.shorts ? `; mirror for shorts` : ""}`,
  },
  {
    id: "supertrend", title: "Supertrend", line: "Follow the ATR band: long above it, short below it.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "n", label: "ATR period", min: 3, max: 50, step: 1, default: 10 }, { key: "mult", label: "Multiplier", min: 1, max: 6, step: 0.5, default: 3 }, SHORTS],
    warmup: (p) => p.n,
    signal: (b, p) => { const st = supertrend(b.map((x) => x.h), b.map((x) => x.l), closes(b), p.n, p.mult); return st.dir.map((d) => (d == null ? null : d === 1 ? 1 : short(p))); },
    rule: (p) => `Supertrend (ATR ${p.n} × ${p.mult}) up = long${p.shorts ? ", down = short" : ", down = flat"}`,
  },
  {
    id: "funding-carry", title: "Funding carry", line: "Take the side the crowd pays for: short when longs pay over 15% a year, long when shorts do.", tf: "1h", days: 365, sides: "both", needsFunding: true,
    params: [{ key: "threshold", label: "Funding (% a year)", min: 5, max: 200, step: 5, default: 15 }, SHORTS],
    warmup: () => 1,
    signal: (b, p, ctx) => machine(b.length, (i) => has(ctx.fundingAnnualPct[i]), (i, pos) => {
      const f = ctx.fundingAnnualPct[i] as number, half = p.threshold / 2;
      if (pos < 0 && f < half) pos = 0;
      if (pos > 0 && f > -half) pos = 0;
      if (pos === 0 && f > p.threshold && p.shorts) pos = -1;
      else if (pos === 0 && f < -p.threshold) pos = 1;
      return pos;
    }),
    rule: (p) => `24 h average funding above +${p.threshold}% a year = ${p.shorts ? "short" : "flat"}, below −${p.threshold}% = long; out when it falls back inside ±${p.threshold / 2}%`,
  },
  {
    id: "grid", title: "Grid", line: "Buy every step down and sell every step up inside a ±10% range around the start price.", tf: "1h", days: 365, sides: "long", fractional: true, anchored: true,
    params: [{ key: "range", label: "Range (± %)", min: 2, max: 50, step: 1, default: 10 }, { key: "levels", label: "Levels", min: 2, max: 40, step: 1, default: 10 }],
    warmup: () => 1,
    signal: (b, p, ctx) => {
      if (!b.length) return [];
      const a = Math.max(0, Math.min(b.length - 1, Math.floor(ctx?.anchor ?? 0)));
      const start = b[a].c, hi = start * (1 + p.range / 100), lo = start * (1 - p.range / 100), step = 1 / p.levels;
      return b.map((x, i) => { if (i < a) return null; const f = Math.max(0, Math.min(1, (hi - x.c) / (hi - lo))); return Math.floor(f / step + 1e-9) * step; });
    },
    rule: (p) => `${p.levels} levels from −${p.range}% to +${p.range}% of the start price: each level down adds 1/${p.levels} of the size, each level up sells it`,
  },
  // ── quant classics ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "tsmom", title: "Time-series momentum", line: "The managed-futures rule: long while the price is above where it was a lookback ago, short while below.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "lookback", label: "Lookback (bars)", min: 10, max: 500, step: 1, default: 120 }, SHORTS],
    warmup: (p) => p.lookback + 1,
    signal: (b, p) => { const c = closes(b); return b.map((_, i) => (i < p.lookback ? null : c[i] > c[i - p.lookback] ? 1 : c[i] < c[i - p.lookback] ? short(p) : 0)); },
    rule: (p) => `close above the close ${p.lookback} bars ago = long${p.shorts ? ", below = short" : ", below = flat"}`,
  },
  {
    id: "keltner", title: "Keltner breakout", line: "Ride a close outside the ATR channel around the 20 EMA; out back at the EMA.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "n", label: "EMA period", min: 5, max: 100, step: 1, default: 20 }, { key: "atrN", label: "ATR period", min: 3, max: 50, step: 1, default: 10 }, { key: "mult", label: "Width (× ATR)", min: 0.5, max: 5, step: 0.5, default: 2 }, SHORTS],
    warmup: (p) => Math.max(p.n, p.atrN),
    signal: (b, p) => {
      const c = closes(b), mid = ema(c, p.n), a = atr(b.map((x) => x.h), b.map((x) => x.l), c, p.atrN);
      return machine(b.length, (i) => has(mid[i], a[i]), (i, pos) => {
        const m = mid[i] as number, w = p.mult * (a[i] as number);
        if (pos > 0 && c[i] < m) pos = 0;
        if (pos < 0 && c[i] > m) pos = 0;
        if (pos <= 0 && c[i] > m + w) pos = 1;
        else if (pos >= 0 && c[i] < m - w && p.shorts) pos = -1;
        return pos;
      });
    },
    rule: (p) => `close above EMA ${p.n} + ${p.mult} × ATR ${p.atrN} = long${p.shorts ? ", below EMA − the same = short" : ""}; out at the EMA`,
  },
  {
    id: "ichimoku", title: "Ichimoku cloud", line: "Long above the cloud with tenkan over kijun, short below it with tenkan under; out on a close through the kijun.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "tenkan", label: "Tenkan", min: 5, max: 30, step: 1, default: 9 }, { key: "kijun", label: "Kijun", min: 10, max: 60, step: 1, default: 26 }, { key: "senkou", label: "Senkou B", min: 20, max: 120, step: 1, default: 52 }, SHORTS],
    warmup: (p) => p.senkou + p.kijun,
    signal: (b, p) => {
      const c = closes(b), ic = ichimoku(b.map((x) => x.h), b.map((x) => x.l), p.tenkan, p.kijun, p.senkou, p.kijun);
      return machine(b.length, (i) => has(ic.tenkan[i], ic.kijun[i], ic.spanA[i], ic.spanB[i]), (i, pos) => {
        const t = ic.tenkan[i] as number, k = ic.kijun[i] as number, top = Math.max(ic.spanA[i] as number, ic.spanB[i] as number), bot = Math.min(ic.spanA[i] as number, ic.spanB[i] as number);
        if (pos > 0 && c[i] < k) pos = 0;
        if (pos < 0 && c[i] > k) pos = 0;
        if (pos === 0 && c[i] > top && t > k) pos = 1;
        else if (pos === 0 && c[i] < bot && t < k && p.shorts) pos = -1;
        return pos;
      });
    },
    rule: (p) => `close above the cloud (${p.tenkan}, ${p.kijun}, ${p.senkou}) with tenkan over kijun = long${p.shorts ? ", below it with tenkan under = short" : ""}; out on a close through the kijun`,
  },
  {
    id: "psar", title: "Parabolic SAR", line: "Wilder's stop-and-reverse: long while price is above the trailing stop, short while below.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "step", label: "Acceleration step", min: 0.01, max: 0.1, step: 0.01, default: 0.02 }, { key: "max", label: "Acceleration cap", min: 0.1, max: 0.5, step: 0.05, default: 0.2 }, SHORTS],
    warmup: () => 2,
    signal: (b, p) => psar(b.map((x) => x.h), b.map((x) => x.l), p.step, p.max).dir.map((d) => (d == null ? null : d === 1 ? 1 : short(p))),
    rule: (p) => `Parabolic SAR (${p.step} step, ${p.max} cap) below price = long${p.shorts ? ", above = short" : ", above = flat"}`,
  },
  {
    id: "adx", title: "ADX trend", line: "Trade only strong trends: ADX over 25 takes the side of the stronger DI; out when ADX fades under 20 or the DIs cross.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "n", label: "Period", min: 5, max: 50, step: 1, default: 14 }, { key: "enter", label: "ADX to enter", min: 10, max: 50, step: 1, default: 25 }, { key: "exit", label: "ADX to exit", min: 5, max: 45, step: 1, default: 20 }, SHORTS],
    warmup: (p) => 2 * p.n,
    signal: (b, p) => {
      const d = dmi(b.map((x) => x.h), b.map((x) => x.l), closes(b), p.n);
      return machine(b.length, (i) => has(d.adx[i], d.plus[i], d.minus[i]), (i, pos) => {
        const a = d.adx[i] as number, up = d.plus[i] as number, dn = d.minus[i] as number;
        if (pos > 0 && (a < p.exit || dn > up)) pos = 0;
        if (pos < 0 && (a < p.exit || up > dn)) pos = 0;
        if (pos === 0 && a >= p.enter) { if (up > dn) pos = 1; else if (dn > up && p.shorts) pos = -1; }
        return pos;
      });
    },
    rule: (p) => `ADX (${p.n}) at ${p.enter} or more with +DI over −DI = long${p.shorts ? ", −DI over +DI = short" : ""}; out under ${p.exit} or when the DIs cross`,
  },
  {
    id: "connors-rsi2", title: "Connors RSI-2", line: "Larry Connors' pullback rule: buy a 2-period RSI under 10 above the 200 average, sell when the close clears the 5 average.", tf: "1h", days: 365, sides: "both",
    params: [{ key: "low", label: "RSI-2 to buy", min: 1, max: 30, step: 1, default: 10 }, { key: "high", label: "RSI-2 to short", min: 70, max: 99, step: 1, default: 90 }, { key: "trend", label: "Trend average", min: 50, max: 300, step: 10, default: 200 }, { key: "exit", label: "Exit average", min: 2, max: 20, step: 1, default: 5 }, SHORTS],
    warmup: (p) => p.trend,
    signal: (b, p) => {
      const c = closes(b), r = rsi(c, 2), tr = sma(c, p.trend), ex = sma(c, p.exit);
      return machine(b.length, (i) => has(r[i], tr[i], ex[i]), (i, pos) => {
        if (pos > 0 && c[i] > (ex[i] as number)) pos = 0;
        if (pos < 0 && c[i] < (ex[i] as number)) pos = 0;
        if (pos === 0 && c[i] > (tr[i] as number) && (r[i] as number) < p.low) pos = 1;
        else if (pos === 0 && c[i] < (tr[i] as number) && (r[i] as number) > p.high && p.shorts) pos = -1;
        return pos;
      });
    },
    rule: (p) => `above SMA ${p.trend} with RSI-2 under ${p.low} = long, out on a close over SMA ${p.exit}${p.shorts ? `; under SMA ${p.trend} with RSI-2 over ${p.high} = short, out under SMA ${p.exit}` : ""}`,
  },
  {
    id: "stochastic", title: "Stochastic cross", line: "Buy %K crossing up through %D in oversold territory, sell the cross down in overbought.", tf: "1h", days: 365, sides: "both",
    params: [{ key: "n", label: "%K period", min: 5, max: 50, step: 1, default: 14 }, { key: "smooth", label: "%K smoothing", min: 1, max: 10, step: 1, default: 3 }, { key: "d", label: "%D period", min: 1, max: 10, step: 1, default: 3 }, { key: "low", label: "Oversold", min: 5, max: 40, step: 1, default: 20 }, { key: "high", label: "Overbought", min: 60, max: 95, step: 1, default: 80 }, SHORTS],
    warmup: (p) => p.n + p.smooth + p.d,
    signal: (b, p) => {
      const st = stochastic(b.map((x) => x.h), b.map((x) => x.l), closes(b), p.n, p.smooth, p.d);
      return machine(b.length, (i) => i > 0 && has(st.k[i], st.d[i], st.k[i - 1], st.d[i - 1]), (i, pos) => {
        const k0 = st.k[i - 1] as number, d0 = st.d[i - 1] as number, k = st.k[i] as number, d = st.d[i] as number;
        if (k0 <= d0 && k > d && k0 < p.low) return 1;
        if (k0 >= d0 && k < d && k0 > p.high) return short(p);
        return pos;
      });
    },
    rule: (p) => `%K (${p.n}, ${p.smooth}) crossing above %D (${p.d}) from under ${p.low} = long; crossing below from over ${p.high} = ${p.shorts ? "short" : "flat"}`,
  },
  {
    id: "kama", title: "Kaufman adaptive MA", line: "Follow Kaufman's adaptive average: it speeds up in clean trends and stalls in chop, so it whipsaws less.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "n", label: "Efficiency period", min: 5, max: 50, step: 1, default: 10 }, { key: "fast", label: "Fast", min: 2, max: 10, step: 1, default: 2 }, { key: "slow", label: "Slow", min: 10, max: 100, step: 1, default: 30 }, { key: "band", label: "Band (%)", min: 0, max: 5, step: 0.25, default: 1 }, SHORTS],
    warmup: (p) => p.n + p.slow,
    signal: (b, p) => {
      const c = closes(b), k = kama(c, p.n, p.fast, p.slow);
      return machine(b.length, (i) => i >= p.n + p.slow && has(k[i]), (i, pos) => {
        const v = k[i] as number;
        if (c[i] > v * (1 + p.band / 100)) return 1;
        if (c[i] < v * (1 - p.band / 100)) return short(p);
        return pos;
      });
    },
    rule: (p) => `close ${p.band}% above KAMA (${p.n}, ${p.fast}, ${p.slow}) = long, ${p.band}% below = ${p.shorts ? "short" : "flat"}; inside the band, hold`,
  },
  {
    id: "triple-ma", title: "Triple moving average", line: "Long only when EMA 10, 30 and 100 line up upward, short when they line up downward, flat while they disagree.", tf: "4h", days: 730, sides: "both",
    params: [{ key: "fast", label: "Fast EMA", min: 3, max: 50, step: 1, default: 10 }, { key: "mid", label: "Middle EMA", min: 10, max: 150, step: 1, default: 30 }, { key: "slow", label: "Slow EMA", min: 30, max: 300, step: 1, default: 100 }, SHORTS],
    warmup: (p) => p.slow,
    signal: (b, p) => {
      const c = closes(b), f = ema(c, p.fast), m = ema(c, p.mid), s = ema(c, p.slow);
      return b.map((_, i) => {
        if (!has(f[i], m[i], s[i])) return null;
        const a = f[i] as number, bm = m[i] as number, z = s[i] as number;
        return a > bm && bm > z ? 1 : a < bm && bm < z ? short(p) : 0;
      });
    },
    rule: (p) => `EMA ${p.fast} > ${p.mid} > ${p.slow} = long${p.shorts ? `, ${p.fast} < ${p.mid} < ${p.slow} = short` : ""}; otherwise flat`,
  },
  {
    id: "grid-trailing", title: "Trailing grid", line: "A grid whose range follows the price: when a close leaves the ±10% band, the band re-centres there.", tf: "1h", days: 365, sides: "long", fractional: true, anchored: true,
    params: [{ key: "range", label: "Range (± %)", min: 2, max: 50, step: 1, default: 10 }, { key: "levels", label: "Levels", min: 2, max: 40, step: 1, default: 10 }],
    warmup: () => 1,
    signal: (b, p, ctx) => {
      if (!b.length) return [];
      const a = Math.max(0, Math.min(b.length - 1, Math.floor(ctx?.anchor ?? 0))), step = 1 / p.levels, r = p.range / 100;
      let centre = b[a].c;
      return b.map((x, i) => {
        if (i < a) return null;
        if (x.c > centre * (1 + r) || x.c < centre * (1 - r)) centre = x.c; // out of the band: it moves to this close
        const hi = centre * (1 + r), lo = centre * (1 - r), f = Math.max(0, Math.min(1, (hi - x.c) / (hi - lo)));
        return Math.floor(f / step + 1e-9) * step;
      });
    },
    rule: (p) => `${p.levels} levels from −${p.range}% to +${p.range}% of a centre: each level down adds 1/${p.levels} of the size, each level up sells it; a close outside the band moves the centre to it (half the size held there, a loss below the band is taken)`,
  },
];

export const strategyById = (id: string) => CLASSIC.find((s) => s.id === id) ?? null;

export class ClassicInputError extends Error {}
/** Params with defaults filled and every value inside its range (a value outside says which and why). */
export function paramsFor(s: ClassicStrategy, raw: unknown): Params {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Params = {};
  for (const k of Object.keys(o)) if (!s.params.some((p) => p.key === k)) throw new ClassicInputError(`${s.title} has no parameter "${k}"`);
  for (const p of s.params) {
    const v = o[p.key] === undefined || o[p.key] === null || o[p.key] === "" ? p.default : Number(o[p.key]);
    if (!Number.isFinite(v) || v < p.min || v > p.max) throw new ClassicInputError(`${p.label}: must be a number from ${p.min} to ${p.max}`);
    out[p.key] = p.step >= 1 ? Math.round(v) : v;
  }
  if ("fast" in out && "slow" in out && out.fast >= out.slow) throw new ClassicInputError("the fast average must be shorter than the slow one");
  if ("mid" in out && "fast" in out && "slow" in out && !(out.fast < out.mid && out.mid < out.slow)) throw new ClassicInputError("the averages must run fast < middle < slow");
  if (s.id === "adx" && out.exit >= out.enter) throw new ClassicInputError("ADX to exit must be under ADX to enter");
  return out;
}
