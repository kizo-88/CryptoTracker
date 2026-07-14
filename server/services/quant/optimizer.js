// Constrained portfolio optimizer over the full 100+ asset perp universe.
// Maximizes Sharpe via projected gradient ascent on w with:
//   Σw = 1 (fully invested) · 0 ≤ w_i ≤ maxWeight (long-only, concentration cap)
//   Σ_{i∈sector} w_i ≤ sectorCap · turnover penalty vs equal-weight
// μ uses shrunk momentum estimates; Σ uses Ledoit-Wolf-style shrinkage toward
// the diagonal (a raw 100×100 sample cov from 250 obs is garbage — shrinkage
// is what makes the optimization numerically sane).
const data = require('./data');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

function covMatrix(retCols, shrink = 0.4) {
  const N = retCols.length, T = retCols[0].length;
  const mu = retCols.map(mean);
  const S = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (retCols[i][t] - mu[i]) * (retCols[j][t] - mu[j]);
      S[i][j] = S[j][i] = s / (T - 1);
    }
  }
  // shrink toward diagonal: Σ* = (1−δ)S + δ·diag(S)  (keeps Σ well-conditioned)
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) S[i][j] *= 1 - shrink;
  return S;
}

const matVec = (A, x) => A.map((row) => row.reduce((s, a, j) => s + a * x[j], 0));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/* project onto { 0 ≤ w ≤ cap, Σw = 1, sector sums ≤ sectorCap } by alternating
   clip → sector scale-down → renormalize. Approximate but converges in practice. */
function project(w, cap, sectors, sectorCap) {
  const N = w.length;
  for (let pass = 0; pass < 12; pass++) {
    for (let i = 0; i < N; i++) w[i] = Math.max(0, Math.min(cap, w[i]));
    // sector caps
    const bySector = {};
    for (let i = 0; i < N; i++) (bySector[sectors[i]] ||= []).push(i);
    for (const idxs of Object.values(bySector)) {
      const s = idxs.reduce((a, i) => a + w[i], 0);
      if (s > sectorCap && s > 0) for (const i of idxs) w[i] *= sectorCap / s;
    }
    // renormalize to Σw = 1 by distributing the shortfall to non-capped names
    const total = w.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) < 1e-6) break;
    if (total > 0) {
      const free = [];
      for (let i = 0; i < N; i++) if (w[i] < cap - 1e-9) free.push(i);
      const deficit = 1 - total;
      if (!free.length) { for (let i = 0; i < N; i++) w[i] /= total; break; }
      const bump = deficit / free.length;
      for (const i of free) w[i] += bump;
    } else {
      for (let i = 0; i < N; i++) w[i] = 1 / N;
    }
  }
  return w;
}

/**
 * opts: { maxWeightPct=10, sectorCapPct=30, turnoverPenalty=0.5, riskAversion }
 */
