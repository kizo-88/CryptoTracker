// Multi-factor model over the perp universe: 7 factors (6 backtestable +
// funding carry, which has no history here). Cross-sectional z-scores, weekly
// rebalanced dollar-neutral long/short portfolio, and a backtest showing how
// the return stream changes as the user shifts factor exposures.
const data = require('./data');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))) || 1e-9; };

// winsorized cross-sectional z-score (±3σ) so one meme coin can't own the book
function zscores(vals) {
  const ok = vals.filter((v) => v != null && isFinite(v));
  if (ok.length < 5) return vals.map(() => 0);
  const m = mean(ok), s = std(ok);
  return vals.map((v) => (v == null || !isFinite(v) ? 0 : Math.max(-3, Math.min(3, (v - m) / s))));
}

/* ---- raw factor values for one asset at time index t (uses trailing data only) ---- */
function rawFactors(closes, returns, t) {
  const c = closes, r = returns;
  if (t < 210 || c[t] == null) return null;
  const ret = (from, to) => (c[t - to] != null && c[t - from] != null && c[t - from] > 0 ? c[t - to] / c[t - from] - 1 : null);

  // momentum: 120d→7d return (classic 12-1 style, skips the last week)
  const momentum = ret(120, 7);
  // short-term reversal: last-7d return, inverted
  const shortRev = ret(7, 0) != null ? -ret(7, 0) : null;
  // value proxy: discount to the 200d moving average (cheap vs its own trend)
  let ma200 = 0, n = 0;
  for (let i = t - 199; i <= t; i++) if (c[i] != null) { ma200 += c[i]; n++; }
  ma200 = n ? ma200 / n : null;
  const value = ma200 ? -(c[t] / ma200 - 1) : null;
  // quality: return stability = ann. Sharpe of trailing 90d daily returns
  const win = r.slice(t - 89, t + 1);
  const quality = win.length ? (mean(win) / (std(win) || 1e-9)) * Math.sqrt(365) : null;
  // low-vol: negative trailing 90d vol (bet against the casino)
  const lowvol = win.length ? -std(win) * Math.sqrt(365) : null;
  return { momentum, shortRev, value, quality, lowvol };
}

const BACKTESTABLE = ['momentum', 'shortRev', 'value', 'quality', 'lowvol', 'liquidity'];

/**
 * Backtest a factor blend. exposures = {momentum:1, value:0.5, ...} in [-1,1].
 * Weekly rebalance; weights ∝ combined z (demeaned → dollar-neutral), gross 1.
 */
