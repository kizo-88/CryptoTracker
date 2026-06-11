// Polymarket prediction markets via the public Gamma API (no key needed).
const { cached } = require('./cache');

const GAMMA = 'https://gamma-api.polymarket.com';
const CRYPTO_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|doge|dogecoin|crypto|cardano|ada|bnb|stablecoin|defi|altcoin|memecoin)\b/i;

function parseMaybeJson(s, fallback) {
  if (Array.isArray(s)) return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

function mapMarket(m) {
  const outcomes = parseMaybeJson(m.outcomes, []);
  const prices = parseMaybeJson(m.outcomePrices, []).map(Number);
  return {
    id: m.id,
    question: m.question,
    slug: m.slug,
    url: `https://polymarket.com/market/${m.slug}`,
    outcomes: outcomes.map((name, i) => ({
      name,
      price: isFinite(prices[i]) ? prices[i] : null, // 0..1 implied probability
    })),
    volume24h: m.volume24hr != null ? +m.volume24hr : null,
    liquidity: m.liquidity != null ? +m.liquidity : null,
    endDate: m.endDate || null,
    // "vs" guard: skips sports matchups that happen to contain a crypto word
    // (e.g. tennis player "Solana Sierra")
    isCrypto: CRYPTO_RE.test(`${m.question} ${m.slug}`) && !/\bvs\.?\b/i.test(m.question || ''),
  };
}

async function getMarkets() {
  return cached('polymarket', 120_000, async () => {
    // paginate a few pages so the crypto filter has enough markets to find
    const pages = await Promise.all(
      [0, 100, 200].map(async (offset) => {
        const res = await fetch(
          `${GAMMA}/markets?closed=false&active=true&limit=100&offset=${offset}&order=volume24hr&ascending=false`,
          { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
        );
        if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
        return res.json();
      })
    );
    const markets = pages.flat().map(mapMarket).filter((m) => m.outcomes.length >= 2);
    return {
      crypto: markets.filter((m) => m.isCrypto).slice(0, 15),
      trending: markets.slice(0, 15),
      fetchedAt: new Date().toISOString(),
    };
  });
}

// Public read-only account data keyed by the user's Polymarket (Polygon)
// wallet address — no auth needed.
const DATA_API = 'https://data-api.polymarket.com';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Polymarket data HTTP ${res.status}`);
  return res.json();
}

async function getPositions(address) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('invalid wallet address — expected 0x… Polygon address');
  }
  const key = `pm-positions:${address.toLowerCase()}`;
  return cached(key, 60_000, async () => {
    const [positions, value] = await Promise.all([
      fetchJson(`${DATA_API}/positions?user=${address}&sizeThreshold=0.1&limit=50&sortBy=CURRENT&sortDirection=DESC`),
      fetchJson(`${DATA_API}/value?user=${address}`).catch(() => null),
    ]);
    const portfolioValue = Array.isArray(value) ? value[0]?.value : value?.value;
    return {
      address,
      portfolioValue: portfolioValue != null ? +portfolioValue : null,
      positions: (positions || []).map((p) => ({
        title: p.title,
        outcome: p.outcome,
        size: p.size != null ? +p.size : null,
        avgPrice: p.avgPrice != null ? +p.avgPrice : null,
        curPrice: p.curPrice != null ? +p.curPrice : null,
        currentValue: p.currentValue != null ? +p.currentValue : null,
        cashPnl: p.cashPnl != null ? +p.cashPnl : null,
        percentPnl: p.percentPnl != null ? +p.percentPnl : null,
        slug: p.slug || null,
      })),
    };
  });
}

module.exports = { getMarkets, getPositions };