async function optimize(opts = {}) {
  const t0 = process.hrtime.bigint();
  const maxW = Math.max(0.01, Math.min(1, (+opts.maxWeightPct || 10) / 100));
  const sectorCap = Math.max(maxW, Math.min(1, (+opts.sectorCapPct || 30) / 100));
  // note: +x ?? y is (+x) ?? y — NaN slips through ??, so coerce carefully
  const tPenRaw = +(opts.turnoverPenalty ?? 0.5);
  const tPen = Number.isFinite(tPenRaw) ? Math.max(0, tPenRaw) : 0.5;

  const { symbols, returns } = await data.getMatrix(170);
  const syms = symbols.map((s) => s.symbol);
  const N = syms.length;
  const window = 250;
  const cols = syms.map((s) => returns[s].slice(-window));

  // expected returns: momentum (120d ann.) shrunk 50% toward the cross-sectional
  // mean, then winsorized to the 5th–95th percentile — one meme coin with a
  // ±500% annualized print would otherwise own the gradient normalization
  const rawMu = cols.map((c) => mean(c.slice(-120)) * 365);
  const muBar = mean(rawMu);
  const shrunk = rawMu.map((m) => 0.5 * m + 0.5 * muBar);
  const sortedMu = [...shrunk].sort((a, b) => a - b);
  const q05 = sortedMu[Math.floor(0.05 * N)], q95 = sortedMu[Math.floor(0.95 * N)];
  const mu = shrunk.map((m) => Math.max(q05, Math.min(q95, m)));
  const Sigma = covMatrix(cols).map((row) => row.map((x) => x * 365)); // annualized

  const w0 = new Array(N).fill(1 / N); // turnover benchmark = equal weight
  const sectors = symbols.map((s) => s.sector);

  // Mean-variance solve for one risk aversion λ: projected gradient ascent on
  // μ'w − λ·w'Σw − turnover penalty. Concave QP — no degenerate regime, unlike
  // raw Sharpe ascent which seeks max-vol books whenever μ'w < 0.
  const solveMV = (lam) => {
    let w = [...w0];
    for (let it = 0; it < 400; it++) {
      const Sw = matVec(Sigma, w);
      let g = w.map((_, i) => mu[i] - 2 * lam * Sw[i] - tPen * Math.sign(w[i] - w0[i]) * 0.01);
      // center to sum-zero: steps stay on the Σw=1 plane, so the common-mode
      // −2λΣw drift can't collapse the whole vector into the w≥0 clip
      const gm = g.reduce((s, x) => s + x, 0) / N;
      g = g.map((x) => x - gm);
      // robust step scale: 90th-percentile |g|, so a single outlier gradient
      // can't freeze every other name's updates
      const absSorted = g.map(Math.abs).sort((a, b) => a - b);
      const gscale = Math.max(absSorted[Math.floor(0.9 * N)], 1e-9);
      w = project(w.map((x, i) => x + (0.008 / gscale) * Math.max(-3 * gscale, Math.min(3 * gscale, g[i]))), maxW, sectors, sectorCap);
    }
    const vol = Math.sqrt(Math.max(dot(w, matVec(Sigma, w)), 1e-12));
    const ret = dot(w, mu);
    return { w, vol, ret, sharpe: ret / vol };
  };

  // trace the efficient frontier, then take the tangency (max-Sharpe) point
  const LAMBDAS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
  const solved = LAMBDAS.map(solveMV);
  const frontier = solved.map((s) => ({ volPct: +(s.vol * 100).toFixed(1), retPct: +(s.ret * 100).toFixed(1) }));
  const best = solved.reduce((a, b) => (b.sharpe > a.sharpe + 1e-9 || (Math.abs(b.sharpe - a.sharpe) <= 1e-9 && b.vol < a.vol) ? b : a));
  const { w, vol, ret } = best;

  const turnover = w.reduce((s, x, i) => s + Math.abs(x - w0[i]), 0) / 2;
  const effN = 1 / w.reduce((s, x) => s + x * x, 0);

  const bySector = {};
  symbols.forEach((s, i) => { bySector[s.sector] = (bySector[s.sector] || 0) + w[i]; });

  const holdings = symbols
    .map((s, i) => ({ sym: s.base, sector: s.sector, weightPct: +(w[i] * 100).toFixed(2), muPct: +(mu[i] * 100).toFixed(1) }))
    .filter((h) => h.weightPct >= 0.05)
    .sort((a, b) => b.weightPct - a.weightPct);

  return {
    nAssets: N, window,
    constraints: { maxWeightPct: maxW * 100, sectorCapPct: sectorCap * 100, turnoverPenalty: tPen, longOnly: true },
    stats: {
      expReturnPct: +(ret * 100).toFixed(1), expVolPct: +(vol * 100).toFixed(1),
      sharpe: +(ret / (vol || 1e-9)).toFixed(2),
      effectiveN: +effN.toFixed(1), nHoldings: holdings.length,
      turnoverVsEqualPct: +(turnover * 100).toFixed(1),
    },
    holdings: holdings.slice(0, 30),
    weights: Object.fromEntries(syms.map((s, i) => [s, w[i]])), // full vector for the risk engine
    sectorBreakdown: Object.entries(bySector).map(([sector, wgt]) => ({ sector, pct: +(wgt * 100).toFixed(1) })).sort((a, b) => b.pct - a.pct),
    frontier,
    computeMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0),
  };
}

module.exports = { optimize };
