// MEXC USDⓈ-M Futures (contract) API client — contract.mexc.com.
// Auth differs from spot: HMAC-SHA256 over (accessKey + reqTime + paramString),
// sent as ApiKey / Request-Time / Signature headers.
//
// ⚠ MEXC has restricted futures-order placement over the API for most retail
// keys since 2022 (the submit endpoint frequently returns a "maintenance" /
// permission error). The code below is correct, but live futures orders may be
// rejected by MEXC regardless — paper mode is the reliable path. Reuses the
// spot key/secret set via mexc.setCreds (same API key works for both on MEXC).
const crypto = require('crypto');
const mexc = require('./mexc');

const BASE = 'https://contract.mexc.com';

// BTCUSDT -> BTC_USDT (contract symbol format)
function contractSymbol(binanceSymbol) {
  const s = binanceSymbol.toUpperCase();
  if (s.endsWith('USDT')) return `${s.slice(0, -4)}_USDT`;
  if (s.endsWith('USDC')) return `${s.slice(0, -4)}_USDC`;
  return s;
}

async function publicGet(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`MEXC futures ${res.status}`);
  return res.json();
}

function creds() {
  const c = mexc.getCreds();
  if (!c.key || !c.secret) throw new Error('MEXC not connected — add API key first');
  return c;
}

async function signedRequest(method, path, params = {}) {
  const { key, secret } = creds();
  const reqTime = String(Date.now());
  let url = `${BASE}${path}`;
  let body;
  let signTarget;
  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    signTarget = key + reqTime + qs;
    if (qs) url += `?${qs}`;
  } else {
    body = JSON.stringify(params);
    signTarget = key + reqTime + body;
  }
  const signature = crypto.createHmac('sha256', secret).update(signTarget).digest('hex');
  const res = await fetch(url, {
    method,
    headers: {
      'ApiKey': key,
      'Request-Time': reqTime,
      'Signature': signature,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(12000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(`MEXC futures: ${json.message || json.code || res.status} — note: MEXC often restricts futures API trading`);
  }
  return json.data ?? json;
}

// contracts = coin quantity / contractSize for the symbol
async function contractsFor(symbol, coinQty) {
  try {
    const d = await publicGet(`/api/v1/contract/detail?symbol=${symbol}`);
    const size = +(d.data?.contractSize ?? d.contractSize ?? 1) || 1;
    return Math.max(1, Math.round(coinQty / size));
  } catch {
    return Math.max(1, Math.round(coinQty)); // fallback if detail lookup fails
  }
}

/**
 * Open a market futures position. side: 'LONG' | 'SHORT'.
 * marginUsdt is the isolated margin; notional = margin * leverage.
 */
async function open({ binanceSymbol, side, marginUsdt, leverage, price }) {
  const symbol = contractSymbol(binanceSymbol);
  const coinQty = (marginUsdt * leverage) / price;
  const vol = await contractsFor(symbol, coinQty);
  const order = await signedRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    vol,
    leverage,
    side: side === 'LONG' ? 1 : 3, // 1 open long, 3 open short
    type: 5,                       // market
    openType: 1,                   // isolated margin
  });
  return { qty: coinQty, fill: price, vol, order };
}

/** Close an open futures position (reduce-only market order). */
async function close({ binanceSymbol, side, qty }) {
  const symbol = contractSymbol(binanceSymbol);
  const vol = await contractsFor(symbol, qty);
  return signedRequest('POST', '/api/v1/private/order/submit', {
    symbol,
    vol,
    side: side === 'LONG' ? 4 : 2, // 4 close long, 2 close short
    type: 5,
    openType: 1,
  });
}

/**
 * USDⓈ-M futures wallet (contract account) balances, per currency.
 * Returns equity / available / unrealized PnL and a USD-stable total.
 * ⚠ Reading the contract account may also be API-restricted on some MEXC
 * retail keys — callers should treat failures gracefully.
 */
async function getWallet() {
  const data = await signedRequest('GET', '/api/v1/private/account/assets');
  const assets = (Array.isArray(data) ? data : [])
    .map((a) => ({
      currency: a.currency,
      equity: +a.equity || 0,
      available: +a.availableBalance || 0,
      cashBalance: +a.cashBalance || 0,
      positionMargin: +a.positionMargin || 0,
      frozen: +a.frozenBalance || 0,
      unrealized: +a.unrealized || 0,
    }))
    .filter((a) => a.equity || a.available || a.cashBalance)
    .sort((a, b) => b.equity - a.equity);
  // USDT/USDC are ~$1; that's what the futures wallet is collateralised in.
  const totalUsd = assets.reduce(
    (s, a) => s + (['USDT', 'USDC'].includes(a.currency) ? a.equity : 0),
    0
  );
  return { assets, totalUsd: +totalUsd.toFixed(2) };
}

module.exports = { open, close, contractSymbol, getWallet };
