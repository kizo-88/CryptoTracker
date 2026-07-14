// Statistical-arbitrage backtester at scale: every pair from the top-60 perps
// (C(60,2) = 1,770 strategies). Per pair: OLS hedge ratio on log prices,
// Dickey-Fuller t-stat on the spread (cointegration screen), then a z-score
// mean-reversion backtest with costs. The point isn't the top strategy — it's
// the DISTRIBUTION: with 1,770 tries, the expected best Sharpe under pure
// noise is ~sqrt(2·ln N) ≈ 3.9, so anything below that ceiling is suspect.
const data = require('./data');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))) || 1e-9; };

/* OLS y = a + b x */
function ols(y, x) {
  const mx = mean(x), my = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  const b = num / (den || 1e-12);
  return { a: my - b * mx, b };
}

/* Dickey-Fuller t-stat on spread e: Δe_t = α + ρ·e_{t−1} + ε. t(ρ) < −3 ⇒ mean-reverting */
function dfStat(e) {
  const n = e.length - 1;
  const de = [], lag = [];
  for (let i = 1; i < e.length; i++) { de.push(e[i] - e[i - 1]); lag.push(e[i - 1]); }
  const { a, b } = ols(de, lag);
  let sse = 0, sxx = 0;
  const ml = mean(lag);
  for (let i = 0; i < n; i++) { const res = de[i] - a - b * lag[i]; sse += res * res; sxx += (lag[i] - ml) ** 2; }
  const se = Math.sqrt(sse / (n - 2) / (sxx || 1e-12)) || 1e-12;
  return { t: b / se, rho: b };
}

/* z-score mean-reversion backtest on one pair; costs = bps per leg per trade */
function backtestPair(pa, pb, costBps = 4) {
  const la = pa.map(Math.log), lb = pb.map(Math.log);
  const { b: beta } = ols(la, lb);
  const spread = la.map((v, i) => v - beta * lb[i]);
  const { t: adfT, rho } = dfStat(spread);
  const halfLife = rho < 0 && rho > -1 ? Math.log(2) / -Math.log(1 + rho) : Infinity;

  const LOOK = 60;
  let pos = 0, trades = 0;
  const rets = [];
  for (let t = LOOK; t < spread.length - 1; t++) {
    const win = spread.slice(t - LOOK, t);
    const z = (spread[t] - mean(win)) / (std(win) || 1e-9);
    let newPos = pos;
    if (pos === 0) { if (z > 2) newPos = -1; else if (z < -2) newPos = 1; }
    else if (Math.abs(z) < 0.5 || Math.abs(z) > 4) newPos = 0;   // take profit or bail (structural break)
    const cost = newPos !== pos ? (2 * costBps) / 10000 : 0;      // two legs
    if (newPos !== pos) trades++;
    pos = newPos;
    // spread return ≈ Δ(log a − β·log b); position sized to gross 1
    const dr = (la[t + 1] - la[t] - beta * (lb[t + 1] - lb[t])) / (1 + Math.abs(beta));
    rets.push(pos * dr - cost);
  }
  const sharpe = (mean(rets) / (std(rets) || 1e-9)) * Math.sqrt(365);
  let eq = 1;
  const curve = rets.map((r) => (eq *= 1 + r));
  return { beta: +beta.toFixed(3), adfT: +adfT.toFixed(2), halfLife: isFinite(halfLife) ? +halfLife.toFixed(1) : null, sharpe: +sharpe.toFixed(2), trades, totalPct: +((eq - 1) * 100).toFixed(2), spread, curve: null };
}

/** Sweep all pairs. Cached 6h — ~1,770 backtests take a couple of seconds. */
async function sweep(nAssets = 60) {
  const t0 = process.hrtime.bigint();
  const { symbols, closes, T } = await data.getMatrix(170);
  const usable = symbols
    .filter((s) => closes[s.symbol].slice(-250).every((c) => c != null))
    .slice(0, nAssets);

  const px = {};
  for (const s of usable) px[s.symbol] = closes[s.symbol].slice(-250);

  const results = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i], b = usable[j];
      const r = backtestPair(px[a.symbol], px[b.symbol]);
      results.push({ a: a.base, b: b.base, symA: a.symbol, symB: b.symbol, beta: r.beta, adfT: r.adfT, halfLife: r.halfLife, sharpe: r.sharpe, trades: r.trades, totalPct: r.totalPct });
    }
  }

  const n = results.length;
  const sharpes = results.map((r) => r.sharpe);
  // histogram
  const bins = [];
  for (let lo = -4; lo < 4; lo += 0.5) {
    bins.push({ lo, hi: lo + 0.5, count: sharpes.filter((s) => s >= lo && s < lo + 0.5).length });
  }
  // E[max] of N ~N(0, se²) Sharpe estimates; se(SR) ≈ sqrt(1/years), here ~0.75y of live window
  const years = 190 / 365;
  const noiseCeiling = Math.sqrt(2 * Math.log(n)) * Math.sqrt(1 / years);

  const cointegrated = results.filter((r) => r.adfT < -3);
  const top = [...results].sort((a, b) => b.sharpe - a.sharpe).slice(0, 15);
  const topCoint = [...cointegrated].sort((a, b) => b.sharpe - a.sharpe).slice(0, 15);

  return {
    nStrategies: n, nAssets: usable.length, window: 250,
    cointegratedCount: cointegrated.length,
    noiseCeiling: +noiseCeiling.toFixed(2),
    meanSharpe: +mean(sharpes).toFixed(2), stdSharpe: +std(sharpes).toFixed(2),
    histogram: bins,
    topAll: top, topCointegrated: topCoint,
    computeMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0),
    note: `With ${n} strategies tested, the expected MAX Sharpe from pure noise is ≈ ${noiseCeiling.toFixed(1)}. Only pairs that clear BOTH the cointegration screen (ADF t < −3) and a Sharpe above the noise ceiling deserve attention — that filter is the whole job.`,
  };
}

/** Spread + z-score series for one pair (for the detail chart). */
async function pairDetail(symA, symB) {
  const { symbols, closes, dates } = await data.getMatrix(170);
  const a = closes[symA], b = closes[symB];
  if (!a || !b) throw new Error('pair not in universe');
  const pa = a.slice(-250), pb = b.slice(-250), dt = dates.slice(-250);
  const la = pa.map(Math.log), lb = pb.map(Math.log);
  const { b: beta } = ols(la, lb);
  const spread = la.map((v, i) => v - beta * lb[i]);
  const LOOK = 60;
  const series = [];
  for (let t = LOOK; t < spread.length; t++) {
    const win = spread.slice(t - LOOK, t);
    series.push({ time: Math.floor(dt[t] / 1000), z: +((spread[t] - mean(win)) / (std(win) || 1e-9)).toFixed(3) });
  }
  const baseA = symbols.find((s) => s.symbol === symA)?.base || symA;
  const baseB = symbols.find((s) => s.symbol === symB)?.base || symB;
  return { a: baseA, b: baseB, beta: +beta.toFixed(3), series };
}

module.exports = { sweep, pairDetail };
