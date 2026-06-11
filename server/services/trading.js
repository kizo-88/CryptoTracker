// Position engine: paper trading (default, simulated fills against live
// prices) and live MEXC spot orders. Tracks open positions with SL/TP and
// closes them when levels are hit (used manually and by the auto-trader).
const crypto = require('crypto');
const store = require('./store');
const mexc = require('./mexc');

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDS', 'USDE', 'TUSD', 'PYUSD', 'USD1']);

function uid() {
  return crypto.randomBytes(5).toString('hex');
}

/**
 * Open a position. Paper mode supports LONG and SHORT; live mode is spot,
 * so LONG only (buy now, sell at SL/TP).
 */
async function open({ symbol, binanceSymbol, side, usdt, price, sl, tp, mode, source = 'manual' }) {
  const s = store.load();
  usdt = +usdt;
  price = +price;
  if (!usdt || usdt <= 0) throw new Error('trade amount (USDT) must be > 0');
  if (!price || price <= 0) throw new Error('no price for trade');
  if (!['LONG', 'SHORT'].includes(side)) throw new Error('side must be LONG or SHORT');
  if (STABLES.has(symbol)) throw new Error(`${symbol} is a stablecoin — nothing to trade`);
  if (mode === 'live' && side === 'SHORT') throw new Error('live trading is spot — LONG only (use paper mode to simulate shorts)');

  let fill = price;
  let qty = usdt / price;

  if (mode === 'live') {
    const order = await mexc.placeMarketOrder({ symbol: binanceSymbol, side: 'BUY', usdtAmount: usdt });
    qty = +order.executedQty || qty;
    if (+order.cummulativeQuoteQty && +order.executedQty) fill = +order.cummulativeQuoteQty / +order.executedQty;
  } else {
    if (s.paper.balance < usdt) throw new Error(`paper balance $${s.paper.balance.toFixed(2)} is less than trade size`);
    s.paper.balance -= usdt;
  }

  const pos = {
    id: uid(),
    mode: mode === 'live' ? 'live' : 'paper',
    source,
    symbol,
    binanceSymbol,
    side,
    qty,
    entry: fill,
    usdt,
    sl: sl != null ? +sl : null,
    tp: tp != null ? +tp : null,
    openedAt: new Date().toISOString(),
  };
  s.positions.push(pos);
  store.save();
  return pos;
}

/** Close a position at the given market price. */
async function close(id, price, reason = 'manual') {
  const s = store.load();
  const idx = s.positions.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`position ${id} not found`);
  const pos = s.positions[idx];
  price = +price || pos.entry;

  if (pos.mode === 'live') {
    await mexc.placeMarketOrder({ symbol: pos.binanceSymbol, side: 'SELL', quantity: pos.qty });
  }

  const gross = pos.side === 'LONG'
    ? (price - pos.entry) * pos.qty
    : (pos.entry - price) * pos.qty;
  const pnl = +gross.toFixed(2);

  if (pos.mode === 'paper') {
    s.paper.balance += pos.usdt + gross;
  }

  s.positions.splice(idx, 1);
  const closed = {
    ...pos,
    exit: price,
    pnl,
    pnlPct: +((gross / pos.usdt) * 100).toFixed(2),
    reason,
    closedAt: new Date().toISOString(),
  };
  s.history.unshift(closed);
  s.history = s.history.slice(0, 200);
  store.save();
  return closed;
}

/**
 * Mark all open positions against current prices; auto-close any that hit
 * SL/TP. Returns the closes performed.
 */
/**
 * Mark all open positions against current prices; auto-close any that hit
 * SL/TP. Returns the closes performed.
 */
async function manage(priceOf) {
  const s = store.load();
  const closes = [];
  for (const pos of [...s.positions]) {
    const price = priceOf(pos);
    if (!price) continue;
    const hitSL = pos.sl != null && (pos.side === 'LONG' ? price <= pos.sl : price >= pos.sl);
    const hitTP = pos.tp != null && (pos.side === 'LONG' ? price >= pos.tp : price <= pos.tp);
    if (hitSL || hitTP) {
      try {
        closes.push(await close(pos.id, price, hitSL ? 'stop-loss' : 'take-profit'));
      } catch (err) {
        closes.push({ ...pos, error: err.message });
      }
    }
  }
  return closes;
}