async function backtest(exposures) {
  const { symbols, dates, closes, returns, T } = await data.getMatrix(170);
  const syms = symbols.map((s) => s.symbol);
  const active = BACKTESTABLE.filter((f) => Math.abs(exposures[f] || 0) > 1e-9);
  if (!active.length) throw new Error('set at least one factor exposure');

  const start = 215;                       // factor warm-up (200d MA + buffer)
  const portRets = [];                     // daily portfolio returns
  const rebalDates = [];
  let weights = null;
  let lastHoldings = { long: [], short: [] };

  for (let t = start; t < T; t++) {
    if ((t - start) % 5 === 0 || weights == null) {   // weekly rebalance
      // liquidity factor: static ln(quoteVolume) (no historical volume spine)
      const liq = zscores(symbols.map((s) => Math.log(s.quoteVolume || 1)));
      const perFactor = {};
      const raws = syms.map((sym) => rawFactors(closes[sym], returns[sym], t - 1)); // trailing data only
      for (const f of ['momentum', 'shortRev', 'value', 'quality', 'lowvol']) {
        perFactor[f] = zscores(raws.map((x) => (x ? x[f] : null)));
      }
      perFactor.liquidity = liq;

      const combined = syms.map((_, i) =>
        active.reduce((s, f) => s + (exposures[f] || 0) * perFactor[f][i], 0));
      // demean → dollar-neutral, scale to gross exposure 1
      const m = mean(combined);
      const centered = combined.map((x) => x - m);
      const gross = centered.reduce((s, x) => s + Math.abs(x), 0) || 1;
      weights = centered.map((x) => x / gross);
      rebalDates.push(dates[t]);

      const ranked = syms.map((sym, i) => ({ sym: symbols[i].base, w: weights[i] }))
        .sort((a, b) => b.w - a.w);
      lastHoldings = {
        long: ranked.slice(0, 8).map((x) => ({ sym: x.sym, w: +(x.w * 100).toFixed(2) })),
        short: ranked.slice(-8).reverse().map((x) => ({ sym: x.sym, w: +(x.w * 100).toFixed(2) })),
      };
    }
    let pr = 0;
    for (let i = 0; i < syms.length; i++) pr += weights[i] * (returns[syms[i]][t] || 0);
    portRets.push({ time: Math.floor(dates[t] / 1000), r: pr });
  }

  // stats + equity curve
  const rs = portRets.map((x) => x.r);
  const annRet = mean(rs) * 365;
  const annVol = std(rs) * Math.sqrt(365);
  const sharpe = annVol ? annRet / annVol : 0;
  let eq = 1, peak = 1, maxDD = 0;
  const curve = portRets.map((x) => {
    eq *= 1 + x.r;
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
    return { time: x.time, value: +eq.toFixed(5) };
  });

  return {
    exposures, nAssets: syms.length, days: rs.length, rebalances: rebalDates.length,
    stats: {
      annReturnPct: +(annRet * 100).toFixed(2),
      annVolPct: +(annVol * 100).toFixed(2),
      sharpe: +sharpe.toFixed(2),
      maxDrawdownPct: +(maxDD * 100).toFixed(2),
      totalReturnPct: +((eq - 1) * 100).toFixed(2),
    },
    curve, holdings: lastHoldings,
  };
}

/** Current factor snapshot + each factor's standalone backtest stats. */
async function overview() {
  const { symbols, closes, returns, T } = await data.getMatrix(170);
  const funding = await data.getFunding().catch(() => ({}));
  const syms = symbols.map((s) => s.symbol);

  const raws = syms.map((sym) => rawFactors(closes[sym], returns[sym], T - 1));
  const current = {};
  for (const f of ['momentum', 'shortRev', 'value', 'quality', 'lowvol']) {
    current[f] = zscores(raws.map((x) => (x ? x[f] : null)));
  }
  current.liquidity = zscores(symbols.map((s) => Math.log(s.quoteVolume || 1)));
  // carry: negative funding = you get PAID to be long the perp
  current.carry = zscores(syms.map((sym) => (funding[sym] != null ? -funding[sym] : null)));

  const table = syms.map((sym, i) => ({
    sym: symbols[i].base, sector: symbols[i].sector,
    momentum: +current.momentum[i].toFixed(2), shortRev: +current.shortRev[i].toFixed(2),
    value: +current.value[i].toFixed(2), quality: +current.quality[i].toFixed(2),
    lowvol: +current.lowvol[i].toFixed(2), liquidity: +current.liquidity[i].toFixed(2),
    carry: +current.carry[i].toFixed(2),
  }));

  // standalone stats per factor (each cached run is cheap after the matrix loads)
  const singles = {};
  for (const f of BACKTESTABLE) {
    try { singles[f] = (await backtest({ [f]: 1 })).stats; }
    catch { singles[f] = null; }
  }

  return {
    factors: [
      { id: 'momentum', name: 'MOMENTUM', desc: '120d→7d return (12-1 style)' },
      { id: 'value', name: 'VALUE', desc: 'discount to own 200d MA' },
      { id: 'quality', name: 'QUALITY', desc: 'return stability (90d Sharpe)' },
      { id: 'lowvol', name: 'LOW VOL', desc: 'negative 90d realized vol' },
      { id: 'shortRev', name: 'SHORT REV', desc: '1-week reversal' },
      { id: 'liquidity', name: 'LIQUIDITY', desc: 'ln 24h quote volume' },
      { id: 'carry', name: 'CARRY', desc: 'negative funding rate (current only — no history)' },
    ],
    singleFactorStats: singles,
    table: table.sort((a, b) => b.momentum - a.momentum),
  };
}

module.exports = { overview, backtest, BACKTESTABLE };
