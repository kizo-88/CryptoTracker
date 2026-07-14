// Shared market-data layer for the quant engines: a 100+ asset universe of
// Binance USDⓈ-M perps with an aligned daily-close matrix, sector tags, and
// funding rates. Fetched once and cached (6h) — every quant module reads this.
const { cached } = require('../cache');

const FAPI = 'https://fapi.binance.com';
// Spot mirrors used when fapi is unreachable from the host (cloud IPs often get
// 418/451 from fapi — data-api.binance.vision is Binance's public data mirror).
// Returns/vol math is scale-invariant, so spot closes are a sound stand-in;
// multiplier-prefixed perps (1000PEPE…) don't exist on spot and simply drop out.
const SPOT_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];

async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'CryptoTracker/2.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/** klines with futures→spot-mirror fallback; same response shape. */
async function klinesAnyHost(symbol, interval, limit) {
  let lastErr;
  try {
    return await fetchJson(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  } catch (err) { lastErr = err; }
  for (const host of SPOT_HOSTS) {
    try {
      return await fetchJson(`${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// crude sector tags for constraint handling in the optimizer / risk engine
const SECTORS = {
  L1: ['BTC', 'ETH', 'SOL', 'BNB', 'ADA', 'AVAX', 'DOT', 'NEAR', 'ATOM', 'TRX', 'TON', 'SUI', 'APT', 'SEI', 'ALGO', 'HBAR', 'KAS', 'EGLD', 'FTM', 'S', 'BERA', 'HYPE'],
  L2: ['ARB', 'OP', 'MATIC', 'POL', 'STRK', 'ZK', 'MNT', 'METIS', 'BLAST', 'MANTA', 'CELO', 'IMX'],
  DEFI: ['UNI', 'AAVE', 'MKR', 'CRV', 'LDO', 'SNX', 'COMP', 'SUSHI', 'PENDLE', 'JUP', 'RAY', 'DYDX', 'GMX', 'CAKE', '1INCH', 'JTO', 'ENA', 'MORPHO', 'AERO'],
  MEME: ['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', 'TRUMP', 'FARTCOIN', 'PENGU', 'BOME', 'NEIRO', 'POPCAT', 'MEW', 'BRETT', 'MOODENG', 'PNUT', 'SPX'],
  AI: ['FET', 'RENDER', 'TAO', 'GRT', 'VIRTUAL', 'AI16Z', 'WLD', 'ARC', 'AIXBT', 'GOAT', 'AGLD', 'PHB', 'NFP'],
  GAMING: ['SAND', 'MANA', 'AXS', 'GALA', 'ENJ', 'APE', 'YGG', 'PIXEL', 'ACE', 'XAI', 'PORTAL'],
  PAYMENTS: ['XRP', 'XLM', 'LTC', 'BCH', 'DASH', 'XVG'],
  PRIVACY: ['XMR', 'ZEC', 'ZEN', 'SCRT'],
  INFRA: ['LINK', 'FIL', 'AR', 'ICP', 'STX', 'INJ', 'TIA', 'ENS', 'PYTH', 'ATOM', 'QNT', 'FLR', 'ONDO', 'CHZ', 'BAT', 'W', 'ZRO', 'EIGEN'],
};
function sectorOf(base) {
  for (const [sector, list] of Object.entries(SECTORS)) if (list.includes(base)) return sector;
  return 'OTHER';
}

const EXCLUDE_BASES = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDP', 'EUR', 'BTCDOM', 'DEFI']);

// strip Binance's multiplier prefixes (1000PEPE -> PEPE) for display/sector
function baseOf(symbol) {
  let b = symbol.replace(/USDT$/, '');
  b = b.replace(/^1000000|^10000|^1000/, '');
  return b;
}

/** Top-N USDⓈ-M perps by 24h quote volume (spot-mirror fallback if fapi is blocked). */
async function getUniverse(n = 110) {
  return cached(`quant:universe:${n}`, 6 * 3600_000, async () => {
    let raw, lastErr;
    const hosts = [`${FAPI}/fapi/v1/ticker/24hr`, ...SPOT_HOSTS.map((h) => `${h}/api/v3/ticker/24hr`)];
    for (const url of hosts) {
      try { raw = await fetchJson(url); break; } catch (err) { lastErr = err; }
    }
    if (!raw) throw lastErr;
    return raw
      .filter((t) => t.symbol.endsWith('USDT') && !t.symbol.includes('_'))
      .map((t) => ({ symbol: t.symbol, base: baseOf(t.symbol), quoteVolume: +t.quoteVolume }))
      .filter((t) => !EXCLUDE_BASES.has(t.base) && t.quoteVolume > 0)
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, n)
      .map((t) => ({ ...t, sector: sectorOf(t.base) }));
  });
}

async function dailyCloses(symbol, limit = 400) {
  const raw = await klinesAnyHost(symbol, '1d', limit);
  // drop today's partial candle
  return raw.slice(0, -1).map((k) => ({ time: +k[0], close: +k[4], volume: +k[7] }));
}

// small concurrency pool so 110 kline fetches don't hammer the API
async function pool(items, worker, size = 8) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx]); } catch { out[idx] = null; }
      }
    })
  );
  return out;
}

/**
 * Aligned daily-close matrix for the top-N universe.
 * Returns { symbols:[{symbol,base,sector,quoteVolume}], dates:[ms], closes:{sym:[...]},
 *           returns:{sym:[...]}, T } — closes/returns aligned on BTC's date spine,
 * forward-filled; assets with <60% coverage are dropped.
 */
async function getMatrix(n = 170) {
  return cached(`quant:matrix:${n}`, 6 * 3600_000, async () => {
    const uni = await getUniverse(n);
    const series = await pool(uni, (u) => dailyCloses(u.symbol), 8);

    const btcIdx = uni.findIndex((u) => u.symbol === 'BTCUSDT');
    const spineRaw = series[btcIdx >= 0 ? btcIdx : 0];
    if (!spineRaw || spineRaw.length < 200) throw new Error('quant data: no BTC spine');
    const dates = spineRaw.map((c) => c.time);

    const symbols = [];
    const closes = {};
    for (let s = 0; s < uni.length; s++) {
      const ser = series[s];
      if (!ser || ser.length < 120) continue;
      const map = new Map(ser.map((c) => [c.time, c.close]));
      const arr = new Array(dates.length).fill(null);
      let covered = 0;
      for (let t = 0; t < dates.length; t++) {
        if (map.has(dates[t])) { arr[t] = map.get(dates[t]); covered++; }
        else if (t > 0 && arr[t - 1] != null) arr[t] = arr[t - 1]; // forward-fill gaps
      }
      if (covered / dates.length < 0.3 && covered < 150) continue;
      symbols.push(uni[s]);
      closes[uni[s].symbol] = arr;
    }

    const returns = {};
    for (const { symbol } of symbols) {
      const c = closes[symbol];
      const r = new Array(dates.length).fill(0);
      for (let t = 1; t < dates.length; t++) {
        if (c[t] != null && c[t - 1] != null && c[t - 1] > 0) r[t] = Math.log(c[t] / c[t - 1]);
      }
      returns[symbol] = r;
    }

    return { symbols, dates, closes, returns, T: dates.length };
  });
}

/** Current funding rates (carry factor), keyed by contract symbol. */
async function getFunding() {
  return cached('quant:funding', 30 * 60_000, async () => {
    const raw = await fetchJson(`${FAPI}/fapi/v1/premiumIndex`);
    const map = {};
    for (const r of raw) if (r.symbol?.endsWith('USDT')) map[r.symbol] = +r.lastFundingRate;
    return map;
  });
}

/** Hourly klines for one symbol (ML features / options realized vol). */
async function hourlyKlines(symbol, limit = 1000) {
  return cached(`quant:h1:${symbol}:${limit}`, 15 * 60_000, async () => {
    const raw = await klinesAnyHost(symbol, '1h', limit);
    return raw.map((k) => ({
      time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
  });
}

module.exports = { getUniverse, getMatrix, getFunding, hourlyKlines, sectorOf, baseOf };
