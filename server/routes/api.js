const express = require('express');
const market = require('../services/market');
const polymarket = require('../services/polymarket');
const mexc = require('../services/mexc');
const { buildSignal } = require('../services/signals');

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

// Top-100 market scan with quick momentum signals
router.get('/scan', handle(() => market.getScan()));

// Global market stats (total mcap, BTC dominance, ...)
router.get('/global', handle(() => market.getGlobal()));

// Full analysis for one coin: candles + indicators + signal with entry/TP/SL
router.get(
  '/signal',
  handle(async (req) => {
    const binanceSymbol = (req.query.binance || 'BTCUSDT').toUpperCase();
    const coinId = req.query.id || null;
    const interval = ['1h', '4h', '1d'].includes(req.query.interval) ? req.query.interval : '4h';
    const { source, candles } = await market.getKlines({ binanceSymbol, coinId, interval });
    if (!candles || candles.length < 30) throw new Error(`not enough candle data for ${binanceSymbol}`);
    const signal = buildSignal(candles);
    return { symbol: binanceSymbol, coinId, interval, source, candles, signal };
  })
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

module.exports = router;
