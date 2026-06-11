const express = require('express');
const market = require('../services/market');
const polymarket = require('../services/polymarket');
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

module.exports = router;
