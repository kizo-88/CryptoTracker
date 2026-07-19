const express = require('express');
const market = require('../services/market');
const tradfi = require('../services/tradfi');
const polymarket = require('../services/polymarket');
const mexc = require('../services/mexc');
const mexcFutures = require('../services/mexcFutures');
const { buildSignal } = require('../services/signals');
const trading = require('../services/trading');
const autotrader = require('../services/autotrader');
const qOptions = require('../services/quant/options');
const qFactors = require('../services/quant/factors');
const qMl = require('../services/quant/ml');
const qArb = require('../services/quant/arb');
const qOptimizer = require('../services/quant/optimizer');
const qRisk = require('../services/quant/risk');
const qStatarb = require('../services/quant/statarb');
const { quantSignal, crossoverMonitor } = require('../services/quant/signal');
const qData = require('../services/quant/data');

const router = express.Router();

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      console.error(`[api] ${req.path}:`, err.message);
      res.status(502).json({ error: err.message });
    }
  };
}

// Market scan. ?category=crypto (default) | forex | indices | klci | ipo
// Crypto comes from CoinGecko; the rest from Yahoo Finance (tradfi service).
router.get(
  '/scan',
  handle((req) => {
    const category = (req.query.category || 'crypto').toLowerCase();
    if (category === 'crypto') return market.getScan();
    return tradfi.getCategoryScan(category);
  })
);

// Global market stats (total mcap, BTC dominance, ...)
router.get('/global', handle(() => market.getGlobal()));

// Full analysis for one instrument: candles + indicators + signal w/ entry/TP/SL.
// Crypto: ?binance=BTCUSDT&id=bitcoin. TradFi: ?source=yahoo&symbol=EURUSD=X
router.get(
  '/signal',
  handle(async (req) => {
    const interval = ['5m', '1h', '4h', '1d'].includes(req.query.interval) ? req.query.interval : '4h';
    let label, source, candles;

    if ((req.query.source || '').toLowerCase() === 'yahoo') {
      const ySymbol = req.query.symbol;
      if (!ySymbol) throw new Error('symbol is required for yahoo source');
      ({ source, candles } = await tradfi.getYahooKlines(ySymbol, interval));
      label = ySymbol;
    } else {
      const binanceSymbol = (req.query.binance || 'BTCUSDT').toUpperCase();
      const coinId = req.query.id || null;
      ({ source, candles } = await market.getKlines({ binanceSymbol, coinId, interval }));
      label = binanceSymbol;
    }

    if (!candles || candles.length < 30) throw new Error(`not enough candle data for ${label}`);
    const signal = buildSignal(candles);
    return { symbol: label, interval, source, candles, signal };
  })
);

// Live order-book depth snapshot (crypto only) for the Bookmap heatmap
router.get(
  '/depth',
  handle((req) => market.getDepth((req.query.binance || 'BTCUSDT').toUpperCase()))
);

// Polymarket prediction markets (crypto-related + overall trending)
router.get('/polymarket', handle(() => polymarket.getMarkets()));

// Polymarket account positions (public data API, keyed by wallet address)
router.get(
  '/polymarket/positions',
  handle((req) => polymarket.getPositions((req.query.address || '').trim()))
);

// --- MEXC account (read-only; keys held in server memory) ---
router.get('/mexc/status', handle(async () => ({ connected: mexc.isConnected() })));

router.post(
  '/connect/mexc',
  handle(async (req) => {
    const { key, secret } = req.body || {};
    if (!key || !secret) throw new Error('key and secret are required');
    mexc.setCreds(key, secret);
    try {
      const account = await mexc.getAccount(); // validates the credentials
      return { connected: true, ...account };
    } catch (err) {
      mexc.disconnect();
      throw err;
    }
  })
);

router.post('/disconnect/mexc', handle(async () => { mexc.disconnect(); return { connected: false }; }));

router.get(
  '/mexc/account',
  handle(async () => {
    const account = await mexc.getAccount();
    // enrich with USD estimates from the scanner's live prices
    const prices = new Map();
    try {
      for (const c of await market.getScan()) if (!prices.has(c.symbol)) prices.set(c.symbol, c.price);
    } catch { /* estimates are best-effort */ }
    prices.set('USDT', 1).set('USDC', 1);
    let totalUsd = 0;
    for (const b of account.balances) {
      b.usdValue = prices.has(b.asset) ? +(b.total * prices.get(b.asset)).toFixed(2) : null;
      if (b.usdValue) totalUsd += b.usdValue;
    }
    account.balances.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
    return { ...account, totalUsd: +totalUsd.toFixed(2) };
  })
);

// USDⓈ-M futures wallet (contract account balances). Best-effort: MEXC may
// restrict the contract account API on some retail keys.
router.get('/mexc/futures', handle(async () => mexcFutures.getWallet()));

