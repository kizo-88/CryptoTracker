// Market data: CoinGecko for the broad scan, Binance for OHLCV klines
// (with CoinGecko OHLC as fallback when Binance is unreachable).
const { cached } = require('./cache');

const CG = 'https://api.coingecko.com/api/v3';
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision', // public market-data mirror, works in more regions
];

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

async function getScan() {
  return cached('scan', 60_000, async () => {
    const data = await fetchJson(
      `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h%2C24h%2C7d`
    );
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
      row.score = quickScore(row);
      row.quickSignal = quickSignal(row.score);
      row.binanceSymbol = `${row.symbol}USDT`;
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

async function binanceKlines(symbol, interval, limit = 300) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const raw = await fetchJson(
        `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      );
      return raw.map((k) => ({
        time: Math.floor(k[0] / 1000),
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// CoinGecko OHLC fallback. Granularity is fixed by the days window:
// 1 day -> 30m candles, 7/14/30 -> 4h, 90+ -> 4d.
const CG_DAYS_FOR_INTERVAL = { '1h': 1, '4h': 30, '1d': 365 };

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
 * Get candles for a coin. Tries Binance spot first (best granularity),
 * falls back to CoinGecko OHLC keyed by the coin id.
 */
async function getKlines({ binanceSymbol, coinId, interval }) {
  return cached(`klines:${binanceSymbol}:${coinId}:${interval}`, 60_000, async () => {
    try {
      const candles = await binanceKlines(binanceSymbol, interval);
      return { source: 'binance', candles };
    } catch (err) {
      if (!coinId) throw err;
      const candles = await coingeckoKlines(coinId, interval);
      return { source: 'coingecko', candles };
    }
  });
}

module.exports = { getScan, getGlobal, getKlines };
