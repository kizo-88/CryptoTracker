// MEXC account access via signed REST API (api.mexc.com).
// Credentials come from .env (MEXC_API_KEY / MEXC_API_SECRET) or are set at
// runtime through POST /api/connect/mexc — runtime keys live in memory only
// and are never written to disk. Use a READ-ONLY API key (no trade/withdraw).
const crypto = require('crypto');

const BASE = 'https://api.mexc.com';

let creds = {
  key: process.env.MEXC_API_KEY || null,
  secret: process.env.MEXC_API_SECRET || null,
};

function setCreds(key, secret) {
  creds = { key: key?.trim() || null, secret: secret?.trim() || null };
}

function isConnected() {
  return Boolean(creds.key && creds.secret);
}

function disconnect() {
  creds = { key: null, secret: null };
}

async function signedRequest(method, path, params = {}) {
  if (!isConnected()) throw new Error('MEXC not connected — add API key first');
  const qs = new URLSearchParams({
    ...params,
    timestamp: Date.now(),
    recvWindow: 10000,
  }).toString();
  const signature = crypto.createHmac('sha256', creds.secret).update(qs).digest('hex');
  const res = await fetch(`${BASE}${path}?${qs}&signature=${signature}`, {
    method,
    headers: { 'X-MEXC-APIKEY': creds.key },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MEXC ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

const signedGet = (path, params) => signedRequest('GET', path, params);

/** Spot balances (non-zero only). */
async function getAccount() {
  const acct = await signedGet('/api/v3/account');
  const balances = (acct.balances || [])
    .map((b) => ({ asset: b.asset, free: +b.free, locked: +b.locked, total: +b.free + +b.locked }))
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total - a.total);
  return { canTrade: acct.canTrade, accountType: acct.accountType, balances };
}

/**
 * Place a spot MARKET order on MEXC (symbol like BTCUSDT).
 * BUY uses quoteOrderQty (spend N USDT); SELL uses quantity (sell N base).
 */
async function placeMarketOrder({ symbol, side, usdtAmount, quantity }) {
  const params = { symbol, side, type: 'MARKET' };
  if (side === 'BUY') {
    if (!usdtAmount || usdtAmount <= 0) throw new Error('usdtAmount required for BUY');
    params.quoteOrderQty = usdtAmount;
  } else {
    if (!quantity || quantity <= 0) throw new Error('quantity required for SELL');
    params.quantity = quantity;
  }
  return signedRequest('POST', '/api/v3/order', params);
}

module.exports = { setCreds, isConnected, disconnect, getAccount, placeMarketOrder };