// --- Unified Trading & Portfolio ---
router.get(
  '/portfolio',
  handle(async () => {
    // 1) Fetch current crypto prices for marking PnL
    const scan = await market.getScan().catch(() => []);
    const priceMap = new Map(scan.map((c) => [c.symbol, c.price]));
    const priceOf = (pos) => priceMap.get(pos.symbol) || null;

    // 2) Fetch current Polymarket prices for marking PnL
    const pmData = await polymarket.getMarkets().catch(() => ({ crypto: [], trending: [] }));
    const allPmMarkets = [...(pmData.crypto || []), ...(pmData.trending || [])];
    const pmPriceMap = new Map();
    for (const m of allPmMarkets) {
      if (m.outcomes[0]?.price != null) {
        pmPriceMap.set(m.id, m.outcomes[0].price);
      }
    }
    const polymarketPriceOf = (marketId) => pmPriceMap.get(marketId) || null;

    // 3) Generate portfolio snapshot
    return trading.snapshot(priceOf, polymarketPriceOf);
  })
);

router.post(
  '/trade/open',
  handle(async (req) => {
    const { market: mkt, ...params } = req.body || {};
    if (mkt === 'crypto') {
      return trading.open(params);
    } else if (mkt === 'polymarket') {
      return trading.openPolymarket(params);
    } else {
      throw new Error('invalid market type — expected crypto or polymarket');
    }
  })
);

router.post(
  '/trade/close',
  handle(async (req) => {
    const { market: mkt, id, price } = req.body || {};
    if (!id) throw new Error('position id is required');
    if (mkt === 'crypto') {
      return trading.close(id, price);
    } else if (mkt === 'polymarket') {
      return trading.closePolymarket(id, price);
    } else {
      throw new Error('invalid market type — expected crypto or polymarket');
    }
  })
);

// --- Unified Autotrader Config & Status ---
router.get('/autotrade/status', handle(() => autotrader.status()));

router.post(
  '/autotrade/configure',
  handle(async (req) => {
    const { market: mkt, config } = req.body || {};
    if (!config) throw new Error('config patch is required');
    if (mkt === 'crypto') {
      return autotrader.configure(config);
    } else if (mkt === 'polymarket') {
      return autotrader.configurePolymarket(config);
    } else if (mkt === 'quant') {
      return autotrader.configureQuant(config);
    } else {
      throw new Error('invalid market type — expected crypto, quant or polymarket');
    }
  })
);

// ================= QUANT LAB =================
// Symbol list for pickers: tradfi (Yahoo-fed: gold/silver/oil) first, then perps
router.get('/quant/universe', handle(async () => {
  const uni = await qData.getUniverse(110);
  const tradfi = Object.entries(qData.TRADFI).map(([symbol, t]) => ({
    symbol, base: symbol.slice(0, 3), sector: t.sector, yahoo: t.yahoo, name: t.name,
  }));
  return [...tradfi, ...uni.map((u) => ({ symbol: u.symbol, base: u.base, sector: u.sector }))];
}));

// Live SMA crossover monitor (the XAUUSD-study strategy; works on any symbol)
router.get('/quant/crossover', handle((req) =>
  crossoverMonitor((req.query.symbol || 'XAUUSD').toUpperCase(), req.query.fast, req.query.slow)));

// Option pricing engine: chain + greeks + timing benchmark
router.get('/quant/options', handle((req) => qOptions.getChain((req.query.binance || 'BTCUSDT').toUpperCase())));

// Factor model: overview (scores + single-factor stats) and blended backtest
router.get('/quant/factors', handle(() => qFactors.overview()));
router.post('/quant/factors/backtest', handle((req) => qFactors.backtest(req.body?.exposures || {})));

// ML alpha model: walk-forward train + OOS evaluation
router.get('/quant/ml', handle((req) => qMl.run((req.query.binance || 'BTCUSDT').toUpperCase())));

// Cross-exchange arbitrage scanner
router.get('/quant/arb', handle((req) => qArb.scan(req.query)));

// Constrained max-Sharpe portfolio optimizer
router.get('/quant/optimize', handle((req) => qOptimizer.optimize(req.query)));

// Risk engine: VaR / ES / stress tests
router.get('/quant/risk', handle((req) => qRisk.analyze(req.query.basis || 'optimized', +req.query.notional || 10000)));

// Stat-arb pair sweep + pair detail
router.get('/quant/statarb', handle(() => qStatarb.sweep(60)));
router.get('/quant/statarb/pair', handle((req) => qStatarb.pairDetail(req.query.a, req.query.b)));

// Quant-only trade signal (ensemble: ML + momentum + mean reversion)
router.get('/quant/signal', handle((req) => quantSignal((req.query.binance || 'BTCUSDT').toUpperCase())));

module.exports = router;
