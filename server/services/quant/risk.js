// Portfolio risk engine: historical + Cornish-Fisher VaR (95/99), expected
// shortfall, component VaR, and stress tests replaying historical crypto
// crashes (each asset shocked by its BTC beta × the scenario's BTC move).
const data = require('./data');
const optimizer = require('./optimizer');
const store = require('../store');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))) || 1e-9; };
const pct = (sorted, p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(p * sorted.length)))];

// historical crypto crash scenarios: BTC single-day/short-window shocks
const SCENARIOS = [
  { name: 'COVID crash (12 Mar 2020)', btcShock: -0.39 },
  { name: 'May 2021 deleveraging (19 May 2021)', btcShock: -0.30 },
  { name: 'LUNA/UST collapse week (May 2022)', btcShock: -0.25 },
  { name: 'FTX collapse (Nov 2022)', btcShock: -0.22 },
  { name: 'Aug 2024 yen-carry unwind (5 Aug 2024)', btcShock: -0.15 },
  { name: 'Feb 2025 tariff shock', btcShock: -0.12 },
  { name: 'Mild correction', btcShock: -0.08 },
];

async function analyze(basis = 'optimized', notionalUsd = 10000) {
  const { symbols, returns } = await data.getMatrix(170);
  const syms = symbols.map((s) => s.symbol);
  const window = 250;

  /* ----- resolve portfolio weights from the requested basis ----- */
  let weights = {};
  let basisLabel = basis;
  if (basis === 'optimized') {
    weights = (await optimizer.optimize({})).weights;
    basisLabel = 'max-Sharpe optimized portfolio';
  } else if (basis === 'positions') {
    // map current open crypto positions (signed, margin-weighted, leveraged)
    const s = store.load();
    let gross = 0;
    for (const p of s.positions) {
      const notional = p.usdt * (p.leverage || 1) * (p.side === 'SHORT' ? -1 : 1);
      const sym = p.binanceSymbol;
      if (syms.includes(sym)) { weights[sym] = (weights[sym] || 0) + notional; gross += Math.abs(notional); }
    }
    if (!gross) throw new Error('no open positions map to the perp universe — open a trade or pick another basis');
    for (const k of Object.keys(weights)) weights[k] /= gross;
    basisLabel = `current open positions (${s.positions.length})`;
  } else {
    for (const sym of syms.slice(0, 30)) weights[sym] = 1 / 30;
    basisLabel = 'equal-weight top 30';
  }

  const active = syms.filter((s) => Math.abs(weights[s] || 0) > 1e-9);

  /* ----- historical portfolio return series ----- */
  const T = window;
  const portRets = new Array(T).fill(0);
  for (const sym of active) {
    const r = returns[sym].slice(-T);
    for (let t = 0; t < T; t++) portRets[t] += (weights[sym] || 0) * (r[t] || 0);
  }

  const sorted = [...portRets].sort((a, b) => a - b);
  const var95 = -pct(sorted, 0.05), var99 = -pct(sorted, 0.01);
  const tail99 = sorted.slice(0, Math.max(1, Math.floor(0.01 * T)));
  const tail95 = sorted.slice(0, Math.max(1, Math.floor(0.05 * T)));
  const es99 = -mean(tail99), es95 = -mean(tail95);

  // Cornish-Fisher parametric VaR (adjusts the normal quantile for skew/kurtosis)
  const m = mean(portRets), s = std(portRets);
  const skew = mean(portRets.map((x) => ((x - m) / s) ** 3));
  const kurt = mean(portRets.map((x) => ((x - m) / s) ** 4)) - 3;
  const zcf = (z) => z + (z * z - 1) * skew / 6 + z * (z * z - 3) * kurt / 24 - (2 * z ** 3 - 5 * z) * skew * skew / 36;
  const var99cf = -(m + zcf(-2.326) * s);

  /* ----- BTC betas → stress scenarios ----- */
  const btcR = returns['BTCUSDT'] ? returns['BTCUSDT'].slice(-T) : portRets;
  const mb = mean(btcR), vb = std(btcR) ** 2;
  const betas = {};
  for (const sym of active) {
    const r = returns[sym].slice(-T);
    let cov = 0;
    for (let t = 0; t < T; t++) cov += (r[t] - mean(r)) * (btcR[t] - mb);
    betas[sym] = cov / T / (vb || 1e-12);
  }
  const stress = SCENARIOS.map((sc) => {
    let loss = 0;
    for (const sym of active) {
      // beta-scaled shock, capped at −95% (an alt can't lose more than everything)
      const shock = Math.max(-0.95, betas[sym] * sc.btcShock);
      loss += (weights[sym] || 0) * shock;
    }
    return { ...sc, portLossPct: +(loss * 100).toFixed(1), portLossUsd: +(loss * notionalUsd).toFixed(0) };
  });

  /* ----- component VaR (Euler allocation, top contributors) ----- */
  const contrib = active.map((sym) => {
    const r = returns[sym].slice(-T);
    let cov = 0;
    const mr = mean(r);
    for (let t = 0; t < T; t++) cov += (r[t] - mr) * (portRets[t] - m);
    cov /= T;
    return { sym: data.baseOf(sym), weightPct: +((weights[sym] || 0) * 100).toFixed(1), cvarPct: +(((weights[sym] * cov) / (s * s || 1e-12)) * var99 * 100).toFixed(2) };
  }).sort((a, b) => Math.abs(b.cvarPct) - Math.abs(a.cvarPct)).slice(0, 12);

  // return histogram for the chart
  const lo = sorted[0], hi = sorted[sorted.length - 1];
  const nb = 30, bw = (hi - lo) / nb || 1;
  const hist = Array.from({ length: nb }, (_, i) => ({
    lo: +(lo + i * bw).toFixed(4),
    count: portRets.filter((x) => x >= lo + i * bw && x < lo + (i + 1) * bw).length,
  }));

  return {
    basis: basisLabel, nAssets: active.length, window: T, notionalUsd,
    var: {
      hist95Pct: +(var95 * 100).toFixed(2), hist99Pct: +(var99 * 100).toFixed(2),
      cf99Pct: +(var99cf * 100).toFixed(2),
      es95Pct: +(es95 * 100).toFixed(2), es99Pct: +(es99 * 100).toFixed(2),
      var99Usd: +(var99 * notionalUsd).toFixed(0), es99Usd: +(es99 * notionalUsd).toFixed(0),
      var99_10dPct: +(var99 * Math.sqrt(10) * 100).toFixed(2), // √t scaling
      skew: +skew.toFixed(2), excessKurtosis: +kurt.toFixed(2),
    },
    annVolPct: +(s * Math.sqrt(365) * 100).toFixed(1),
    stress, componentVar: contrib, histogram: hist,
    note: 'Historical VaR from the last 250 daily returns. Cornish-Fisher adjusts the parametric 99% quantile for the fat tails crypto actually has (see excess kurtosis). Stress = per-asset BTC-beta × scenario shock.',
  };
}

module.exports = { analyze };
