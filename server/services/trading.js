// Position engine: paper trading (default, simulated fills against live
// prices) and live MEXC spot orders. Tracks open positions with SL/TP and
// closes them when levels are hit (used manually and by the auto-trader).
const crypto = require('crypto');
const store = require('./store');
const mexc = require('./mexc');
const mexcFutures = require('./mexcFutures');

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'USDS', 'USDE', 'TUSD', 'PYUSD', 'USD1']);

function uid() {
  return crypto.randomBytes(5).toString('hex');
}

/**
 * Open a USDⓈ-M perpetual FUTURES position (long or short, leveraged).
 * `usdt` is the isolated margin; the position notional is margin × leverage.
 * Paper mode simulates the fill; live mode routes to the MEXC contract API.
 */
async function open({ symbol, binanceSymbol, side, usdt, price, sl, tp, mode, leverage, source = 'manual' }) {
  const s = store.load();
  usdt = +usdt;
  price = +price;
  leverage = Math.max(1, Math.min(50, +leverage || 1));
  if (!usdt || usdt <= 0) throw new Error('trade margin (USDT) must be > 0');
  if (!price || price <= 0) throw new Error('no price for trade');
  if (!['LONG', 'SHORT'].includes(side)) throw new Error('side must be LONG or SHORT');
  if (STABLES.has(symbol)) throw new Error(`${symbol} is a stablecoin — nothing to trade`);

  let fill = price;
  let qty = (usdt * leverage) / price; // futures: notional = margin × leverage

  if (mode === 'live') {
    // long OR short on USDⓈ-M futures via the MEXC contract API
    const order = await mexcFutures.open({ binanceSymbol, side, marginUsdt: usdt, leverage, price });
    qty = order.qty || qty;
    fill = order.fill || fill;
  } else {
    if (s.paper.balance < usdt) throw new Error(`paper balance $${s.paper.balance.toFixed(2)} is less than the margin`);
    s.paper.balance -= usdt; // reserve isolated margin
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
    usdt,            // isolated margin
    leverage,
    sl: sl != null ? +sl : null,
    tp: tp != null ? +tp : null,
    beMoved: false,  // has the SL been pulled to break-even yet?
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
    await mexcFutures.close({ binanceSymbol: pos.binanceSymbol, side: pos.side, qty: pos.qty });
  }

  const gross = pos.side === 'LONG'
    ? (price - pos.entry) * pos.qty
    : (pos.entry - price) * pos.qty;
  const margin = pos.usdt;
  const realized = Math.max(gross, -margin); // isolated futures: max loss = the margin
  const pnl = +realized.toFixed(2);

  if (pos.mode === 'paper') {
    s.paper.balance += margin + realized;
  }

  s.positions.splice(idx, 1);
  const closed = {
    ...pos,
    exit: price,
    pnl,
    pnlPct: +((realized / margin) * 100).toFixed(2),
    reason,
    closedAt: new Date().toISOString(),
  };
  s.history.unshift(closed);
  s.history = s.history.slice(0, 200);
  store.save();
  return closed;
}

/**
 * Mark all open positions against current prices. For each: (0) liquidate if
 * an isolated loss reaches the margin, (1) pull the SL to break-even once in
 * profit past the trigger (so a winner can't turn into a loser), then (2)
 * auto-close on SL/TP. Returns { closes, events } — events are non-close
 * notices (e.g. break-even moves) for the activity log.
 */
async function manage(priceOf) {
  const s = store.load();
  const cfg = s.autotrade || {};
  const closes = [];
  const events = [];
  for (const pos of [...s.positions]) {
    const price = priceOf(pos);
    if (!price) continue;
    const margin = pos.usdt;
    const gross = pos.side === 'LONG' ? (price - pos.entry) * pos.qty : (pos.entry - price) * pos.qty;

    // 0) liquidation — isolated loss has eaten (almost) the whole margin
    if (margin > 0 && gross <= -margin * 0.995) {
      try { closes.push(await close(pos.id, price, 'liquidation')); }
      catch (err) { closes.push({ ...pos, error: err.message }); }
      continue;
    }

    // 1) break-even: once favorably in profit past the trigger (and before TP),
    //    move the stop to entry so the trade can only close at >= break-even.
    if (cfg.beEnabled && !pos.beMoved) {
      const favPct = (pos.side === 'LONG' ? (price - pos.entry) / pos.entry : (pos.entry - price) / pos.entry) * 100;
      const beforeTP = pos.tp == null || (pos.side === 'LONG' ? price < pos.tp : price > pos.tp);
      if (favPct >= (cfg.beTrigger ?? 0.4) && beforeTP) {
        pos.sl = pos.entry;
        pos.beMoved = true;
        store.save();
        events.push({ level: 'info', msg: `SL→break-even on ${pos.symbol} ${pos.side} @ ${pos.entry} (+${favPct.toFixed(2)}% locked, can't lose now)` });
      }
    }

    // 2) SL / TP exits
    const hitSL = pos.sl != null && (pos.side === 'LONG' ? price <= pos.sl : price >= pos.sl);
    const hitTP = pos.tp != null && (pos.side === 'LONG' ? price >= pos.tp : price <= pos.tp);
    if (hitSL || hitTP) {
      const reason = hitTP ? 'take-profit' : (pos.beMoved && pos.sl === pos.entry ? 'break-even' : 'stop-loss');
      try { closes.push(await close(pos.id, price, reason)); }
      catch (err) { closes.push({ ...pos, error: err.message }); }
    }
  }
  return { closes, events };
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
