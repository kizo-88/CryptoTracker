// Market data: CoinGecko for the broad scan, Binance for OHLCV klines
// (with CoinGecko OHLC as fallback when Binance is unreachable).
const { cached } = require('./cache');

const CG = 'https://api.coingecko.com/api/v3';
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision', // public market-data mirror, works in more regions
];
// USDⓈ-M perpetual futures — charts/signals use this so they match what the
// user actually trades (perps on MEXC/Binance), not the spot book.
const BINANCE_FUTURES = 'https://fapi.binance.com';

async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'CryptoTracker/2.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Quick momentum score from scanner data alone (no klines needed) so the
// table can rank 100 coins without 100 API calls. Range roughly -5..+5.
function quickScore(c) {
  let s = 0;
  if (c.change1h != null) s += Math.max(-1, Math.min(1, c.change1h / 1.5));
  if (c.change24h != null) s += Math.max(-1.5, Math.min(1.5, c.change24h / 4));
  if (c.change7d != null) s += Math.max(-1.5, Math.min(1.5, c.change7d / 10));
  if (c.volume && c.marketCap) {
    const turnover = c.volume / c.marketCap; // high turnover = active interest
    if (turnover > 0.25) s += 0.5;
  }
  return Math.round(s * 100) / 100;
}

function quickSignal(score) {
  if (score >= 1.5) return 'BUY';
  if (score <= -1.5) return 'SELL';
  return 'NEUTRAL';
}

// USDⓈ-M perpetual 24h ticker, keyed by contract symbol (BTCUSDT). Lets the
// scanner show the perp price/24h/volume the user actually trades, instead of
// CoinGecko's spot/index price. Best-effort: if futures is unreachable the
// scan silently falls back to the CoinGecko spot row.
async function futuresTickerMap() {
  try {
    const raw = await fetchJson(`${BINANCE_FUTURES}/fapi/v1/ticker/24hr`);
    const map = new Map();
    for (const t of raw) {
      if (!t.symbol?.endsWith('USDT')) continue; // USDⓈ-M perps only
      map.set(t.symbol, {
        price: +t.lastPrice,
        change24h: +t.priceChangePercent,
        high24h: +t.highPrice,
        low24h: +t.lowPrice,
        volume: +t.quoteVolume, // 24h notional in USDT
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

async function getScan() {
  return cached('scan', 60_000, async () => {
    const [data, fut] = await Promise.all([
      fetchJson(
        `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h%2C24h%2C7d`
      ),
      futuresTickerMap(),
    ]);
    return data.map((c) => {
      const row = {
        id: c.id,
        symbol: (c.symbol || '').toUpperCase(),
        name: c.name,
        image: c.image,
        price: c.current_price,
        change1h: c.price_change_percentage_1h_in_currency,
        change24h: c.price_change_percentage_24h_in_currency,
        change7d: c.price_change_percentage_7d_in_currency,
        volume: c.total_volume,
        marketCap: c.market_cap,
        rank: c.market_cap_rank,
        high24h: c.high_24h,
        low24h: c.low_24h,
      };
      row.binanceSymbol = `${row.symbol}USDT`;

      // Prefer live perpetual-futures pricing where a USDⓈ-M contract exists,
      // so the table matches the market we trade. Keep CoinGecko's 1h/7d/mcap
      // (futures has no equivalent) and recompute the momentum score after.
      const f = fut.get(row.binanceSymbol);
      if (f) {
        row.price = f.price;
        row.change24h = f.change24h;
        row.high24h = f.high24h;
        row.low24h = f.low24h;
        row.volume = f.volume;
        row.futures = true;
      } else {
        row.futures = false;
      }

      row.score = quickScore(row);
      row.quickSignal = quickSignal(row.score);
      return row;
    });
  });
}

async function getGlobal() {
  return cached('global', 120_000, async () => {
    const { data } = await fetchJson(`${CG}/global`);
    return {
      totalMarketCap: data.total_market_cap?.usd,
      totalVolume: data.total_volume?.usd,
      btcDominance: data.market_cap_percentage?.btc,
      ethDominance: data.market_cap_percentage?.eth,
      marketCapChange24h: data.market_cap_change_percentage_24h_usd,
      activeCryptos: data.active_cryptocurrencies,
    };
  });
}

const mapKlines = (raw) =>
  raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
  }));

// USDⓈ-M perpetual futures candles (BTCUSDT perp). Same shape as spot klines.
async function futuresKlines(symbol, interval, limit = 300) {
  const raw = await fetchJson(
    `${BINANCE_FUTURES}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
  return mapKlines(raw);
}

async function binanceKlines(symbol, interval, limit = 300) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const raw = await fetchJson(
        `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      );
      return mapKlines(raw);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// CoinGecko OHLC fallback. Granularity is fixed by the days window:
// 1 day -> 30m candles, 7/14/30 -> 4h, 90+ -> 4d.
const CG_DAYS_FOR_INTERVAL = { '5m': 1, '1h': 1, '4h': 30, '1d': 365 };

async function coingeckoKlines(coinId, interval) {
  const days = CG_DAYS_FOR_INTERVAL[interval] || 30;
  const raw = await fetchJson(`${CG}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`);
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: k[1],
    high: k[2],
    low: k[3],
    close: k[4],
    volume: 0,
  }));
}

/**
 * Get candles for a coin. Tries Binance USDⓈ-M FUTURES first (the perp we
 * actually trade), then Binance spot, then CoinGecko OHLC by coin id.
 */
async function getKlines({ binanceSymbol, coinId, interval }) {
  return cached(`klines:${binanceSymbol}:${coinId}:${interval}`, 60_000, async () => {
    try {
      return { source: 'binance-futures', candles: await futuresKlines(binanceSymbol, interval) };
    } catch { /* fall through to spot */ }
    try {
      return { source: 'binance', candles: await binanceKlines(binanceSymbol, interval) };
    } catch (err) {
      if (!coinId) throw err;
      return { source: 'coingecko', candles: await coingeckoKlines(coinId, interval) };
    }
  });
}

/**
 * Live order-book depth snapshot for the Bookmap view. Aggregates the raw
 * Binance book into `buckets` price levels so the heatmap can colour resting
 * liquidity. Crypto only (no L2 book for forex/indices).
 */
async function getDepth(binanceSymbol, buckets = 40) {
  return cached(`depth:${binanceSymbol}`, 5_000, async () => {
    let raw, lastErr;
    // futures book first (matches the perp chart), then spot mirrors
    const hosts = [`${BINANCE_FUTURES}/fapi/v1/depth`, ...BINANCE_HOSTS.map((h) => `${h}/api/v3/depth`)];
    for (const base of hosts) {
      try {
        raw = await fetchJson(`${base}?symbol=${binanceSymbol}&limit=500`);
        break;
      } catch (err) { lastErr = err; }
    }
    if (!raw) throw lastErr;
    const bids = raw.bids.map(([p, q]) => ({ price: +p, qty: +q }));
    const asks = raw.asks.map(([p, q]) => ({ price: +p, qty: +q }));
    const mid = bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : null;
    return { mid, bids, asks };
  });
}

module.exports = { getScan, getGlobal, getKlines, getDepth };
