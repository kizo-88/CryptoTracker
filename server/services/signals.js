// Signal engine: scores trend + momentum + volatility off the candles and
// produces a LONG/SHORT/NEUTRAL call with ATR-based entry / stop-loss /
// take-profit levels, plus human-readable reasoning.
const { ema, rsi, macd, atr, bollinger, swingLevels, stochastic, supportResistance } = require('./indicators');
const { smcZones } = require('./smc');

const MAX_SCORE = 7;

function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function round(v, ref) {
  if (v == null || !isFinite(v)) return null;
  // sensible decimals based on price magnitude
  const p = ref ?? v;
  const dp = p >= 1000 ? 2 : p >= 1 ? 4 : 8;
  return +v.toFixed(dp);
}

function buildSignal(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const rsi5arr = rsi(closes, 5);
  const { line: macdLine, signal: macdSignal, histogram } = macd(closes);
  const atr14 = atr(candles, 14);
  const bb = bollinger(closes, 20, 2);
  const { swingHigh, swingLow } = swingLevels(candles, 20, 1);
  const stoch = stochastic(candles, 8, 3, 3); // %K(8) smoothed 3, %D 3
  const sr = supportResistance(candles, { left: 3, right: 3, maxLevels: 4 });

  const v = {
    price,
    ema20: last(ema20),
    ema50: last(ema50),
    ema200: last(ema200),
    rsi: last(rsi14),
    rsi5: last(rsi5arr),
    macdLine: last(macdLine),
    macdSignal: last(macdSignal),
    macdHist: last(histogram),
    atr: last(atr14),
    bbUpper: last(bb.upper),
    bbMid: last(bb.mid),
    bbLower: last(bb.lower),
    swingHigh,
    swingLow,
    stochK: last(stoch.k),
    stochD: last(stoch.d),
  };

  let score = 0;
  const reasons = [];

  // --- Trend ---
  if (v.ema200 != null) {
    if (price > v.ema200) { score += 1.5; reasons.push(`Price above EMA200 — long-term uptrend`); }
    else { score -= 1.5; reasons.push(`Price below EMA200 — long-term downtrend`); }
  }
  if (v.ema50 != null && v.ema200 != null) {
    if (v.ema50 > v.ema200) { score += 1; reasons.push(`EMA50 above EMA200 (golden alignment)`); }
    else { score -= 1; reasons.push(`EMA50 below EMA200 (bearish alignment)`); }
  }
  if (v.ema20 != null) {
    if (price > v.ema20) { score += 0.5; reasons.push(`Price above EMA20 — short-term momentum up`); }
    else { score -= 0.5; reasons.push(`Price below EMA20 — short-term momentum down`); }
  }

  // --- Momentum ---
  if (v.rsi != null) {
    if (v.rsi > 70) { score += 0.25; reasons.push(`RSI ${v.rsi.toFixed(1)} — overbought, trend strong but stretched`); }
    else if (v.rsi > 55) { score += 1; reasons.push(`RSI ${v.rsi.toFixed(1)} — bullish momentum`); }
    else if (v.rsi < 30) { score -= 0.25; reasons.push(`RSI ${v.rsi.toFixed(1)} — oversold, possible bounce zone`); }
    else if (v.rsi < 45) { score -= 1; reasons.push(`RSI ${v.rsi.toFixed(1)} — bearish momentum`); }
    else { reasons.push(`RSI ${v.rsi.toFixed(1)} — neutral zone`); }
  }
  if (v.macdHist != null) {
    if (v.macdHist > 0) { score += 1; reasons.push(`MACD histogram positive — bullish momentum building`); }
    else { score -= 1; reasons.push(`MACD histogram negative — bearish momentum building`); }
  }
  if (v.macdLine != null && v.macdSignal != null) {
    if (v.macdLine > v.macdSignal) { score += 0.5; reasons.push(`MACD line above signal line`); }
    else { score -= 0.5; reasons.push(`MACD line below signal line`); }
  }

  // --- Fast momentum: RSI(5) with 10 / 90 bands ---
  if (v.rsi5 != null) {
    if (v.rsi5 >= 90) { score += 0.25; reasons.push(`RSI(5) ${v.rsi5.toFixed(1)} — above 90, very overbought (stretched)`); }
    else if (v.rsi5 > 50) { score += 0.5; reasons.push(`RSI(5) ${v.rsi5.toFixed(1)} — fast momentum up`); }
    else if (v.rsi5 <= 10) { score -= 0.25; reasons.push(`RSI(5) ${v.rsi5.toFixed(1)} — below 10, very oversold (bounce watch)`); }
    else { score -= 0.5; reasons.push(`RSI(5) ${v.rsi5.toFixed(1)} — fast momentum down`); }
  }

  // --- Stochastic (8,3,3) with 20 / 80 bands ---
  if (v.stochK != null && v.stochD != null) {
    const cross = v.stochK > v.stochD ? 'bull' : 'bear';
    if (v.stochK >= 80) { score += 0.25; reasons.push(`Stoch %K ${v.stochK.toFixed(1)} — overbought (>80)`); }
    else if (v.stochK <= 20) { score -= 0.25; reasons.push(`Stoch %K ${v.stochK.toFixed(1)} — oversold (<20)`); }
    if (cross === 'bull') { score += 0.5; reasons.push(`Stoch %K above %D — bullish cross`); }
    else { score -= 0.5; reasons.push(`Stoch %K below %D — bearish cross`); }
  }

  // --- Volatility context (doesn't move score, informs the reader) ---
  if (v.bbUpper != null && price > v.bbUpper) reasons.push(`Price outside upper Bollinger band — extended, pullback risk`);
  if (v.bbLower != null && price < v.bbLower) reasons.push(`Price outside lower Bollinger band — extended, bounce risk`);

  score = Math.round(score * 100) / 100;
  const direction = score >= 2 ? 'LONG' : score <= -2 ? 'SHORT' : 'NEUTRAL';
  const confidence = Math.min(95, Math.round((Math.abs(score) / MAX_SCORE) * 100));
  const lean = score >= 0 ? 'LONG' : 'SHORT';

  // --- Levels (ATR + swing based) ---
  // Stop sits at the swing level when it's reasonable, but is clamped to a
  // 1.5–3 ATR band so a distant swing in a fast trend can't blow up the risk
  // (which previously produced negative take-profit prices on shorts).
  const atrVal = v.atr ?? price * 0.02;
  const entry = price;
  let stopLoss;
  let takeProfits = [];
  if (lean === 'LONG') {
    const swingStop = v.swingLow ?? price - 1.5 * atrVal;
    stopLoss = Math.min(Math.max(swingStop, price - 3 * atrVal), price - 1.5 * atrVal);
    const risk = entry - stopLoss;
    takeProfits = [
      { label: 'TP1', price: entry + 1.5 * risk, r: 1.5 },
      { label: 'TP2', price: entry + 2.5 * risk, r: 2.5 },
      { label: 'TP3', price: entry + 4 * risk, r: 4 },
    ];
  } else {
    const swingStop = v.swingHigh ?? price + 1.5 * atrVal;
    stopLoss = Math.max(Math.min(swingStop, price + 3 * atrVal), price + 1.5 * atrVal);
    const risk = stopLoss - entry;
    takeProfits = [
      { label: 'TP1', price: entry - 1.5 * risk, r: 1.5 },
      { label: 'TP2', price: entry - 2.5 * risk, r: 2.5 },
      { label: 'TP3', price: entry - 4 * risk, r: 4 },
    ].map((tp) => ({ ...tp, price: Math.max(tp.price, entry * 0.05) })); // price can't go below zero
  }

  if (direction === 'NEUTRAL') {
    reasons.push(`Net score ${score} is inside the neutral band (−2…+2) — levels shown are for the ${lean} lean; wait for confirmation`);
  }

  const times = candles.map((c) => c.time);
  const seriesOf = (arr) =>
    arr.map((val, i) => (val != null ? { time: times[i], value: round(val, price) } : null)).filter(Boolean);
  // oscillators live on a fixed 0–100 scale, so round to 2dp (not price-relative)
  const oscSeriesOf = (arr) =>
    arr.map((val, i) => (val != null ? { time: times[i], value: +val.toFixed(2) } : null)).filter(Boolean);

  // round a SMC / S/R zone band's prices for the wire
  const roundZone = (z) => ({ ...z, top: round(z.top, price), bottom: round(z.bottom, price) });
  const zones = smcZones(candles);

  return {
    direction,
    lean,
    score,
    confidence,
    entry: round(entry, price),
    stopLoss: round(stopLoss, price),
    takeProfits: takeProfits.map((tp) => ({ ...tp, price: round(tp.price, price) })),
    riskPct: round((Math.abs(entry - stopLoss) / entry) * 100, 100),
    indicators: {
      rsi: v.rsi != null ? +v.rsi.toFixed(1) : null,
      rsi5: v.rsi5 != null ? +v.rsi5.toFixed(1) : null,
      stochK: v.stochK != null ? +v.stochK.toFixed(1) : null,
      stochD: v.stochD != null ? +v.stochD.toFixed(1) : null,
      macdLine: round(v.macdLine, price),
      macdSignal: round(v.macdSignal, price),
      macdHist: round(v.macdHist, price),
      atr: round(v.atr, price),
      ema20: round(v.ema20, price),
      ema50: round(v.ema50, price),
      ema200: round(v.ema200, price),
      bbUpper: round(v.bbUpper, price),
      bbLower: round(v.bbLower, price),
      swingHigh: round(swingHigh, price),
      swingLow: round(swingLow, price),
    },
    levels: {
      support: sr.support.map((l) => ({ price: round(l.price, price), strength: l.strength, lo: round(l.lo, price), hi: round(l.hi, price) })),
      resistance: sr.resistance.map((l) => ({ price: round(l.price, price), strength: l.strength, lo: round(l.lo, price), hi: round(l.hi, price) })),
    },
    // Smart-Money zones drawn as boxes on the chart (Order Blocks, FVGs, Inverse FVGs)
    zones: {
      ob: zones.ob.map(roundZone),
      fvg: zones.fvg.map(roundZone),
      ifvg: zones.ifvg.map(roundZone),
    },
    reasons,
    overlays: {
      ema20: seriesOf(ema20),
      ema50: seriesOf(ema50),
      ema200: seriesOf(ema200),
    },
    // time-series for the visual oscillator panels (RSI, Stochastic)
    osc: {
      rsi: oscSeriesOf(rsi14),
      stochK: oscSeriesOf(stoch.k),
      stochD: oscSeriesOf(stoch.d),
    },
  };
}

module.exports = { buildSignal };
