// Smart-Money-Concepts zones: Fair Value Gaps (FVG), Inverse FVGs (IFVG) and
// Order Blocks (OB). Each zone is returned as a price band the frontend draws
// as a rectangle that extends to the right edge of the chart:
//   { kind: 'bull'|'bear', top, bottom, time }     // time = where the zone starts
//
// Heuristics are intentionally simple and robust (pure candle geometry) rather
// than a full ICT model — enough to highlight the imbalances on the chart.

// average candle body over the trailing `win` candles (excludes the candle itself)
function avgBody(candles, i, win = 10) {
  let sum = 0, n = 0;
  for (let j = Math.max(0, i - win); j < i; j++) {
    sum += Math.abs(candles[j].close - candles[j].open);
    n++;
  }
  return n ? sum / n : 0;
}

// 3-candle Fair Value Gaps. A bullish FVG is an up-gap where candle i's low sits
// above candle (i-2)'s high (the middle candle leaves an unfilled imbalance).
// We then track whether price has since traded back through it:
//   - mitigated: wick has tapped the gap
//   - inverted : a candle CLOSED through the far side → the gap flips polarity
//                and becomes an Inverse FVG (now acting as the opposite zone).
function fairValueGaps(candles) {
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    if (c.low > a.high) {
      fvgs.push({ kind: 'bull', bottom: a.high, top: c.low, time: candles[i - 1].time, idx: i });
    } else if (c.high < a.low) {
      fvgs.push({ kind: 'bear', bottom: c.high, top: a.low, time: candles[i - 1].time, idx: i });
    }
  }
  // classify each gap against the candles that came after it
  const fvg = [];   // still-valid (unfilled / lightly tapped) gaps
  const ifvg = [];  // gaps that were closed through and flipped polarity
  for (const g of fvgs) {
    let inverted = false, invTime = null;
    for (let k = g.idx + 1; k < candles.length; k++) {
      const cl = candles[k].close;
      if (g.kind === 'bull' && cl < g.bottom) { inverted = true; invTime = candles[k].time; break; }
      if (g.kind === 'bear' && cl > g.top) { inverted = true; invTime = candles[k].time; break; }
    }
    if (inverted) {
      // a bullish gap closed-through becomes a bearish (resistance) IFVG, & vice-versa
      ifvg.push({ kind: g.kind === 'bull' ? 'bear' : 'bull', top: g.top, bottom: g.bottom, time: invTime });
    } else {
      fvg.push({ kind: g.kind, top: g.top, bottom: g.bottom, time: g.time });
    }
  }
  return { fvg, ifvg };
}

// Order Blocks: the last opposite-colour candle right before a strong
// displacement move that breaks structure. A bullish OB is the last down candle
// before an up-candle whose body is unusually large and that closes above the
// previous high; the block is drawn from that down candle's low→high. Only
// blocks that price hasn't decisively closed back through are kept.
function orderBlocks(candles) {
  const bull = [], bear = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const body = Math.abs(c.close - c.open);
    const big = body > 1.5 * avgBody(candles, i);
    if (!big) continue;

    if (c.close > c.open && c.close > p.high) {
      // bullish displacement → find the last bearish candle before it
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (candles[j].close < candles[j].open) {
          bull.push({ kind: 'bull', bottom: candles[j].low, top: candles[j].high, time: candles[j].time, idx: j });
          break;
        }
      }
    } else if (c.close < c.open && c.close < p.low) {
      // bearish displacement → find the last bullish candle before it
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (candles[j].close > candles[j].open) {
          bear.push({ kind: 'bear', bottom: candles[j].low, top: candles[j].high, time: candles[j].time, idx: j });
          break;
        }
      }
    }
  }
  // keep only un-violated blocks (price hasn't closed beyond the far side)
  const valid = (ob) => {
    for (let k = ob.idx + 1; k < candles.length; k++) {
      const cl = candles[k].close;
      if (ob.kind === 'bull' && cl < ob.bottom) return false;
      if (ob.kind === 'bear' && cl > ob.top) return false;
    }
    return true;
  };
  const clean = (arr) =>
    arr.filter(valid)
      .filter((ob, idx, a) => a.findIndex((o) => o.time === ob.time) === idx) // dedupe
      .map(({ kind, top, bottom, time }) => ({ kind, top, bottom, time }));
  return [...clean(bull), ...clean(bear)];
}

// Build the SMC zone set for a candle series. Each list is capped to the most
// recent few so the chart stays readable.
function smcZones(candles, { maxFvg = 5, maxIfvg = 4, maxOb = 4 } = {}) {
  if (!candles || candles.length < 4) return { fvg: [], ifvg: [], ob: [] };
  const { fvg, ifvg } = fairValueGaps(candles);
  const ob = orderBlocks(candles);
  const recent = (arr, n) => arr.slice(-n);
  return {
    fvg: recent(fvg, maxFvg),
    ifvg: recent(ifvg, maxIfvg),
    ob: recent(ob, maxOb),
  };
}

module.exports = { smcZones };
