// Polymarket Quant Engine in pure JS.
// Implements Particle Filter, Monte Carlo simulation, volatility estimation,
// and Kelly Criterion edge detection for prediction contracts.

const filters = new Map();

// Math helpers
function logit(p) {
  p = Math.max(0.0001, Math.min(0.9999, p));
  return Math.log(p / (1 - p));
}

function expit(x) {
  return 1 / (1 + Math.exp(-x));
}

function randomNormal(mean = 0, std = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return num * std + mean;
}

// Abramowitz & Stegun rational approximation for inverse normal CDF
function ndtri(p) {
  if (p <= 0 || p >= 1) return 0;
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;
  
  const t = Math.sqrt(-2.0 * Math.log(p < 0.5 ? p : 1.0 - p));
  const num = c0 + c1 * t + c2 * t * t;
  const den = 1.0 + d1 * t + d2 * t * t + d3 * t * t * t;
  const z = t - num / den;
  return p < 0.5 ? -z : z;
}

class ParticleFilter {
  constructor(priorProb, nParticles = 1000, processVol = 0.03, obsNoise = 0.04) {
    this.n = nParticles;
    this.processVol = processVol;
    this.obsNoise = obsNoise;
    const logitPrior = logit(priorProb);
    this.logitParticles = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.logitParticles[i] = logitPrior + randomNormal(0, 0.5);
    }
    this.weights = new Float64Array(this.n).fill(1 / this.n);
  }

  update(observedPrice) {
    const obs = Math.max(0.01, Math.min(0.99, observedPrice));
    const logWeights = new Float64Array(this.n);
    let maxLogWeight = -Infinity;

    for (let i = 0; i < this.n; i++) {
      // 1. Propagate (random walk in logit space)
      this.logitParticles[i] += randomNormal(0, this.processVol);
      // 2. Map to probability space
      const p = expit(this.logitParticles[i]);
      // 3. Log likelihood under Gaussian observation noise
      const diff = (obs - p) / this.obsNoise;
      const logLikelihood = -0.5 * diff * diff;
      logWeights[i] = Math.log(this.weights[i] + 1e-300) + logLikelihood;
      if (logWeights[i] > maxLogWeight) maxLogWeight = logWeights[i];
    }

    // Normalize in log space to prevent underflow
    let sumWeights = 0;
    for (let i = 0; i < this.n; i++) {
      this.weights[i] = Math.exp(logWeights[i] - maxLogWeight);
      sumWeights += this.weights[i];
    }

    // Normalize weights and compute ESS
    let sumSqWeights = 0;
    for (let i = 0; i < this.n; i++) {
      this.weights[i] /= sumWeights;
      sumSqWeights += this.weights[i] * this.weights[i];
    }

    // Systematic resampling if ESS falls below N / 2
    const ess = 1.0 / sumSqWeights;
    if (ess < this.n / 2) {
      this._systematicResample();
    }
  }

  _systematicResample() {
    const cumsum = new Float64Array(this.n);
    let sum = 0;
    for (let i = 0; i < this.n; i++) {
      sum += this.weights[i];
      cumsum[i] = sum;
    }
    const step = 1.0 / this.n;
    const start = Math.random() / this.n;
    const newLogits = new Float64Array(this.n);
    let idx = 0;
    for (let i = 0; i < this.n; i++) {
      const u = start + i * step;
      while (idx < this.n - 1 && cumsum[idx] < u) {
        idx++;
      }
      newLogits[i] = this.logitParticles[idx];
    }
    this.logitParticles = newLogits;
    this.weights.fill(1.0 / this.n);
  }

  estimate() {
    let est = 0;
    for (let i = 0; i < this.n; i++) {
      est += expit(this.logitParticles[i]) * this.weights[i];
    }
    return est;
  }

  credibleInterval(alpha = 0.05) {
    const pairs = [];
    for (let i = 0; i < this.n; i++) {
      pairs.push({ p: expit(this.logitParticles[i]), w: this.weights[i] });
    }
    pairs.sort((a, b) => a.p - b.p);

    let cumw = 0;
    let lower = pairs[0].p;
    let upper = pairs[this.n - 1].p;
    let foundLower = false;
    for (let i = 0; i < this.n; i++) {
      cumw += pairs[i].w;
      if (!foundLower && cumw >= alpha / 2) {
        lower = pairs[i].p;
        foundLower = true;
      }
      if (cumw >= 1.0 - alpha / 2) {
        upper = pairs[i].p;
        break;
      }
    }
    return [lower, upper];
  }

  uncertainty() {
    const est = this.estimate();
    let variance = 0;
    for (let i = 0; i < this.n; i++) {
      const p = expit(this.logitParticles[i]);
      variance += this.weights[i] * (p - est) * (p - est);
    }
    return Math.sqrt(variance);
  }
}

