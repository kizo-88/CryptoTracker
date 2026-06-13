// TradFi market data (forex, indices, KLCI/Bursa Malaysia, recent IPOs) via
// the free Yahoo Finance chart API — no key required. The chart endpoint
// returns OHLC candles AND a meta block with the current price, so the same
// source feeds both the scanner and the candlestick/signal charts.
const { cached } = require('./cache');

const YF = 'https://query1.finance.yahoo.com/v8/finance/chart';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

// display symbol -> { yahoo ticker, friendly name }
const CATEGORIES = {
  forex: [
    { symbol: 'EURUSD', yahoo: 'EURUSD=X', name: 'Euro / US Dollar' },
    { symbol: 'GBPUSD', yahoo: 'GBPUSD=X', name: 'British Pound / USD' },
    { symbol: 'USDJPY', yahoo: 'USDJPY=X', name: 'US Dollar / Yen' },
    { symbol: 'AUDUSD', yahoo: 'AUDUSD=X', name: 'Aussie / US Dollar' },
    { symbol: 'USDCAD', yahoo: 'USDCAD=X', name: 'US Dollar / Cad' },
    { symbol: 'USDCHF', yahoo: 'USDCHF=X', name: 'US Dollar / Swiss Franc' },
    { symbol: 'NZDUSD', yahoo: 'NZDUSD=X', name: 'Kiwi / US Dollar' },
    { symbol: 'USDMYR', yahoo: 'USDMYR=X', name: 'US Dollar / Ringgit' },
    { symbol: 'XAUUSD', yahoo: 'GC=F', name: 'Gold (spot/futures)' },
    { symbol: 'XAGUSD', yahoo: 'SI=F', name: 'Silver (spot/futures)' },
    { symbol: 'WTIUSD', yahoo: 'CL=F', name: 'Crude Oil WTI' },
    { symbol: 'BTCUSD', yahoo: 'BTC-USD', name: 'Bitcoin / USD' },
  ],
  indices: [
    { symbol: 'NASDAQ', yahoo: '^IXIC', name: 'Nasdaq Composite' },
    { symbol: 'NAS100', yahoo: '^NDX', name: 'Nasdaq 100' },
    { symbol: 'SP500', yahoo: '^GSPC', name: 'S&P 500' },
    { symbol: 'DOW', yahoo: '^DJI', name: 'Dow Jones Industrial' },
    { symbol: 'RUSSELL', yahoo: '^RUT', name: 'Russell 2000' },
    { symbol: 'VIX', yahoo: '^VIX', name: 'Volatility Index' },
    { symbol: 'FTSE', yahoo: '^FTSE', name: 'FTSE 100 (UK)' },
    { symbol: 'DAX', yahoo: '^GDAXI', name: 'DAX (Germany)' },
    { symbol: 'NIKKEI', yahoo: '^N225', name: 'Nikkei 225 (Japan)' },
    { symbol: 'HANGSENG', yahoo: '^HSI', name: 'Hang Seng (HK)' },
  ],
  klci: [
    { symbol: 'KLCI', yahoo: '^KLSE', name: 'FTSE Bursa Malaysia KLCI' },
    { symbol: 'MAYBANK', yahoo: '1155.KL', name: 'Malayan Banking' },
    { symbol: 'PBBANK', yahoo: '1295.KL', name: 'Public Bank' },
    { symbol: 'CIMB', yahoo: '1023.KL', name: 'CIMB Group' },
    { symbol: 'TENAGA', yahoo: '5347.KL', name: 'Tenaga Nasional' },
    { symbol: 'PCHEM', yahoo: '5183.KL', name: 'Petronas Chemicals' },
    { symbol: 'PETGAS', yahoo: '6033.KL', name: 'Petronas Gas' },
    { symbol: 'IHH', yahoo: '5225.KL', name: 'IHH Healthcare' },
    { symbol: 'AXIATA', yahoo: '6888.KL', name: 'Axiata Group' },
    { symbol: 'NESTLE', yahoo: '4707.KL', name: 'Nestle Malaysia' },
  ],
  // Curated watchlist of recent notable IPOs (no clean free "IPO calendar"
  // API exists, so these are hand-picked tickers quoted live via Yahoo).
  ipo: [
    { symbol: 'RDDT', yahoo: 'RDDT', name: 'Reddit (2024)' },
    { symbol: 'ARM', yahoo: 'ARM', name: 'Arm Holdings (2023)' },
    { symbol: 'CART', yahoo: 'CART', name: 'Instacart (2023)' },
    { symbol: 'BIRK', yahoo: 'BIRK', name: 'Birkenstock (2023)' },
    { symbol: 'RBRK', yahoo: 'RBRK', name: 'Rubrik (2024)' },
    { symbol: 'ALAB', yahoo: 'ALAB', name: 'Astera Labs (2024)' },
    { symbol: 'KVYO', yahoo: 'KVYO', name: 'Klaviyo (2023)' },
    { symbol: 'CRCL', yahoo: 'CRCL', name: 'Circle (2025)' },
    { symbol: 'SMR', yahoo: 'SMR', name: 'NuScale Power' },
    { symbol: 'HOOD', yahoo: 'HOOD', name: 'Robinhood' },
  ],
};

