// Dual Auto-trader: independent loops for Crypto (Binance/MEXC) and Polymarket.
// Computes technical indicators / ensemble probability edge and automates trading.
// Logs ticks, exits, entries, and error states.

const store = require('./store');
const market = require('./market');
const trading = require('./trading');
const { buildSignal } = require('./signals');
const polymarket = require('./polymarket');
const { quantSignal } = require('./quant/signal');

let timerCrypto = null;
let timerPolymarket = null;
let timerQuant = null;
let runningCrypto = false;
let runningPolymarket = false;
let runningQuant = false;
let lastTickCrypto = null;
let lastTickPolymarket = null;
let lastTickQuant = null;

function log(msg, level = 'info') {
  const s = store.load();
  s.log.unshift({ at: new Date().toISOString(), level, msg });
  s.log = s.log.slice(0, 100);
  store.save();
  console.log(`[autotrader] ${msg}`);
}

async function tickCrypto() {
  if (runningCrypto) return;
  runningCrypto = true;
  lastTickCrypto = new Date().toISOString();
  try {
    const cfg = store.load().autotrade;
    const scan = await market.getScan();
    const priceMap = new Map(scan.map((c) => [c.symbol, c.price]));
    const priceOf = (pos) => priceMap.get(pos.symbol) || null;

    // 1) manage exits + break-even moves on ALL open crypto positions (manual + auto)
    const { closes, events } = await trading.manage(priceOf);
    for (const ev of events) log(ev.msg, ev.level);
    for (const closed of closes) {
      if (closed.error) log(`failed to close crypto ${closed.symbol}: ${closed.error}`, 'error');
      else log(`closed crypto ${closed.symbol} ${closed.side} @ ${closed.exit} (${closed.reason}) PnL $${closed.pnl}`, closed.pnl >= 0 ? 'win' : 'loss');
    }

    if (!cfg.enabled) return;

    // 2) scan for entries
    const open = store.load().positions;
    if (open.length >= cfg.maxPositions) return;
    const held = new Set(open.map((p) => p.symbol));
    const candidates = scan
      .filter((c) => !trading.STABLES.has(c.symbol) && !held.has(c.symbol))
      .slice(0, cfg.universe)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

    for (const c of candidates) {
      if (store.load().positions.length >= cfg.maxPositions) break;
      if (Math.abs(c.score) < 1) continue; // pre-filter
      let sig;
      try {
        const { candles } = await market.getKlines({
          binanceSymbol: c.binanceSymbol, coinId: c.id, interval: cfg.candleInterval,
        });
        if (!candles || candles.length < 30) continue;
        sig = buildSignal(candles);
      } catch { continue; }

      if (sig.direction === 'NEUTRAL' || sig.confidence < cfg.minConfidence) continue;
      // futures allows shorts in both paper and live, so no long-only filter

      try {
        const pos = await trading.open({
          symbol: c.symbol,
          binanceSymbol: c.binanceSymbol,
          side: sig.direction,
          usdt: cfg.usdtPerTrade,
          price: c.price,
          sl: sig.stopLoss,
          tp: sig.takeProfits[0]?.price ?? null,
          mode: cfg.mode,
          leverage: cfg.leverage,
          source: 'auto',
        });
        log(`opened auto futures ${pos.mode} ${pos.side} ${pos.symbol} ${pos.leverage}x $${cfg.usdtPerTrade} @ ${pos.entry} (conf ${sig.confidence}%) SL ${pos.sl} TP ${pos.tp}`);
      } catch (err) {
        log(`could not open crypto ${c.symbol}: ${err.message}`, 'error');
      }
    }
  } catch (err) {
    log(`crypto tick failed: ${err.message}`, 'error');
  } finally {
    runningCrypto = false;
  }
}

