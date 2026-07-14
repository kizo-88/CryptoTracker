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

module.exports = { quantSignal };