async function fetchChart(yahoo, range, interval) {
  const url = `${YF}/${encodeURIComponent(yahoo)}?range=${range}&interval=${interval}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${yahoo}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`no data for ${yahoo}`);
  return result;
}

function candlesFromResult(result) {
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((v) => v == null)) continue; // Yahoo leaves gaps as null
    out.push({ time: ts[i], open: +o, high: +h, low: +l, close: +c, volume: +(q.volume?.[i] || 0) });
  }
  return out;
}

function quickSignalFromChange(chg) {
  if (chg == null) return 'NEUTRAL';
  if (chg >= 0.3) return 'BUY';
  if (chg <= -0.3) return 'SELL';
  return 'NEUTRAL';
}

async function getCategoryScan(category) {
  const list = CATEGORIES[category];
  if (!list) throw new Error(`unknown category "${category}"`);
  return cached(`scan:${category}`, 60_000, async () => {
    const rows = await Promise.all(
      list.map(async (item) => {
        try {
          const result = await fetchChart(item.yahoo, '5d', '1d');
          const meta = result.meta || {};
          const price = meta.regularMarketPrice ?? null;
          const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
          const change24h = price != null && prev ? ((price - prev) / prev) * 100 : null;
          return {
            symbol: item.symbol,
            name: item.name,
            source: 'yahoo',
            yahoo: item.yahoo,
            category,
            price,
            change24h,
            currency: meta.currency || 'USD',
            quickSignal: quickSignalFromChange(change24h),
          };
        } catch {
          return { symbol: item.symbol, name: item.name, source: 'yahoo', yahoo: item.yahoo, category, price: null, change24h: null, quickSignal: 'NEUTRAL' };
        }
      })
    );
    return rows;
  });
}

// Map our chart timeframes onto Yahoo's supported range/interval pairs.
const TF = {
  '5m': { range: '5d', interval: '5m' },
  '1h': { range: '1mo', interval: '60m' },
  '4h': { range: '3mo', interval: '60m' }, // Yahoo has no 4h; 1h over 3mo gives depth
  '1d': { range: '2y', interval: '1d' },
};

async function getYahooKlines(yahoo, interval) {
  const tf = TF[interval] || TF['1h'];
  return cached(`yklines:${yahoo}:${interval}`, 60_000, async () => {
    const result = await fetchChart(yahoo, tf.range, tf.interval);
    return { source: 'yahoo', candles: candlesFromResult(result) };
  });
}

module.exports = { getCategoryScan, getYahooKlines, CATEGORIES };
