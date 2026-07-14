// Option pricing engine: Black-Scholes analytic prices + greeks, CRR binomial
// (American exercise, convergence check), and a Newton/bisection implied-vol
// solver. The vol surface is synthesized from realized vol on the perp's own
// 1h candles with a standard crypto smile. Every response reports compute time
// — the full chain (5 expiries × 13 strikes × calls+puts, all greeks) prices
// in well under 5ms.
//
// Numerical-stability notes (deliberate, this is half the point of the module):
//  - Φ(x) uses erfc-style Hastings rational approx, accurate to ~1e-7 and safe
//    in the deep tails where naive series expansions blow up.
//  - d1/d2 guard σ√T → 0 (expiry / zero vol) so deep ITM/OTM converge to
//    intrinsic value instead of NaN from a 0/0.
//  - The IV solver switches from Newton to bisection when vega collapses
//    (deep ITM/OTM), where Newton diverges.
const data = require('./data');

/* ---------- stable normal distribution helpers ---------- */
function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
// Hastings/Zelen-Severo rational approximation of Φ via the tail; |ε| < 7.5e-8
function normCdf(x) {
  if (x > 8) return 1;         // beyond 8σ the double is exactly 1 anyway
  if (x < -8) return 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = normPdf(x) * poly;
  return x >= 0 ? 1 - tail : tail;
}

/* ---------- Black-Scholes price + full greeks ---------- */
function blackScholes({ S, K, T, sigma, r = 0, type = 'call' }) {
  // guard the σ√T → 0 corner: option collapses to discounted intrinsic
  const sT = sigma * Math.sqrt(T);
  if (!(T > 0) || !(sigma > 0) || sT < 1e-10) {
    const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: type === 'call' ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sT;
  const d2 = d1 - sT;
  const Nd1 = normCdf(d1), Nd2 = normCdf(d2), pdf1 = normPdf(d1);
  const disc = Math.exp(-r * T);

  let price, delta, theta, rho;
  if (type === 'call') {
    price = S * Nd1 - K * disc * Nd2;
    delta = Nd1;
    theta = (-S * pdf1 * sigma / (2 * Math.sqrt(T)) - r * K * disc * Nd2) / 365; // per-day
    rho = K * T * disc * Nd2 / 100;
  } else {
    price = K * disc * normCdf(-d2) - S * normCdf(-d1);
    delta = Nd1 - 1;
    theta = (-S * pdf1 * sigma / (2 * Math.sqrt(T)) + r * K * disc * normCdf(-d2)) / 365;
    rho = -K * T * disc * normCdf(-d2) / 100;
  }
  const gamma = pdf1 / (S * sT);
  const vega = S * pdf1 * Math.sqrt(T) / 100; // per 1 vol-point
  return { price, delta, gamma, vega, theta, rho };
}

/* ---------- CRR binomial (American or European exercise) ----------
   The early-exercise premium must be measured against a EUROPEAN price from
   the SAME tree — comparing binomial-American to analytic-BS mixes the real
   premium with O(1/steps) discretization error and can even go negative. */
function binomial({ S, K, T, sigma, r = 0, type = 'put', steps = 256, american = true }) {
  const dt = T / steps;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp(r * dt) - d) / (u - d);
  const discount = Math.exp(-r * dt);
  const payoff = (s) => (type === 'call' ? Math.max(0, s - K) : Math.max(0, K - s));

  // terminal layer, then roll back (with early-exercise check if American)
  const v = new Array(steps + 1);
  for (let i = 0; i <= steps; i++) v[i] = payoff(S * Math.pow(u, i) * Math.pow(d, steps - i));
  for (let n = steps - 1; n >= 0; n--) {
    for (let i = 0; i <= n; i++) {
      const cont = discount * (p * v[i + 1] + (1 - p) * v[i]);
      v[i] = american ? Math.max(cont, payoff(S * Math.pow(u, i) * Math.pow(d, n - i))) : cont;
    }
  }
  return v[0];
}
const binomialAmerican = (args) => binomial({ ...args, american: true });

/* ---------- implied vol: Newton with bisection fallback ---------- */
function impliedVol({ S, K, T, price, r = 0, type = 'call' }) {
  let sigma = 0.6; // sensible crypto seed
  for (let i = 0; i < 24; i++) {
    const { price: p, vega } = blackScholes({ S, K, T, sigma, r, type });
    const diff = p - price;
    if (Math.abs(diff) < 1e-7 * S) return { iv: sigma, iterations: i + 1, method: 'newton' };
    if (vega * 100 < 1e-8 * S) break; // vega collapsed — Newton would explode
    sigma = Math.max(0.01, Math.min(5, sigma - diff / (vega * 100)));
  }
  // bisection: slow but unconditionally convergent
  let lo = 0.01, hi = 5;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const { price: p } = blackScholes({ S, K, T, sigma: mid, r, type });
    if (p > price) hi = mid; else lo = mid;
  }
  return { iv: (lo + hi) / 2, iterations: 80, method: 'bisection' };
}