/** Open a Polymarket contract position. */
async function openPolymarket({ marketId, question, outcome, sizeUsdc, price, mode, source = 'manual' }) {
  const s = store.load();
  sizeUsdc = +sizeUsdc;
  price = +price; // price of the outcome (YES or NO)
  if (!sizeUsdc || sizeUsdc <= 0) throw new Error('trade size (USDC) must be > 0');
  if (!price || price <= 0) throw new Error('no price for trade');
  if (!['YES', 'NO'].includes(outcome)) throw new Error('outcome must be YES or NO');

  const qty = sizeUsdc / price;

  if (mode === 'live') {
    throw new Error('live Polymarket trading requires configured CLOB credentials (currently paper-only)');
  } else {
    if (s.polymarketPaper.balance < sizeUsdc) throw new Error(`Polymarket paper balance $${s.polymarketPaper.balance.toFixed(2)} is less than trade size`);
    s.polymarketPaper.balance -= sizeUsdc;
  }

  const pos = {
    id: uid(),
    mode: mode === 'live' ? 'live' : 'paper',
    source,
    marketId,
    question,
    outcome,
    qty,
    entry: price,
    sizeUsdc,
    openedAt: new Date().toISOString(),
  };
  s.polymarketPositions.push(pos);
  store.save();
  return pos;
}

/** Close a Polymarket position. */
async function closePolymarket(id, currentPrice, reason = 'manual') {
  const s = store.load();
  const idx = s.polymarketPositions.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`position ${id} not found`);
  const pos = s.polymarketPositions[idx];
  currentPrice = +currentPrice || pos.entry;

  const gross = (currentPrice - pos.entry) * pos.qty;
  const pnl = +gross.toFixed(2);

  if (pos.mode === 'paper') {
    s.polymarketPaper.balance += pos.sizeUsdc + gross;
  }

  s.polymarketPositions.splice(idx, 1);
  const closed = {
    ...pos,
    exit: currentPrice,
    pnl,
    pnlPct: +((gross / pos.sizeUsdc) * 100).toFixed(2),
    reason,
    closedAt: new Date().toISOString(),
  };
  s.polymarketHistory.unshift(closed);
  s.polymarketHistory = s.polymarketHistory.slice(0, 200);
  store.save();
  return closed;
}

/** Manage Polymarket stop losses and take profits based on current market prices. */
async function managePolymarket(priceMap) {
  const closes = [];
  const s = store.load();
  for (const pos of [...s.polymarketPositions]) {
    const yesPrice = priceMap.get(pos.marketId);
    if (yesPrice == null) continue;

    const contractPrice = pos.outcome === 'YES' ? yesPrice : (1.0 - yesPrice);
    const pnlPct = ((contractPrice - pos.entry) / pos.entry) * 100;

    // Use default risk limits (30% Stop loss, 50% Take profit)
    const hitSL = pnlPct <= -30.0;
    const hitTP = pnlPct >= 50.0;

    if (hitSL || hitTP) {
      try {
        closes.push(await closePolymarket(pos.id, contractPrice, hitSL ? 'stop-loss' : 'take-profit'));
      } catch (err) {
        closes.push({ ...pos, error: err.message });
      }
    }
  }
  return closes;
}

/** Snapshot with unrealized PnL computed from price lookups. */
function snapshot(priceOf, polymarketPriceOf) {
  const s = store.load();
  const cryptoPositions = s.positions.map((p) => {
    const price = priceOf ? priceOf(p) : null;
    const gross = price
      ? (p.side === 'LONG' ? (price - p.entry) * p.qty : (p.entry - price) * p.qty)
      : null;
    return {
      ...p,
      markPrice: price ?? null,
      uPnl: gross != null ? +gross.toFixed(2) : null,
      uPnlPct: gross != null ? +((gross / p.usdt) * 100).toFixed(2) : null,
    };
  });

  const pmPositions = s.polymarketPositions.map((p) => {
    const yesPrice = polymarketPriceOf ? polymarketPriceOf(p.marketId) : null;
    const contractPrice = yesPrice != null ? (p.outcome === 'YES' ? yesPrice : (1.0 - yesPrice)) : null;
    const gross = contractPrice ? (contractPrice - p.entry) * p.qty : null;
    return {
      ...p,
      markPrice: contractPrice ?? null,
      uPnl: gross != null ? +gross.toFixed(2) : null,
      uPnlPct: gross != null ? +((gross / p.sizeUsdc) * 100).toFixed(2) : null,
    };
  });

  const realized = s.history.reduce((a, h) => a + (h.pnl || 0), 0);
  const pmRealized = s.polymarketHistory.reduce((a, h) => a + (h.pnl || 0), 0);

  return {
    paperBalance: +s.paper.balance.toFixed(2),
    paperStart: s.paper.startBalance,
    realizedPnl: +realized.toFixed(2),
    positions: cryptoPositions,
    history: s.history.slice(0, 30),

    polymarketPaperBalance: +s.polymarketPaper.balance.toFixed(2),
    polymarketPaperStart: s.polymarketPaper.startBalance,
    polymarketRealizedPnl: +pmRealized.toFixed(2),
    polymarketPositions: pmPositions,
    polymarketHistory: s.polymarketHistory.slice(0, 30),
  };
}

module.exports = {
  open,
  close,
  manage,
  openPolymarket,
  closePolymarket,
  managePolymarket,
  snapshot,
  STABLES,
};
