// ML alpha model: predict next-hour perp returns from engineered features.
// Two models, trained from scratch per request (no libraries):
//   1. Ridge regression (closed-form) — linear baseline
//   2. Gradient-boosted regression stumps — XGBoost-style additive trees,
//      depth-1, squared loss, shrinkage + feature subsampling
// Evaluation is walk-forward: train on the first 70% of history, report ONLY
// out-of-sample metrics on the last 30% (IC, hit rate, cost-adjusted Sharpe).
// No survivorship, no lookahead: features at t use bars ≤ t, label is t→t+1.
const data = require('./data');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))) || 1e-9; };

/* ---------- feature engineering ---------- */
const FEATURES = [
  'ret1', 'ret3', 'ret6', 'ret12', 'ret24',   // lagged returns
  'rsi14', 'volRatio', 'volume z', 'ma24 dist', 'ma96 dist',
  'range', 'hour sin', 'hour cos', 'ret std24',
];

function buildDataset(candles) {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const r1 = new Array(n).fill(0);
  for (let i = 1; i < n; i++) r1[i] = Math.log(closes[i] / closes[i - 1]);

  const X = [], y = [], times = [];
  for (let t = 100; t < n - 1; t++) {
    const retN = (k) => Math.log(closes[t] / closes[t - k]);
    // RSI(14)
    let up = 0, dn = 0;
    for (let i = t - 13; i <= t; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) up += d; else dn -= d; }
    const rsi = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
    // realized vol ratio (24h vs 96h) — regime feature
    const s24 = std(r1.slice(t - 23, t + 1)), s96 = std(r1.slice(t - 95, t + 1));
    // volume z-score vs trailing 96 bars
    const vols = candles.slice(t - 95, t + 1).map((c) => c.volume);
    const vz = (candles[t].volume - mean(vols)) / (std(vols) || 1);
    // MA distances
    const ma = (k) => mean(closes.slice(t - k + 1, t + 1));
    const hour = new Date(candles[t].time * 1000).getUTCHours();

    X.push([
      r1[t], retN(3), retN(6), retN(12), retN(24),
      (rsi - 50) / 50, s24 / (s96 || 1e-9) - 1, Math.max(-4, Math.min(4, vz)),
      closes[t] / ma(24) - 1, closes[t] / ma(96) - 1,
      (candles[t].high - candles[t].low) / closes[t],
      Math.sin((2 * Math.PI * hour) / 24), Math.cos((2 * Math.PI * hour) / 24),
      s24,
    ]);
    y.push(r1[t + 1]); // next-bar return — the thing we're paid to predict
    times.push(candles[t].time);
  }
  return { X, y, times };
}

/* ---------- ridge regression (normal equations + Gaussian elimination) ---------- */
function ridgeFit(X, y, lambda = 1e-4) {
  const n = X.length, d = X[0].length + 1; // +intercept
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const xi = [1, ...X[i]];
    for (let j = 0; j < d; j++) {
      b[j] += xi[j] * y[i];
      for (let k = j; k < d; k++) A[j][k] += xi[j] * xi[k];
    }
  }
  for (let j = 0; j < d; j++) { for (let k = 0; k < j; k++) A[j][k] = A[k][j]; A[j][j] += lambda * n; }
  // solve A w = b
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    const diag = A[col][col] || 1e-12;
    for (let r = col + 1; r < d; r++) {
      const f = A[r][col] / diag;
      for (let k = col; k < d; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  const w = new Array(d).fill(0);
  for (let r = d - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < d; k++) s -= A[r][k] * w[k];
    w[r] = s / (A[r][r] || 1e-12);
  }
  return (x) => w[0] + x.reduce((s, xi, i) => s + w[i + 1] * xi, 0);
}

/* ---------- gradient-boosted stumps (squared loss) ---------- */
function boostFit(X, y, { rounds = 80, lr = 0.1, featureFrac = 0.7, thresholds = 16 } = {}) {
  const n = X.length, d = X[0].length;
  const f0 = mean(y);
  const F = new Array(n).fill(f0);
  const stumps = [];
  const gain = new Array(d).fill(0);

  // pre-compute candidate thresholds per feature (quantiles)
  const cand = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((x) => x[j]).sort((a, b) => a - b);
    const th = [];
    for (let q = 1; q < thresholds; q++) th.push(col[Math.floor((q / thresholds) * n)]);
    cand.push([...new Set(th)]);
  }

  for (let m = 0; m < rounds; m++) {
    const resid = y.map((yi, i) => yi - F[i]);
    const baseSSE = resid.reduce((s, r) => s + r * r, 0);
    let best = null;
    for (let j = 0; j < d; j++) {
      if (Math.random() > featureFrac) continue; // column subsampling
      for (const thr of cand[j]) {
        let sL = 0, nL = 0, sR = 0, nR = 0;
        for (let i = 0; i < n; i++) {
          if (X[i][j] <= thr) { sL += resid[i]; nL++; } else { sR += resid[i]; nR++; }
        }
        if (nL < 20 || nR < 20) continue;
        const gainJT = (sL * sL) / nL + (sR * sR) / nR; // SSE reduction
        if (!best || gainJT > best.gain) best = { j, thr, vL: sL / nL, vR: sR / nR, gain: gainJT };
      }
    }
    if (!best || best.gain < baseSSE * 1e-6) break;
    stumps.push(best);
    gain[best.j] += best.gain;
    for (let i = 0; i < n; i++) F[i] += lr * (X[i][best.j] <= best.thr ? best.vL : best.vR);
  }

  const predict = (x) => {
    let f = f0;
    for (const s of stumps) f += lr * (x[s.j] <= s.thr ? s.vL : s.vR);
    return f;
  };
  return { predict, gain, nStumps: stumps.length };
}