// Quant bot: entries come from the quant ensemble (ML alpha + momentum + mean
// reversion) — never the TA signal engine. Exits/BE moves are shared: the
// crypto tick's trading.manage() covers ALL open positions including quant's.
async function tickQuant() {
  if (runningQuant) return;
  runningQuant = true;
  lastTickQuant = new Date().toISOString();
  try {
    const cfg = store.load().quantAutotrade;
    if (!cfg.enabled) return;

    const open = store.load().positions;
    const quantOpen = open.filter((p) => p.source === 'quant');
    if (quantOpen.length >= cfg.maxPositions) return;
    const held = new Set(open.map((p) => p.symbol));

    const scan = await market.getScan();
    const candidates = scan
      .filter((c) => c.futures && !trading.STABLES.has(c.symbol) && !held.has(c.symbol))
      .slice(0, cfg.universe);

    for (const c of candidates) {
      if (store.load().positions.filter((p) => p.source === 'quant').length >= cfg.maxPositions) break;
      let sig;
      try { sig = await quantSignal(c.binanceSymbol); } catch { continue; }
      if (sig.direction === 'NEUTRAL' || sig.confidence < cfg.minConfidence) continue;
      try {
        const pos = await trading.open({
          symbol: c.symbol,
          binanceSymbol: c.binanceSymbol,
          side: sig.direction,
          usdt: cfg.usdtPerTrade,
          price: sig.entry,
          sl: sig.stopLoss,
          tp: sig.takeProfits[0]?.price ?? null,
          mode: cfg.mode,
          leverage: cfg.leverage,
          source: 'quant',
        });
        log(`QUANT opened ${pos.mode} ${pos.side} ${pos.symbol} ${pos.leverage}x $${cfg.usdtPerTrade} @ ${pos.entry} (score ${sig.score}, ml ${sig.components.ml ?? 'n/a'}, conf ${sig.confidence}%)`);
      } catch (err) {
        log(`QUANT could not open ${c.symbol}: ${err.message}`, 'error');
      }
    }
  } catch (err) {
    log(`quant tick failed: ${err.message}`, 'error');
  } finally {
    runningQuant = false;
  }
}

async function tickPolymarket() {
  if (runningPolymarket) return;
  runningPolymarket = true;
  lastTickPolymarket = new Date().toISOString();
  try {
    const s = store.load();
    const cfg = s.polymarketAutotrade;

    // 1) Fetch Polymarket markets (trending & crypto)
    let data;
    try {
      data = await polymarket.getMarkets();
    } catch (err) {
      log(`Polymarket scan failed: ${err.message}`, 'error');
      return;
    }

    const allMarkets = [...(data.crypto || []), ...(data.trending || [])];
    const uniqueMarkets = [];
    const seenIds = new Set();
    for (const m of allMarkets) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        uniqueMarkets.push(m);
      }
    }

    const priceMap = new Map();
    for (const m of uniqueMarkets) {
      if (m.outcomes[0]?.price != null) {
        priceMap.set(m.id, m.outcomes[0].price);
      }
    }

    // 2) Manage exits on all open Polymarket positions
    const closes = await trading.managePolymarket(priceMap);
    for (const closed of closes) {
      if (closed.error) {
        log(`failed to close Polymarket position: ${closed.error}`, 'error');
      } else {
        log(`closed Polymarket ${closed.outcome} on "${closed.question.slice(0, 30)}..." @ ${closed.exit} (${closed.reason}) PnL $${closed.pnl}`, closed.pnl >= 0 ? 'win' : 'loss');
      }
    }

    if (!cfg.enabled) return;

    // 3) Scan for entries
    const openPositions = s.polymarketPositions;
    if (openPositions.length >= cfg.maxPositions) return;

    const currentExposure = openPositions.reduce((a, p) => a + p.sizeUsdc, 0);
    if (currentExposure + cfg.usdcPerTrade > cfg.maxExposure) {
      // Risk limit exceeded
      return;
    }

    const heldMarkets = new Set(openPositions.map((p) => p.marketId));

    for (const m of uniqueMarkets) {
      if (store.load().polymarketPositions.length >= cfg.maxPositions) break;
      if (heldMarkets.has(m.id)) continue;
      if (!m.quant || !m.quant.signal) continue;

      const sig = m.quant.signal;
      if (sig.action === 'HOLD') continue;
      if (sig.confidence < cfg.minConfidence) continue;
      if (Math.abs(sig.edge) < cfg.minEdge) continue;

      // Place order (paper or live)
      try {
        const price = sig.direction === 'YES' ? m.outcomes[0].price : (1.0 - m.outcomes[0].price);
        const pos = await trading.openPolymarket({
          marketId: m.id,
          question: m.question,
          outcome: sig.direction,
          sizeUsdc: cfg.usdcPerTrade,
          price,
          mode: cfg.mode,
          source: 'auto',
        });
        log(`opened auto Polymarket ${pos.mode} ${pos.outcome} on "${pos.question.slice(0, 25)}..." $${cfg.usdcPerTrade} @ ${pos.entry} (edge ${(sig.edge * 100).toFixed(1)}%)`);
      } catch (err) {
        log(`could not auto-trade Polymarket ${m.question.slice(0, 20)}: ${err.message}`, 'error');
      }
    }
  } catch (err) {
    log(`Polymarket tick failed: ${err.message}`, 'error');
  } finally {
    runningPolymarket = false;
  }
}