function monteCarloBinary(currentPrice, volEstimate, timeToExpiryDays, nPaths = 2000) {
  if (timeToExpiryDays <= 0) {
    return { probability: currentPrice, stdError: 0.0, ci_95: [currentPrice, currentPrice] };
  }
  const T = timeToExpiryDays / 365.0;
  const logit_p = logit(currentPrice);
  let logit_vol = volEstimate / Math.max(currentPrice * (1.0 - currentPrice), 0.01);
  logit_vol = Math.min(logit_vol, 5.0);

  const nStrata = 10;
  const perStratum = Math.floor(nPaths / (nStrata * 2));
  const terminalProbs = [];

  for (let j = 0; j < nStrata; j++) {
    let stratumProbSum = 0;
    for (let k = 0; k < perStratum; k++) {
      const u = (j + Math.random()) / nStrata;
      const z = ndtri(u);
      
      // Antithetic path pair
      const logitTerm1 = logit_p + logit_vol * Math.sqrt(T) * z;
      const logitTerm2 = logit_p - logit_vol * Math.sqrt(T) * z;
      stratumProbSum += expit(logitTerm1) + expit(logitTerm2);
    }
    terminalProbs.push(stratumProbSum / (perStratum * 2));
  }

  const p_hat = terminalProbs.reduce((a, b) => a + b, 0) / terminalProbs.length;
  let variance = 0;
  for (const p of terminalProbs) {
    variance += (p - p_hat) * (p - p_hat);
  }
  const se = Math.sqrt(variance / terminalProbs.length) / Math.sqrt(terminalProbs.length);

  return {
    probability: Math.max(0, Math.min(1, p_hat)),
    stdError: se,
    ci_95: [Math.max(0, p_hat - 1.96 * se), Math.min(1, p_hat + 1.96 * se)]
  };
}

function estimateVolatility(history) {
  if (!history || history.length < 5) return 0.20;
  const prices = history.map(h => +h.price || +h.p || 0).filter(p => p > 0.01);
  const timestamps = history.map(h => +h.timestamp || +h.t || 0);
  if (prices.length < 5) return 0.20;

  const logReturns = [];
  for (let i = 1; i < prices.length; i++) {
    logReturns.push(Math.log(prices[i] / prices[i - 1]));
  }
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / logReturns.length;
  const sampleVol = Math.sqrt(variance);

  if (timestamps.length >= 2 && timestamps[0] > 0) {
    const totalSec = timestamps[timestamps.length - 1] - timestamps[0];
    const avgSec = totalSec / (timestamps.length - 1);
    const periodsPerYear = (365.25 * 24 * 3600) / Math.max(avgSec, 1);
    const annualVol = sampleVol * Math.sqrt(periodsPerYear);
    return Math.max(0.05, Math.min(2.0, annualVol));
  }
  return Math.max(0.05, Math.min(2.0, sampleVol * Math.sqrt(365)));
}

function kellyCriterion(edge, odds) {
  if (odds <= 0 || edge <= 0) return 0.0;
  const p = edge + (1.0 / (1.0 + odds));
  const q = 1.0 - p;
  const f = (p * odds - q) / odds;
  return Math.max(0.0, Math.min(f * 0.5, 0.25)); // Half-Kelly capped at 25%
}

