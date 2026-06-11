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
    isCrypto: CRYPTO_RE.test(`${m.question} ${m.slug}`),
  };
}

async function getMarkets() {
  return cached('polymarket', 120_000, async () => {
    const res = await fetch(
      `${GAMMA}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) throw new Error(`Polymarket HTTP ${res.status}`);
    const raw = await res.json();
    const markets = raw.map(mapMarket).filter((m) => m.outcomes.length >= 2);
    return {
      crypto: markets.filter((m) => m.isCrypto).slice(0, 15),
      trending: markets.slice(0, 15),
      fetchedAt: new Date().toISOString(),
    };
  });
}

module.exports = { getMarkets };