function applyCryptoTimer() {
  const cfg = store.load().autotrade;
  if (timerCrypto) { clearInterval(timerCrypto); timerCrypto = null; }
  const mins = Math.max(1, +cfg.intervalMin || 5);
  timerCrypto = setInterval(tickCrypto, mins * 60_000);
}

function applyPolymarketTimer() {
  const cfg = store.load().polymarketAutotrade;
  if (timerPolymarket) { clearInterval(timerPolymarket); timerPolymarket = null; }
  const mins = Math.max(1, +cfg.intervalMin || 5);
  timerPolymarket = setInterval(tickPolymarket, mins * 60_000);
}

function applyQuantTimer() {
  const cfg = store.load().quantAutotrade;
  if (timerQuant) { clearInterval(timerQuant); timerQuant = null; }
  const mins = Math.max(5, +cfg.intervalMin || 15); // ML retrains per tick — keep it sane
  timerQuant = setInterval(tickQuant, mins * 60_000);
}

function configureQuant(patch) {
  const s = store.load();
  const allowed = ['enabled', 'mode', 'intervalMin', 'minConfidence', 'usdtPerTrade', 'maxPositions', 'universe', 'leverage'];
  for (const k of allowed) if (k in patch) s.quantAutotrade[k] = patch[k];
  s.quantAutotrade.mode = s.quantAutotrade.mode === 'live' ? 'live' : 'paper';
  s.quantAutotrade.enabled = Boolean(s.quantAutotrade.enabled);
  store.save();
  applyQuantTimer();
  if ('enabled' in patch) log(s.quantAutotrade.enabled ? `QUANT auto-trade STARTED (${s.quantAutotrade.mode} mode)` : 'QUANT auto-trade stopped');
  if (s.quantAutotrade.enabled) tickQuant();
  return s.quantAutotrade;
}

function configure(patch) {
  const s = store.load();
  const allowed = ['enabled', 'mode', 'intervalMin', 'minConfidence', 'usdtPerTrade', 'maxPositions', 'universe', 'candleInterval', 'leverage', 'beEnabled', 'beTrigger'];
  for (const k of allowed) if (k in patch) s.autotrade[k] = patch[k];
  s.autotrade.mode = s.autotrade.mode === 'live' ? 'live' : 'paper';
  s.autotrade.enabled = Boolean(s.autotrade.enabled);
  store.save();
  applyCryptoTimer();
  if ('enabled' in patch) log(s.autotrade.enabled ? `crypto auto-trade STARTED (${s.autotrade.mode} mode)` : 'crypto auto-trade stopped');
  if (s.autotrade.enabled) tickCrypto();
  return s.autotrade;
}

function configurePolymarket(patch) {
  const s = store.load();
  const allowed = ['enabled', 'mode', 'intervalMin', 'minEdge', 'minConfidence', 'usdcPerTrade', 'maxPositions', 'maxExposure'];
  for (const k of allowed) if (k in patch) s.polymarketAutotrade[k] = patch[k];
  s.polymarketAutotrade.mode = s.polymarketAutotrade.mode === 'live' ? 'live' : 'paper';
  s.polymarketAutotrade.enabled = Boolean(s.polymarketAutotrade.enabled);
  store.save();
  applyPolymarketTimer();
  if ('enabled' in patch) log(s.polymarketAutotrade.enabled ? `Polymarket auto-trade STARTED (${s.polymarketAutotrade.mode} mode)` : 'Polymarket auto-trade stopped');
  if (s.polymarketAutotrade.enabled) tickPolymarket();
  return s.polymarketAutotrade;
}

function status() {
  const s = store.load();
  return {
    crypto: { ...s.autotrade, lastTick: lastTickCrypto },
    quant: { ...s.quantAutotrade, lastTick: lastTickQuant },
    polymarket: { ...s.polymarketAutotrade, lastTick: lastTickPolymarket },
    log: s.log.slice(0, 40),
  };
}

function init() {
  applyCryptoTimer();
  applyPolymarketTimer();
  applyQuantTimer();
  // Trigger initial checks silently in the background shortly after startup
  setTimeout(() => {
    tickCrypto();
    tickPolymarket();
    tickQuant();
  }, 3000);
}

module.exports = { configure, configurePolymarket, configureQuant, status, init, tickCrypto, tickPolymarket, tickQuant };
