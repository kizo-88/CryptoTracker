// Cross-exchange arbitrage scanner: live best bid/ask from 6 public spot APIs,
// executable spread = buy at the cheap venue's ASK, sell at the rich venue's
// BID (already crosses the books — no mid-price fantasy), then net out taker
// fees, slippage, and latency drift (σ·√latency) to see what actually survives.
// Simulation only — no orders are placed anywhere.
const { cached } = require('../cache');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'LTC', 'AVAX', 'DOT'];

async function j(url, timeout = 6000) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* each fetcher returns { SYM: {bid, ask} } for whatever symbols it has */
const EXCHANGES = {
  binance: async () => {
    const out = {};
    await Promise.all(SYMBOLS.map(async (s) => {
      try {
        const t = await j(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${s}USDT`);
        out[s] = { bid: +t.bidPrice, ask: +t.askPrice };
      } catch { /* symbol missing on venue */ }
    }));
    return out;
  },
  mexc: async () => {
    const out = {};
    await Promise.all(SYMBOLS.map(async (s) => {
      try {
        const t = await j(`https://api.mexc.com/api/v3/ticker/bookTicker?symbol=${s}USDT`);
        out[s] = { bid: +t.bidPrice, ask: +t.askPrice };
      } catch { /* */ }
    }));
    return out;
  },
  okx: async () => {
    const out = {};
    const d = await j('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
    for (const t of d.data || []) {
      const m = t.instId.match(/^(\w+)-USDT$/);
      if (m && SYMBOLS.includes(m[1])) out[m[1]] = { bid: +t.bidPx, ask: +t.askPx };
    }
    return out;
  },
  bybit: async () => {
    const out = {};
    const d = await j('https://api.bybit.com/v5/market/tickers?category=spot');
    for (const t of d.result?.list || []) {
      const m = t.symbol.match(/^(\w+)USDT$/);
      if (m && SYMBOLS.includes(m[1])) out[m[1]] = { bid: +t.bid1Price, ask: +t.ask1Price };
    }
    return out;
  },
  kucoin: async () => {
    const out = {};
    const d = await j('https://api.kucoin.com/api/v1/market/allTickers');
    for (const t of d.data?.ticker || []) {
      const m = t.symbol.match(/^(\w+)-USDT$/);
      if (m && SYMBOLS.includes(m[1]) && +t.buy > 0) out[m[1]] = { bid: +t.buy, ask: +t.sell };
    }
    return out;
  },
  gate: async () => {
    const out = {};
    const d = await j('https://api.gateio.ws/api/v4/spot/tickers');
    for (const t of d || []) {
      const m = t.currency_pair.match(/^(\w+)_USDT$/);
      if (m && SYMBOLS.includes(m[1]) && +t.highest_bid > 0) out[m[1]] = { bid: +t.highest_bid, ask: +t.lowest_ask };
    }
    return out;
  },
};

// rough per-second return vol by symbol for latency drift (annual vol / √(sec/yr))
const ANN_VOL = { BTC: 0.5, ETH: 0.65, SOL: 0.9, XRP: 0.85, DOGE: 1.1, ADA: 0.85, LINK: 0.9, LTC: 0.8, AVAX: 0.95, DOT: 0.85 };

/**
 * params: { feeBps=10 (per side), slippageBps=5, latencyMs=200, sizeUsd=1000 }
 */
async function scan(params = {}) {
  const feeBps = +params.feeBps || 10;
  const slipBps = +params.slippageBps || 5;
  const latencyMs = +params.latencyMs || 200;
  const sizeUsd = +params.sizeUsd || 1000;

  const quotes = await cached('quant:arb', 5_000, async () => {
    const names = Object.keys(EXCHANGES);
    const results = await Promise.allSettled(names.map((n) => EXCHANGES[n]()));
    const out = {};
    names.forEach((n, i) => { out[n] = results[i].status === 'fulfilled' ? results[i].value : null; });
    return out;
  });

  const live = Object.entries(quotes).filter(([, v]) => v && Object.keys(v).length);
  const grid = SYMBOLS.map((sym) => {
    const venues = {};
    for (const [ex, book] of live) if (book[sym]) venues[ex] = book[sym];
    return { sym, venues };
  });

  const opportunities = [];
  for (const { sym, venues } of grid) {
    const names = Object.keys(venues);
    if (names.length < 2) continue;
    // executable: buy the lowest ask, sell the highest bid
    let buyEx = null, sellEx = null;
    for (const n of names) {
      if (!buyEx || venues[n].ask < venues[buyEx].ask) buyEx = n;
      if (!sellEx || venues[n].bid > venues[sellEx].bid) sellEx = n;
    }
    if (buyEx === sellEx) continue;
    const buy = venues[buyEx].ask, sell = venues[sellEx].bid;
    const grossBps = ((sell - buy) / buy) * 10000;

    // latency drift: expected adverse move while orders are in flight
    const sigmaSec = (ANN_VOL[sym] || 0.8) / Math.sqrt(365 * 24 * 3600);
    const latencyBps = sigmaSec * Math.sqrt(latencyMs / 1000) * 10000;

    const netBps = grossBps - 2 * feeBps - 2 * slipBps - latencyBps;
    opportunities.push({
      sym, buyEx, sellEx,
      buyPrice: buy, sellPrice: sell,
      grossBps: +grossBps.toFixed(1), grossPct: +(grossBps / 100).toFixed(3),
      costBps: +(2 * feeBps + 2 * slipBps).toFixed(1), latencyBps: +latencyBps.toFixed(1),
      netBps: +netBps.toFixed(1),
      netUsd: +((netBps / 10000) * sizeUsd).toFixed(2),
      viable: netBps > 0,
    });
  }
  opportunities.sort((a, b) => b.netBps - a.netBps);

  return {
    symbols: SYMBOLS,
    exchanges: Object.keys(EXCHANGES).map((n) => ({ name: n, up: !!quotes[n] && Object.keys(quotes[n]).length > 0 })),
    grid: grid.map(({ sym, venues }) => ({
      sym,
      quotes: Object.fromEntries(Object.entries(venues).map(([ex, b]) => [ex, { bid: b.bid, ask: b.ask }])),
    })),
    opportunities,
    params: { feeBps, slippageBps: slipBps, latencyMs, sizeUsd },
    note: 'Executable spreads (cross the book: buy ask / sell bid), net of taker fees both sides, slippage, and latency drift σ√t. Raw cross-venue spreads of 0.2-1.5% appear constantly — the lesson is how little survives costs. Simulation only; nothing is executed.',
    at: new Date().toISOString(),
  };
}

module.exports = { scan };
