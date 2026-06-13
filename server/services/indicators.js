// Pure-JS technical indicators. All functions return arrays aligned with the
// input (null during the warm-up period) so they can be drawn on the chart.

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  // signal = EMA of the macd line over its non-null span
  const start = line.findIndex((v) => v != null);
  const signal = new Array(closes.length).fill(null);
  if (start >= 0) {
    const seg = ema(line.slice(start), signalPeriod);
    for (let i = 0; i < seg.length; i++) signal[start + i] = seg[i];
  }
  const histogram = line.map((v, i) =>
    v != null && signal[i] != null ? v - signal[i] : null
  );
  return { line, signal, histogram };
}

// Wilder's ATR
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    );
  }
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i + 1] = prev;
  }
  return out;
}

function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((a, v) => a + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, mid, lower };
}

// Most recent swing high/low over a lookback window, ignoring the last
// `skip` candles (still forming).
function swingLevels(candles, lookback = 20, skip = 1) {
  const end = candles.length - skip;
  const start = Math.max(0, end - lookback);
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i < end; i++) {
    if (candles[i].high > high) high = candles[i].high;
    if (candles[i].low < low) low = candles[i].low;
  }
  return { swingHigh: high, swingLow: low };
}

// Stochastic oscillator. Defaults give the "8 3 3" slow stochastic:
// %K over kPeriod, smoothed by kSmooth (SMA), %D = SMA of %K over dPeriod.
function stochastic(candles, kPeriod = 8, kSmooth = 3, dPeriod = 3) {
  const n = candles.length;
  const rawK = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    rawK[i] = hh === ll ? 50 : (100 * (candles[i].close - ll)) / (hh - ll);
  }
  const sma = (arr, p) => {
    const out = new Array(arr.length).fill(null);
    let sum = 0, count = 0;
    const window = [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] == null) { window.length = 0; sum = 0; count = 0; continue; }
      window.push(arr[i]); sum += arr[i]; count++;
      if (window.length > p) { sum -= window.shift(); count--; }
      if (count === p) out[i] = sum / p;
    }
    return out;
  };
  const k = sma(rawK, kSmooth); // slowed %K
  const d = sma(k, dPeriod);    // %D
  return { k, d };
}

// Support / resistance via fractal pivots, clustered into price levels.
// Returns levels sorted by distance to the latest close, split into
// support (below price) and resistance (above price).
function supportResistance(candles, { left = 3, right = 3, maxLevels = 4 } = {}) {
  const n = candles.length;
  if (n < left + right + 1) return { support: [], resistance: [] };
  const price = candles[n - 1].close;
  const pivots = [];
  for (let i = left; i < n - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) pivots.push(candles[i].high);
    if (isLow) pivots.push(candles[i].low);
  }
  if (!pivots.length) return { support: [], resistance: [] };

  // cluster pivots that sit within ~0.6% of each other into one level
  const tol = price * 0.006;
  pivots.sort((a, b) => a - b);
  const clusters = [];
  let group = [pivots[0]];
  for (let i = 1; i < pivots.length; i++) {
    if (pivots[i] - group[group.length - 1] <= tol) group.push(pivots[i]);
    else { clusters.push(group); group = [pivots[i]]; }
  }
  clusters.push(group);

  const minBand = price * 0.0015; // floor so a thin cluster still draws a visible box
  const levels = clusters.map((g) => {
    const lo = Math.min(...g);
    const hi = Math.max(...g);
    const mid = g.reduce((a, b) => a + b, 0) / g.length;
    const pad = Math.max(minBand - (hi - lo), 0) / 2;
    return {
      price: mid,
      strength: g.length,    // how many pivots reinforce this level
      lo: lo - pad,          // zone band (for drawing S/R as a box, not just a line)
      hi: hi + pad,
    };
  });

  const support = levels
    .filter((l) => l.price < price)
    .sort((a, b) => b.price - a.price) // nearest below first
    .slice(0, maxLevels);
  const resistance = levels
    .filter((l) => l.price >= price)
    .sort((a, b) => a.price - b.price) // nearest above first
    .slice(0, maxLevels);
  return { support, resistance };
}

module.exports = { sma, ema, rsi, macd, atr, bollinger, swingLevels, stochastic, supportResistance };
