// Quant-only trade signal — NO classic TA voting here. Ensemble of:
//   1. ML alpha (gradient-boosted stumps, next-hour return prediction)
//   2. Time-series momentum z (24h/168h)
//   3. Mean-reversion z (distance from 96h VWAP-ish mean, fades stretches)
// Direction = sign of blended score; SL/TP sized from ATR. The same shape as
// the TA signal so trading.open / the autotrader can consume it directly.
const { cached } = require('../cache');
const data = require('./data');
const ml = require('./ml');

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) * (x - m)))) || 1e-9; };

async function quantSignal(binanceSymbol) {
  return cached(`quant:signal:${binanceSymbol}`, 10 * 60_000, async () => {
    const candles = await data.hourlyKlines(binanceSymbol, 1000);
    if (candles.length < 400) throw new Error(`not enough history for ${binanceSymbol}`);
    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1];
    const r1 = [];
    for (let i = 1; i < closes.length; i++) r1.push(Math.log(closes[i] / closes[i - 1]));

    // 1) ML alpha
    let mlZ = 0;
    let mlOk = true;
    try { mlZ = Math.max(-3, Math.min(3, (await ml.latestPrediction(binanceSymbol)).zPred)); }
    catch { mlOk = false; }

    // 2) momentum: blended 24h + 168h return vs its own vol
    const sig24 = std(r1.slice(-24 * 30));
    const mom24 = Math.log(last / closes[closes.length - 25]) / (sig24 * Math.sqrt(24) || 1e-9);
    const mom168 = Math.log(last / closes[closes.length - 169]) / (sig24 * Math.sqrt(168) || 1e-9);
    const momZ = Math.max(-3, Math.min(3, 0.6 * mom24 + 0.4 * mom168));

    // 3) mean reversion: fade the stretch from the 96h mean
    const ma96 = mean(closes.slice(-96));
    const mrZ = Math.max(-3, Math.min(3, -((last / ma96 - 1) / (sig24 * Math.sqrt(48) || 1e-9))));

    // ensemble — ML carries the most weight when available
    const score = mlOk ? 0.5 * mlZ + 0.35 * momZ + 0.15 * mrZ : 0.7 * momZ + 0.3 * mrZ;
    const direction = score > 0.25 ? 'LONG' : score < -0.25 ? 'SHORT' : 'NEUTRAL';
    const confidence = Math.round(Math.min(95, 50 + Math.abs(score) * 18));

    // ATR(14) on 1h for level sizing
    let atr = 0;
    for (let i = candles.length - 14; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    atr /= 14;

    const dir = direction === 'SHORT' ? -1 : 1;
    const stopLoss = +(last - dir * 1.8 * atr).toFixed(6);
    const takeProfits = [
      { label: 'TP1', price: +(last + dir * 1.8 * atr).toFixed(6), r: 1 },
      { label: 'TP2', price: +(last + dir * 3.2 * atr).toFixed(6), r: 1.8 },
    ];

    return {
      symbol: binanceSymbol, engine: 'quant',
      direction, confidence,
      score: +score.toFixed(3),
      components: {
        ml: mlOk ? +mlZ.toFixed(2) : null,
        momentum: +momZ.toFixed(2),
        meanReversion: +mrZ.toFixed(2),
      },
      entry: last, stopLoss, takeProfits,
      atr: +atr.toFixed(6),
      at: new Date().toISOString(),
    };
  });
}

/**
 * Live SMA fast/slow crossover monitor — the strategy that won the XAUUSD
 * 3-month study (fast trend-following, long/short, ~1 flip/day on 1h bars).
 * Pure signal/telemetry: computes the current side, per-leg PnL history, and
 * whole-window stats net of 1bp/side. Executes nothing.
 */
async function crossoverMonitor(symbol, fast = 5, slow = 20) {
  fast = Math.max(2, Math.min(50, +fast || 5));
  slow = Math.max(fast + 1, Math.min(200, +slow || 20));
  return cached(`quant:xm:${symbol}:${fast}:${slow}`, 5 * 60_000, async () => {
    const candles = await data.hourlyKlines(symbol, 1500);
    const closes = candles.map((c) => c.close);
    const n = closes.length;
    if (n < slow + 20) throw new Error(`not enough hourly history for ${symbol}`);

    const smaArr = (p) => {
      const out = new Array(n).fill(null);
      let s = 0;
      for (let i = 0; i < n; i++) { s += closes[i]; if (i >= p) s -= closes[i - p]; if (i >= p - 1) out[i] = s / p; }
      return out;
    };
    const f = smaArr(fast), sl = smaArr(slow);

    const cost = 1 / 10000; // 1bp per side
    const flips = [];
    const rets = [];
    let pos = 0;
    for (let i = slow; i < n; i++) {
      const sig = f[i] > sl[i] ? 1 : -1;
      if (i < n - 1) rets.push(sig * (closes[i + 1] / closes[i] - 1) - Math.abs(sig - pos) * cost);
      if (sig !== pos) flips.push({ time: candles[i].time, side: sig === 1 ? 'LONG' : 'SHORT', price: closes[i] });
      pos = sig;
    }
    // per-leg PnL: flip price -> next flip price (last leg marks to the latest close)
    const legs = flips.map((fl, k) => {
      const exitP = k + 1 < flips.length ? flips[k + 1].price : closes[n - 1];
      const dir = fl.side === 'LONG' ? 1 : -1;
      return { ...fl, pnlPct: +((dir * (exitP / fl.price - 1)) * 100).toFixed(2), open: k === flips.length - 1 };
    });

    const days = (candles[n - 1].time - candles[0].time) / 86400;
    const barsPerYear = ((n - slow) / days) * 365;
    let eq = 1;
    for (const r of rets) eq *= 1 + r;
    const sharpe = (mean(rets) / (std(rets) || 1e-9)) * Math.sqrt(barsPerYear);
    const closedLegs = legs.filter((l) => !l.open);
    const cur = legs[legs.length - 1];

    return {
      symbol, fast, slow, bars: n, windowDays: +days.toFixed(0),
      current: cur ? { side: cur.side, since: cur.time, entry: cur.price, price: closes[n - 1], legPnlPct: cur.pnlPct } : null,
      stats: {
        totalPct: +((eq - 1) * 100).toFixed(2),
        sharpe: +sharpe.toFixed(2),
        flips: flips.length,
        hitPct: closedLegs.length ? +((closedLegs.filter((l) => l.pnlPct > 0).length / closedLegs.length) * 100).toFixed(0) : 0,
      },
      legs: legs.slice(-12).reverse(),
      note: 'Fast trend-following works in trending regimes and bleeds in chop — validated on one 3-month bear window only. Signals, not advice; nothing is executed.',
      at: new Date().toISOString(),
    };
  });
}

module.exports = { quantSignal, crossoverMonitor };