function detectEdge(modelProb, marketPrice, threshold = 0.05) {
  const edge = modelProb - marketPrice;
  if (Math.abs(edge) < threshold) {
    return { action: 'HOLD', edge, confidence: 0, direction: null };
  }
  const confidence = Math.min(100, Math.round(50 + Math.abs(edge) * 200));
  if (edge > 0) {
    const odds = (1.0 / marketPrice) - 1.0;
    const kelly = kellyCriterion(edge, odds);
    return { action: 'BUY_YES', edge, confidence, direction: 'YES', kellyFraction: kelly };
  } else {
    const noPrice = 1.0 - marketPrice;
    const odds = (1.0 / noPrice) - 1.0;
    const kelly = kellyCriterion(-edge, odds);
    return { action: 'BUY_NO', edge, confidence, direction: 'NO', kellyFraction: kelly };
  }
}

async function getQuantAnalysis(marketId, clobTokenId, currentPrice, endDateStr) {
  let priceHistory = [];
  let vol = 0.20;

  // 1. Fetch CLOB price history if we have a token ID
  if (clobTokenId) {
    try {
      const res = await fetch(`https://clob.polymarket.com/prices-history?market=${clobTokenId}&interval=1w&fidelity=60`, {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.history)) {
          priceHistory = data.history;
          vol = estimateVolatility(priceHistory);
        }
      }
    } catch (err) {
      console.warn(`[quantEngine] failed to fetch price history for token ${clobTokenId}:`, err.message);
    }
  }

  // 2. Manage/get the Particle Filter
  let pf = filters.get(marketId);
  if (!pf) {
    const prior = priceHistory.length > 0 ? (+priceHistory[0].price || +priceHistory[0].p || currentPrice) : currentPrice;
    pf = new ParticleFilter(prior);
    // Warm up the particle filter with history
    for (const h of priceHistory) {
      const hp = +h.price || +h.p || 0;
      if (hp > 0) pf.update(hp);
    }
    filters.set(marketId, pf);
  }
  // Feed the latest price to the filter
  pf.update(currentPrice);

  // 3. Days to expiry
  let daysToExpiry = 30; // Default
  if (endDateStr) {
    try {
      const end = new Date(endDateStr);
      const diffMs = end - new Date();
      daysToExpiry = Math.max(0.1, diffMs / (1000 * 24 * 3600));
    } catch {}
  }

  // 4. Run Monte Carlo simulation
  const mc = monteCarloBinary(currentPrice, vol, daysToExpiry);

  // 5. Ensemble estimation: 60% Particle Filter, 40% Monte Carlo
  const modelProb = 0.6 * pf.estimate() + 0.4 * mc.probability;
  const signal = detectEdge(modelProb, currentPrice);
  const ci = pf.credibleInterval();

  return {
    modelProbability: +modelProb.toFixed(3),
    credibleInterval: [ +ci[0].toFixed(3), +ci[1].toFixed(3) ],
    uncertainty: +pf.uncertainty().toFixed(3),
    mcProbability: +mc.probability.toFixed(3),
    volatility: +vol.toFixed(3),
    daysToExpiry: +daysToExpiry.toFixed(1),
    signal,
  };
}

// Simple test mode if executed directly
if (process.argv.includes('--test')) {
  console.log('--- Testing Quant Engine JS ---');
  const pf = new ParticleFilter(0.5);
  console.log('PF init estimate (should be ~0.5):', pf.estimate());
  pf.update(0.55);
  pf.update(0.58);
  console.log('PF updated estimate:', pf.estimate());
  console.log('PF Credible Interval [95%]:', pf.credibleInterval());
  console.log('PF Uncertainty (std dev):', pf.uncertainty());

  const mc = monteCarloBinary(0.55, 0.20, 10);
  console.log('MC binary estimate for 0.55, 20% vol, 10 days:', mc.probability, 'CI:', mc.ci_95);

  const edge = detectEdge(0.62, 0.55);
  console.log('Edge detection (model 0.62 vs market 0.55):', edge);
  console.log('Test complete.');
}

module.exports = { ParticleFilter, monteCarloBinary, estimateVolatility, detectEdge, getQuantAnalysis };