/* ---------- realized vol from the perp's own candles ---------- */
function realizedVol(candles, lambda = 0.94) {
  // EWMA of hourly log returns, annualized (RiskMetrics-style)
  let v = null;
  for (let i = 1; i < candles.length; i++) {
    const r = Math.log(candles[i].close / candles[i - 1].close);
    v = v == null ? r * r : lambda * v + (1 - lambda) * r * r;
  }
  return Math.sqrt((v || 0) * 24 * 365);
}

// crypto-typical smile: OTM wings richer, slight put skew
function smileIv(base, S, K, T) {
  const m = Math.log(K / S) / Math.sqrt(Math.max(T, 1 / 365)); // normalized moneyness
  return Math.max(0.05, base * (1 + 0.35 * m * m - 0.08 * m));
}

const EXPIRIES_D = [1, 7, 14, 30, 90];

/** Full chain for one underlying + timing benchmark. */
async function getChain(binanceSymbol) {
  const candles = await data.hourlyKlines(binanceSymbol, 800);
  const S = candles[candles.length - 1].close;
  const rv = realizedVol(candles);

  const t0 = process.hrtime.bigint();
  const surface = EXPIRIES_D.map((days) => {
    const T = days / 365;
    const strikes = [];
    for (let i = -6; i <= 6; i++) {
      const K = S * (1 + i * 0.05); // 70%..130% moneyness, 13 strikes
      const iv = smileIv(rv, S, K, T);
      const call = blackScholes({ S, K, T, sigma: iv, type: 'call' });
      const put = blackScholes({ S, K, T, sigma: iv, type: 'put' });
      // round-trip check: recover the IV we priced with (numerical sanity)
      const ivCheck = impliedVol({ S, K, T, price: call.price, type: 'call' });
      strikes.push({ K: +K.toFixed(6), iv: +iv.toFixed(4), ivRecovered: +ivCheck.iv.toFixed(4), ivMethod: ivCheck.method, call, put });
    }
    return { expiryDays: days, strikes };
  });
  const chainNs = Number(process.hrtime.bigint() - t0);

  // benchmark: reprice the whole chain 200× for a stable per-chain time
  const bench0 = process.hrtime.bigint();
  const REPS = 200;
  for (let rep = 0; rep < REPS; rep++) {
    for (const exp of surface) {
      const T = exp.expiryDays / 365;
      for (const row of exp.strikes) {
        blackScholes({ S, K: row.K, T, sigma: row.iv, type: 'call' });
        blackScholes({ S, K: row.K, T, sigma: row.iv, type: 'put' });
      }
    }
  }
  const perChainMs = Number(process.hrtime.bigint() - bench0) / 1e6 / REPS;

  // American-vs-European demo (30d ATM put, r=5% so the premium is non-trivial):
  // same 256-step tree for both exercise styles isolates the true premium.
  const T30 = 30 / 365, rDemo = 0.05;
  const atmIv = smileIv(rv, S, S, T30);
  const euro = binomial({ S, K: S, T: T30, sigma: atmIv, r: rDemo, type: 'put', steps: 256, american: false });
  const amer = binomial({ S, K: S, T: T30, sigma: atmIv, r: rDemo, type: 'put', steps: 256, american: true });
  const amerCoarse = binomial({ S, K: S, T: T30, sigma: atmIv, r: rDemo, type: 'put', steps: 32, american: true });

  const nOptions = surface.length * surface[0].strikes.length * 2;
  return {
    symbol: binanceSymbol, spot: S, realizedVol: +rv.toFixed(4),
    surface,
    timing: {
      firstChainMs: +(chainNs / 1e6).toFixed(3),
      avgChainMs: +perChainMs.toFixed(3),
      perOptionUs: +((perChainMs * 1000) / nOptions).toFixed(2),
      nOptions,
    },
    american: {
      note: '30d ATM put @ r=5% — same 256-step CRR tree for both exercise styles',
      european: +euro.toFixed(4), american256: +amer.toFixed(4), american32: +amerCoarse.toFixed(4),
      earlyExercisePremium: +(amer - euro).toFixed(6),
      convergenceGap32vs256: +Math.abs(amer - amerCoarse).toFixed(6),
    },
  };
}

module.exports = { getChain, blackScholes, binomial, binomialAmerican, impliedVol, realizedVol };