/* ---------- evaluation ---------- */
function evaluate(preds, actual, times, costBps = 2) {
  const n = preds.length;
  // IC = Pearson corr(pred, actual)
  const mp = mean(preds), ma = mean(actual);
  let num = 0, dp = 0, da = 0;
  for (let i = 0; i < n; i++) { num += (preds[i] - mp) * (actual[i] - ma); dp += (preds[i] - mp) ** 2; da += (actual[i] - ma) ** 2; }
  const ic = num / (Math.sqrt(dp * da) || 1e-12);
  const hit = mean(preds.map((p, i) => (Math.sign(p) === Math.sign(actual[i]) ? 1 : 0)));

  // strategy: position = sign(pred) scaled by conviction, taker cost on turnover
  const sp = std(preds);
  let pos = 0, equity = 1;
  const curve = [], strat = [];
  for (let i = 0; i < n; i++) {
    const newPos = Math.max(-1, Math.min(1, preds[i] / (2 * sp)));
    const cost = Math.abs(newPos - pos) * (costBps / 10000);
    pos = newPos;
    const r = pos * actual[i] - cost;
    strat.push(r);
    equity *= 1 + r;
    curve.push({ time: times[i], value: +equity.toFixed(5) });
  }
  const annFactor = Math.sqrt(24 * 365);
  const sharpe = (mean(strat) / (std(strat) || 1e-9)) * annFactor;

  // buy & hold on the same window for comparison
  let bh = 1;
  const bhCurve = actual.map((r, i) => { bh *= 1 + r; return { time: times[i], value: +bh.toFixed(5) }; });

  return {
    ic: +ic.toFixed(4), hitRatePct: +(hit * 100).toFixed(2),
    oosSharpe: +sharpe.toFixed(2),
    totalReturnPct: +((equity - 1) * 100).toFixed(2),
    buyHoldPct: +((bh - 1) * 100).toFixed(2),
    bars: n, curve, bhCurve,
  };
}

/** Train + walk-forward evaluate both models for one symbol. */
async function run(binanceSymbol, interval = '1h') {
  const t0 = process.hrtime.bigint();
  const candles = await data.hourlyKlines(binanceSymbol, 1500);
  if (candles.length < 400) throw new Error(`not enough ${interval} history for ${binanceSymbol}`);
  const { X, y, times } = buildDataset(candles);

  const split = Math.floor(X.length * 0.7);
  const Xtr = X.slice(0, split), ytr = y.slice(0, split);
  const Xte = X.slice(split), yte = y.slice(split), tte = times.slice(split);

  const ridge = ridgeFit(Xtr, ytr);
  const boost = boostFit(Xtr, ytr);
  const ridgePreds = Xte.map(ridge);
  const boostPreds = Xte.map(boost.predict);

  const totalGain = boost.gain.reduce((s, g) => s + g, 0) || 1;
  const importance = FEATURES.map((name, j) => ({ name, pct: +((boost.gain[j] / totalGain) * 100).toFixed(1) }))
    .sort((a, b) => b.pct - a.pct);

  const computeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    symbol: binanceSymbol, interval,
    trainBars: split, testBars: Xte.length, features: FEATURES.length,
    boosted: { ...evaluate(boostPreds, yte, tte), nStumps: boost.nStumps },
    ridge: evaluate(ridgePreds, yte, tte),
    importance: importance.slice(0, 8),
    computeMs: +computeMs.toFixed(0),
    note: 'All metrics are OUT-OF-SAMPLE (last 30%, never seen in training), net of 2bps taker cost per position change. Crypto hourly alpha is weak — an honest OOS Sharpe here is usually 0-2, and it varies run to run with feature subsampling.',
  };
}

// Lightweight cached prediction for the quant trade signal (trains on all but
// the last bar, predicts the next one).
async function latestPrediction(binanceSymbol) {
  const candles = await data.hourlyKlines(binanceSymbol, 1000);
  const { X, y } = buildDataset(candles);
  if (X.length < 300) throw new Error('not enough data');
  const boost = boostFit(X.slice(0, -1), y.slice(0, -1), { rounds: 50 });
  const pred = boost.predict(X[X.length - 1]);
  const sp = std(X.map((_, i) => y[i]));
  return { pred, zPred: pred / (sp || 1e-9) };
}

module.exports = { run, latestPrediction };
