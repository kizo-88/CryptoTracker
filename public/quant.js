/* Quant Lab — frontend. 9 modules: quant trade/autotrade, options engine,
   factor model, HFT simulator (client-side, 1ms ticks), ML alpha, arbitrage,
   optimizer, risk engine, stat-arb. Tabs lazy-load on first open. */
const $ = (sel) => document.querySelector(sel);

/* ---------------- backend host (same logic as app.js) ---------------- */
function upgradeHttp(url) {
  if (location.protocol === 'https:' && /^http:\/\//i.test(url) &&
      !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(url)) {
    return url.replace(/^http:\/\//i, 'https://');
  }
  return url;
}
function getApiHost() {
  const saved = localStorage.getItem('apiHost');
  if (saved != null && saved !== '') return upgradeHttp(saved);
  return '';
}
async function apiJson(path, opts = {}) {
  const { timeout = 60000, ...init } = opts;
  const res = await fetch(getApiHost() + path, { signal: AbortSignal.timeout(timeout), ...init });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('backend returned non-JSON (offline?)'); }
  if (json && json.error) throw new Error(json.error);
  if (!res.ok) throw new Error(`backend HTTP ${res.status}`);
  return json;
}

const fmt = (n, d = 2) => (n == null ? '–' : (+n).toLocaleString('en-US', { maximumFractionDigits: d }));
const fmtPx = (p) => (p == null ? '–' : p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 2 }) : p >= 1 ? p.toFixed(4) : p.toFixed(6));
const signCls = (v) => (v >= 0 ? 'up' : 'down');
const signTxt = (v, d = 2) => `${v >= 0 ? '+' : ''}${fmt(v, d)}`;

setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('en-GB') + ' LOCAL'; }, 1000);

/* ---------------- palette (shared terminal theme) ---------------- */
const C = { green: '#16c784', red: '#ea3943', amber: '#f0b90b', blue: '#3b82f6', purple: '#a855f7', dim: '#5c6c8a', text: '#c8d4e8', grid: '#131b2c' };

/* ---------------- canvas helpers (DPR-aware) ---------------- */
function ctx2d(cv) {
  const cssW = cv.clientWidth || cv.parentElement.clientWidth || 600;
  const cssH = +cv.getAttribute('height') || 220;
  const dpr = window.devicePixelRatio || 1;
  cv.width = cssW * dpr; cv.height = cssH * dpr;
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = '10px Consolas, monospace';
  return { ctx, W: cssW, H: cssH };
}

/* multi-series line chart: series = [{name, color, values:[y…]}] on a shared x-index */
function drawLines(cv, series, { yFmt = (v) => fmt(v, 2), pad = { l: 46, r: 10, t: 10, b: 16 }, zeroLine = false, guides = [] } = {}) {
  const { ctx, W, H } = ctx2d(cv);
  const all = series.flatMap((s) => s.values).filter((v) => v != null && isFinite(v));
  if (!all.length) { ctx.fillStyle = C.dim; ctx.fillText('no data', 12, 20); return; }
  let lo = Math.min(...all, ...guides.map((g) => g.y)), hi = Math.max(...all, ...guides.map((g) => g.y));
  if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const span = hi - lo || 1;
  lo -= span * 0.06; hi += span * 0.06;
  const n = Math.max(...series.map((s) => s.values.length));
  const X = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);

  // recessive grid + y labels (text tokens, not series colors)
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.dim; ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const v = lo + ((hi - lo) * g) / 3;
    const y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(yFmt(v), 4, y + 3);
  }
  for (const g of guides) {
    ctx.strokeStyle = g.color; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(pad.l, Y(g.y)); ctx.lineTo(W - pad.r, Y(g.y)); ctx.stroke();
    ctx.setLineDash([]);
    if (g.label) { ctx.fillStyle = g.color; ctx.fillText(g.label, W - pad.r - ctx.measureText(g.label).width, Y(g.y) - 4); }
  }
  // series: thin 2px lines
  for (const s of series) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.beginPath();
    s.values.forEach((v, i) => {
      if (v == null || !isFinite(v)) return;
      const x = X(i), y = Y(v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  // legend (only when ≥2 series)
  if (series.length >= 2) {
    let lx = pad.l + 6;
    for (const s of series) {
      ctx.fillStyle = s.color; ctx.fillRect(lx, 8, 10, 3);
      ctx.fillStyle = C.text; ctx.fillText(s.name, lx + 14, 13);
      lx += 24 + ctx.measureText(s.name).width;
    }
  }
}

/* vertical histogram with optional vertical marker lines (x in value units) */
function drawHist(cv, bins, { vlines = [], xFmt = (v) => fmt(v, 2) } = {}) {
  const { ctx, W, H } = ctx2d(cv);
  if (!bins.length) return;
  const pad = { l: 10, r: 10, t: 12, b: 18 };
  const maxC = Math.max(...bins.map((b) => b.count), 1);
  const x0 = bins[0].lo, x1 = bins[bins.length - 1].lo + (bins[1] ? bins[1].lo - bins[0].lo : 1);
  const X = (v) => pad.l + ((v - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const bw = (W - pad.l - pad.r) / bins.length;
  bins.forEach((b, i) => {
    const h = (b.count / maxC) * (H - pad.t - pad.b);
    ctx.fillStyle = 'rgba(59,130,246,.55)';
    // 4px rounded data-end, 2px gap between bars
    const x = pad.l + i * bw + 1, y = H - pad.b - h;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, Math.max(1, bw - 2), h, [3, 3, 0, 0]) : ctx.rect(x, y, Math.max(1, bw - 2), h);
    ctx.fill();
  });
  ctx.fillStyle = C.dim;
  ctx.fillText(xFmt(x0), pad.l, H - 5);
  const endTxt = xFmt(x1);
  ctx.fillText(endTxt, W - pad.r - ctx.measureText(endTxt).width, H - 5);
  for (const vl of vlines) {
    const x = X(vl.x);
    if (x < pad.l || x > W - pad.r) continue;
    ctx.strokeStyle = vl.color; ctx.lineWidth = 2; ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = vl.color; ctx.fillText(vl.label, Math.min(x + 4, W - 90), pad.t + 8);
  }
}

const barRow = (name, pct, max, color = '', right = null) => `
  <div class="q-bar-row">
    <span class="nm" title="${name}">${name}</span>
    <span class="q-bar"><i class="${color}" style="left:0;width:${Math.min(100, (Math.abs(pct) / (max || 1)) * 100)}%"></i></span>
    <span class="val">${right != null ? right : fmt(pct, 1) + '%'}</span>
  </div>`;

const cards = (arr) => `<div class="q-cards">${arr.map((c) => `
  <div class="q-card"><div class="k">${c.k}</div><div class="v ${c.cls || ''}">${c.v}</div>${c.s ? `<div class="s">${c.s}</div>` : ''}</div>`).join('')}</div>`;

/* ---------------- tabs (lazy init) ---------------- */
const inited = {};
let activeTab = 'trade';
const TAB_INIT = { trade: initTrade, options: initOptions, factors: initFactors, hft: initHft, ml: initMl, arb: initArb, optimizer: initOptimizer, risk: initRisk, statarb: initStatarb };

document.querySelectorAll('#q-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#q-tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.q-tab').forEach((t) => t.classList.add('hidden'));
    activeTab = btn.dataset.tab;
    $(`#tab-${activeTab}`).classList.remove('hidden');
    if (!inited[activeTab]) { inited[activeTab] = true; TAB_INIT[activeTab](); }
  });
});

async function setStatus() {
  try {
    const uni = await apiJson('/api/quant/universe');
    $('#q-status').innerHTML = `<span>UNIVERSE <b>${uni.length} PERPS</b></span><span>ENGINES <b class="up">9 ONLINE</b></span>`;
    window.__universe = uni;
  } catch (e) {
    $('#q-status').innerHTML = `<span class="down">⚠ backend offline — ${e.message}. Set the backend in the main terminal's CONNECT panel.</span>`;
  }
}

/* ============================================================ */
/* TAB 1: QUANT TRADE                                            */
/* ============================================================ */
let qtChart, qtSeries, qtLines = [];
let qtPoll = null;

async function initTrade() {
  const uni = window.__universe || (await apiJson('/api/quant/universe').catch(() => []));
  // tradfi symbols (XAU/XAG/WTI via Yahoo) come first in the list; default stays BTC
  $('#qt-symbol').innerHTML = uni.slice(0, 43).map((u) => `<option value="${u.symbol}">${u.base}${u.yahoo ? ' ◆' : ''}</option>`).join('') || '<option value="BTCUSDT">BTC</option>';
  if (uni.some((u) => u.symbol === 'BTCUSDT')) $('#qt-symbol').value = 'BTCUSDT';

  qtChart = LightweightCharts.createChart($('#qt-chart'), {
    layout: { background: { color: 'transparent' }, textColor: C.dim, fontFamily: 'Consolas, monospace' },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: '#1e293f' },
    timeScale: { borderColor: '#1e293f', timeVisible: true },
    autoSize: true,
  });
  qtSeries = qtChart.addCandlestickSeries({ upColor: C.green, downColor: C.red, wickUpColor: C.green, wickDownColor: C.red, borderVisible: false });

  $('#qt-refresh').addEventListener('click', loadTrade);
  $('#qt-symbol').addEventListener('change', loadTrade);
  loadTrade();
  loadQuantBot();
  loadQuantPositions();
  qtPoll = setInterval(() => { if (activeTab === 'trade') { loadQuantPositions(); } }, 6000);
  setInterval(() => { if (activeTab === 'trade') loadQuantBot(); }, 15000);
}

async function loadTrade() {
  const sym = $('#qt-symbol').value || 'BTCUSDT';
  $('#qt-symbol-label').textContent = sym;
  $('#qt-signal').innerHTML = '<div class="loading">running quant ensemble…</div>';
  loadCrossover(sym);
  try {
    // tradfi symbols chart via the Yahoo signal route; crypto via Binance
    const uniEntry = (window.__universe || []).find((u) => u.symbol === sym);
    const candlePath = uniEntry?.yahoo
      ? `/api/signal?source=yahoo&symbol=${encodeURIComponent(uniEntry.yahoo)}&interval=1h`
      : `/api/signal?binance=${sym}&interval=1h`;
    const [candleData, sig] = await Promise.all([
      apiJson(candlePath),
      apiJson(`/api/quant/signal?binance=${sym}`),
    ]);
    qtSeries.setData(candleData.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    qtChart.timeScale().fitContent();
    qtLines.forEach((l) => qtSeries.removePriceLine(l));
    qtLines = [];
    const mk = (price, color, title, solid = false) => qtLines.push(qtSeries.createPriceLine({
      price, color, lineWidth: solid ? 2 : 1,
      lineStyle: solid ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true, title,
    }));
    mk(sig.entry, C.blue, `◄ QUANT ${sig.direction}`, true);
    mk(sig.stopLoss, C.red, 'SL');
    sig.takeProfits.forEach((tp) => mk(tp.price, C.green, tp.label));

    const compBar = (label, z) => {
      if (z == null) return `<div class="q-comp-row"><span class="lbl">${label}</span><span class="track"></span><span class="zv">n/a</span></div>`;
      const w = Math.min(50, Math.abs(z) * 16.6);
      const col = z >= 0 ? C.green : C.red;
      const left = z >= 0 ? '50%' : `${50 - w}%`;
      return `<div class="q-comp-row"><span class="lbl">${label}</span>
        <span class="track"><i style="left:${left};width:${w}%;background:${col}"></i></span>
        <span class="zv">${signTxt(z, 2)}σ</span></div>`;
    };
    $('#qt-signal').innerHTML = `
      <div class="q-sig-dir ${sig.direction}">${sig.direction}
        <small>confidence ${sig.confidence}% · ensemble score ${signTxt(sig.score, 2)}</small></div>
      <div class="q-comp">
        ${compBar('ML ALPHA', sig.components.ml)}
        ${compBar('MOMENTUM', sig.components.momentum)}
        ${compBar('MEAN-REV', sig.components.meanReversion)}
      </div>
      <div class="q-kv">
        <div><span>ENTRY</span><b>$${fmtPx(sig.entry)}</b></div>
        <div><span>STOP LOSS</span><b style="color:${C.red}">$${fmtPx(sig.stopLoss)}</b></div>
        ${sig.takeProfits.map((tp) => `<div><span>${tp.label} (${tp.r}R)</span><b style="color:${C.green}">$${fmtPx(tp.price)}</b></div>`).join('')}
        <div><span>ATR(14) 1H</span><b>${fmtPx(sig.atr)}</b></div>
      </div>`;
  } catch (e) {
    $('#qt-signal').innerHTML = `<div class="loading">⚠ ${e.message}</div>`;
  }
}

function setQuantToggle(on) {
  const b = $('#btn-toggle-quant');
  b.classList.toggle('on', on); b.classList.toggle('off', !on);
  b.textContent = on ? '■ STOP QUANT AUTO-TRADE' : '▶ START QUANT AUTO-TRADE';
  $('#qbot-dot').className = on ? 'dot on' : 'dot off';
}
async function loadQuantBot() {
  try {
    const st = await apiJson('/api/autotrade/status');
    const q = st.quant || {};
    setQuantToggle(!!q.enabled);
    if (document.activeElement?.tagName !== 'INPUT') {
      $('#qbot-mode').value = q.mode || 'paper';
      $('#qbot-conf').value = q.minConfidence ?? 60;
      $('#qbot-size').value = q.usdtPerTrade ?? 100;
      $('#qbot-lev').value = q.leverage ?? 3;
      $('#qbot-max').value = q.maxPositions ?? 4;
      $('#qbot-interval').value = q.intervalMin ?? 15;
    }
  } catch { /* offline */ }
}
async function applyQuantBot(enabled) {
  const mode = $('#qbot-mode').value;
  if (enabled && mode === 'live' &&
      !confirm('Start LIVE quant auto-trading on MEXC FUTURES? Real leveraged orders will be placed automatically.')) return;
  setQuantToggle(enabled);
  try {
    await apiJson('/api/autotrade/configure', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        market: 'quant',
        config: {
          enabled, mode,
          minConfidence: $('#qbot-conf').value, usdtPerTrade: $('#qbot-size').value,
          leverage: $('#qbot-lev').value, maxPositions: $('#qbot-max').value,
          intervalMin: $('#qbot-interval').value,
        },
      }),
    });
  } catch (e) { alert(`quant bot config failed: ${e.message}`); }
  loadQuantBot();
}
$('#btn-toggle-quant').addEventListener('click', () => applyQuantBot(!$('#btn-toggle-quant').classList.contains('on')));
$('#btn-save-quant').addEventListener('click', () => applyQuantBot($('#btn-toggle-quant').classList.contains('on')));

async function loadQuantPositions() {
  try {
    const snap = await apiJson('/api/portfolio');
    const pos = (snap.positions || []).filter((p) => p.source === 'quant');
    if (!pos.length) { $('#qt-positions').innerHTML = '<div class="hint">no quant positions yet — start the bot or lower min confidence</div>'; return; }
    $('#qt-positions').innerHTML = `<table class="trade-table"><thead><tr>
      <th>ASSET</th><th>SIDE</th><th class="num">ENTRY</th><th class="num">MARK</th><th class="num">SL / TP</th><th class="num">PNL</th><th></th>
    </tr></thead><tbody>${pos.map((p) => `<tr>
      <td><b>${p.symbol}</b> <span class="hint">${p.leverage}×</span></td>
      <td><span class="badge ${p.side === 'LONG' ? 'BUY' : 'SELL'}">${p.side}</span></td>
      <td class="num">$${fmtPx(p.entry)}</td><td class="num">$${fmtPx(p.markPrice)}</td>
      <td class="num">${p.sl != null ? fmtPx(p.sl) : '–'} / ${p.tp != null ? fmtPx(p.tp) : '–'}</td>
      <td class="num"><span class="${signCls(p.uPnl ?? 0)}">${signTxt(p.uPnl ?? 0)}$ (${signTxt(p.uPnlPct ?? 0, 1)}%)</span></td>
      <td><button class="btn-close-pos" data-id="${p.id}" data-px="${p.markPrice}">CLOSE</button></td>
    </tr>`).join('')}</tbody></table>`;
    $('#qt-positions').querySelectorAll('.btn-close-pos').forEach((b) => b.addEventListener('click', async () => {
      try {
        await apiJson('/api/trade/close', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ market: 'crypto', id: b.dataset.id, price: +b.dataset.px }) });
        loadQuantPositions();
      } catch (e) { alert(e.message); }
    }));
  } catch { /* offline */ }
}

/* ----- SMA 5/20 crossover monitor (the XAUUSD-study strategy) ----- */
async function loadCrossover(sym) {
  $('#xm-symbol').textContent = sym;
  try {
    const d = await apiJson(`/api/quant/crossover?symbol=${sym}&fast=5&slow=20`);
    const c2 = d.current;
    if (!c2) { $('#xm-body').innerHTML = '<div class="hint">no crossover state yet</div>'; return; }
    const sideCls = c2.side === 'LONG' ? 'up' : 'down';
    $('#xm-body').innerHTML = `
      ${cards([
        { k: 'CURRENT SIGNAL', v: c2.side, cls: sideCls, s: 'since ' + new Date(c2.since * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
        { k: 'LEG ENTRY → NOW', v: `$${fmtPx(c2.entry)} → $${fmtPx(c2.price)}` },
        { k: 'OPEN LEG P&L', v: signTxt(c2.legPnlPct, 2) + '%', cls: signCls(c2.legPnlPct) },
        { k: `WINDOW (${d.windowDays}d, 1bp/side)`, v: signTxt(d.stats.totalPct, 1) + '%', cls: signCls(d.stats.totalPct), s: `Sharpe ${d.stats.sharpe} · ${d.stats.flips} flips · ${d.stats.hitPct}% legs won` },
      ])}
      <div class="hint">${d.note}</div>`;
    $('#xm-legs').innerHTML = d.legs.map((l) => `
      <div class="row">
        <span class="sym"><span class="${l.side === 'LONG' ? 'up' : 'down'}">${l.side === 'LONG' ? '▲' : '▼'}</span>
          ${new Date(l.time * 1000).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          <span class="hint">@ ${fmtPx(l.price)}</span></span>
        <b class="${signCls(l.pnlPct)}">${signTxt(l.pnlPct, 2)}%${l.open ? ' <span class="hint">open</span>' : ''}</b>
      </div>`).join('') || '<div class="hint">no flips in window</div>';
  } catch (e) {
    $('#xm-body').innerHTML = `<div class="hint">⚠ ${e.message}</div>`;
  }
}
setInterval(() => { if (activeTab === 'trade') loadCrossover($('#qt-symbol').value || 'BTCUSDT'); }, 5 * 60_000);

/* ============================================================ */
/* TAB 2: OPTIONS ENGINE                                         */
/* ============================================================ */
let optData = null, optExpiry = 30, optGreek = 'delta';

function initOptions() {
  $('#opt-run').addEventListener('click', loadOptions);
  $('#opt-symbol').addEventListener('change', loadOptions);
  loadOptions();
}
async function loadOptions() {
  $('#opt-timing').innerHTML = '<span class="q-badge amber">pricing…</span>';
  try {
    optData = await apiJson(`/api/quant/options?binance=${$('#opt-symbol').value}`);
    const t = optData.timing;
    $('#opt-timing').innerHTML = `
      <span class="q-badge green">CHAIN: ${t.avgChainMs} ms</span>
      <span class="q-badge">${t.perOptionUs} µs / option</span>
      <span class="q-badge">${t.nOptions} options + greeks</span>`;
    $('#opt-meta').innerHTML = cards([
      { k: 'SPOT (PERP)', v: '$' + fmtPx(optData.spot), cls: 'blue' },
      { k: 'REALIZED VOL (EWMA, ann.)', v: (optData.realizedVol * 100).toFixed(1) + '%', cls: 'amber' },
      { k: 'EXPIRIES × STRIKES', v: `${optData.surface.length} × ${optData.surface[0].strikes.length}` },
      { k: 'MODEL', v: 'BS + CRR-256', s: 'analytic greeks · American binomial' },
    ]);
    $('#opt-expiries').innerHTML = optData.surface.map((e) =>
      `<button class="btn-secondary opt-exp ${e.expiryDays === optExpiry ? 'active' : ''}" data-d="${e.expiryDays}" style="${e.expiryDays === optExpiry ? 'border-color:var(--amber);color:var(--amber)' : ''}">${e.expiryDays}D</button>`).join('') +
      ['delta', 'gamma', 'vega', 'theta'].map((g) =>
      `<button class="btn-secondary opt-greek" data-g="${g}" style="margin-left:${g === 'delta' ? '16px' : '0'};${g === optGreek ? 'border-color:var(--blue);color:var(--blue)' : ''}">${g.toUpperCase()}</button>`).join('');
    document.querySelectorAll('.opt-exp').forEach((b) => b.addEventListener('click', () => { optExpiry = +b.dataset.d; renderOptions(); }));
    document.querySelectorAll('.opt-greek').forEach((b) => b.addEventListener('click', () => { optGreek = b.dataset.g; renderOptions(); }));
    const a = optData.american;
    $('#opt-american').innerHTML = `
      <div><span>European put (BS)</span><b>$${fmt(a.european, 4)}</b></div>
      <div><span>American put (CRR 256)</span><b>$${fmt(a.american256, 4)}</b></div>
      <div><span>Early-exercise premium</span><b style="color:${C.amber}">$${fmt(a.earlyExercisePremium, 6)}</b></div>
      <div><span>Binomial 32 vs 256 steps</span><b>Δ $${fmt(a.convergenceGap32vs256, 6)}</b></div>
      <div><span>IV round-trip (price→IV)</span><b>${optData.surface[2].strikes.filter((s) => s.ivMethod === 'newton').length}/${optData.surface[2].strikes.length} Newton, rest bisection</b></div>
      <div><span>Tail stability</span><b>Φ(x) via rational erfc — no NaN at ±8σ</b></div>`;
    renderOptions();
  } catch (e) {
    $('#opt-timing').innerHTML = `<span class="q-badge" style="color:var(--red)">⚠ ${e.message}</span>`;
  }
}
function renderOptions() {
  if (!optData) return;
  document.querySelectorAll('.opt-exp').forEach((b) => { const on = +b.dataset.d === optExpiry; b.style.borderColor = on ? 'var(--amber)' : ''; b.style.color = on ? 'var(--amber)' : ''; });
  document.querySelectorAll('.opt-greek').forEach((b) => { const on = b.dataset.g === optGreek; b.style.borderColor = on ? 'var(--blue)' : ''; b.style.color = on ? 'var(--blue)' : ''; });
  const exp = optData.surface.find((e) => e.expiryDays === optExpiry) || optData.surface[0];
  const S = optData.spot;
  const atmIdx = exp.strikes.reduce((best, s, i) => (Math.abs(s.K - S) < Math.abs(exp.strikes[best].K - S) ? i : best), 0);
  $('#opt-chain').innerHTML = `<thead><tr>
      <th class="num">STRIKE</th><th class="num">IV</th>
      <th class="num">CALL</th><th class="num">Δ</th><th class="num">Γ</th><th class="num">VEGA</th><th class="num">Θ/day</th>
      <th class="num">PUT</th><th class="num">Δ</th>
    </tr></thead><tbody>${exp.strikes.map((s, i) => `<tr class="${i === atmIdx ? 'atm' : ''}">
      <td class="num"><b>${fmtPx(s.K)}</b>${i === atmIdx ? ' <span class="hint">ATM</span>' : ''}</td>
      <td class="num">${(s.iv * 100).toFixed(1)}%</td>
      <td class="num">$${fmt(s.call.price, 2)}</td><td class="num">${s.call.delta.toFixed(3)}</td>
      <td class="num">${s.call.gamma.toExponential(2)}</td><td class="num">${fmt(s.call.vega, 2)}</td><td class="num">${fmt(s.call.theta, 2)}</td>
      <td class="num">$${fmt(s.put.price, 2)}</td><td class="num">${s.put.delta.toFixed(3)}</td>
    </tr>`).join('')}</tbody>`;
  $('#opt-greek-label').textContent = `${optGreek.toUpperCase()} · ${optExpiry}D expiry`;
  drawLines($('#opt-greeks'), [
    { name: 'CALL', color: C.blue, values: exp.strikes.map((s) => s.call[optGreek]) },
    { name: 'PUT', color: C.purple, values: exp.strikes.map((s) => s.put[optGreek]) },
  ], { yFmt: (v) => (optGreek === 'gamma' ? v.toExponential(1) : fmt(v, optGreek === 'delta' ? 2 : 2)), zeroLine: true });
}

/* ============================================================ */
/* TAB 3: FACTOR MODEL                                           */
/* ============================================================ */
async function initFactors() {
  $('#fac-sliders').innerHTML = '<div class="loading">loading factor engine (first run builds the 110-asset matrix — ~20s)…</div>';
  try {
    const ov = await apiJson('/api/quant/factors');
    const defaults = { momentum: 100, quality: 40 };
    $('#fac-sliders').innerHTML = ov.factors.filter((f) => f.id !== 'carry').map((f) => `
      <div class="fac-slider">
        <div class="head"><span class="nm">${f.name}</span><span class="vv" id="fv-${f.id}">${defaults[f.id] || 0}%</span></div>
        <div class="head"><span class="ds">${f.desc}</span></div>
        <input type="range" min="-100" max="100" value="${defaults[f.id] || 0}" data-f="${f.id}" />
      </div>`).join('');
    document.querySelectorAll('#fac-sliders input').forEach((sl) =>
      sl.addEventListener('input', () => { $(`#fv-${sl.dataset.f}`).textContent = sl.value + '%'; }));
    $('#fac-run').addEventListener('click', runFactorBacktest);

    const s = ov.singleFactorStats;
    $('#fac-singles').innerHTML = `<table class="trade-table"><thead><tr>
      <th>FACTOR</th><th class="num">ANN RET</th><th class="num">ANN VOL</th><th class="num">SHARPE</th><th class="num">MAX DD</th><th class="num">TOTAL</th>
    </tr></thead><tbody>${Object.entries(s).map(([f, st]) => st ? `<tr>
      <td><b>${f.toUpperCase()}</b></td>
      <td class="num ${signCls(st.annReturnPct)}">${signTxt(st.annReturnPct, 1)}%</td>
      <td class="num">${fmt(st.annVolPct, 1)}%</td>
      <td class="num"><b class="${signCls(st.sharpe)}">${fmt(st.sharpe, 2)}</b></td>
      <td class="num down">${fmt(st.maxDrawdownPct, 1)}%</td>
      <td class="num ${signCls(st.totalReturnPct)}">${signTxt(st.totalReturnPct, 1)}%</td>
    </tr>` : '').join('')}</tbody></table>`;
    runFactorBacktest();
  } catch (e) {
    $('#fac-sliders').innerHTML = `<div class="loading">⚠ ${e.message}</div>`;
  }
}
async function runFactorBacktest() {
  const exposures = {};
  document.querySelectorAll('#fac-sliders input').forEach((sl) => { if (+sl.value !== 0) exposures[sl.dataset.f] = +sl.value / 100; });
  $('#fac-stats').innerHTML = '<div class="loading">backtesting blend…</div>';
  try {
    const bt = await apiJson('/api/quant/factors/backtest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ exposures }),
    });
    $('#fac-stats').innerHTML = cards([
      { k: 'ANN RETURN', v: signTxt(bt.stats.annReturnPct, 1) + '%', cls: signCls(bt.stats.annReturnPct) },
      { k: 'SHARPE', v: fmt(bt.stats.sharpe, 2), cls: signCls(bt.stats.sharpe) },
      { k: 'ANN VOL', v: fmt(bt.stats.annVolPct, 1) + '%' },
      { k: 'MAX DRAWDOWN', v: fmt(bt.stats.maxDrawdownPct, 1) + '%', cls: 'down' },
      { k: 'WINDOW', v: bt.days + 'd', s: `${bt.nAssets} assets · ${bt.rebalances} rebalances` },
    ]);
    drawLines($('#fac-curve'), [{ name: 'BLEND', color: C.blue, values: bt.curve.map((p) => p.value) }], { yFmt: (v) => fmt(v, 3) });
    $('#fac-longs').innerHTML = bt.holdings.long.map((h) => `<div class="row"><span class="sym">${h.sym}</span><b class="up">+${fmt(h.w, 2)}%</b></div>`).join('');
    $('#fac-shorts').innerHTML = bt.holdings.short.map((h) => `<div class="row"><span class="sym">${h.sym}</span><b class="down">${fmt(h.w, 2)}%</b></div>`).join('');
  } catch (e) {
    $('#fac-stats').innerHTML = `<div class="loading">⚠ ${e.message}</div>`;
  }
}

/* ============================================================ */
/* TAB 4: HFT SIMULATOR (fully client-side, 1ms steps)           */
/* ============================================================ */
const hft = { running: false, t: 0, raf: null };
function hftReset() {
  hft.t = 0;
  hft.tick = 0.5;                          // $ tick size
  hft.mid0 = 10000;
  hft.levels = 60;                          // price levels each side
  hft.bid = new Array(hft.levels).fill(0).map(() => 3 + Math.floor(Math.random() * 12));
  hft.ask = new Array(hft.levels).fill(0).map(() => 3 + Math.floor(Math.random() * 12));
  hft.bestBid = hft.mid0 - hft.tick / 2;    // price of bid[0]
  hft.mids = [hft.mid0];
  hft.inv = 0; hft.cash = 0; hft.fills = 0; hft.quoteUpdates = 0;
  hft.pendingQuotes = [];                   // {applyAt, bidPx, askPx}
  hft.activeQuote = null;                   // {bidPx, askPx}
  hft.fillMarks = [];                       // {t, side, px, midAfterIdx}
  hft.advSamples = [];
  hft.tape = [];
  $('#hft-tape').innerHTML = '';
  hftDraw(); hftStats();
}
const hftMid = () => hft.bestBid + hft.tick / 2 + (firstNonEmpty(hft.ask) - firstNonEmpty(hft.bid)) * 0; // mid from touch
function firstNonEmpty(arr) { for (let i = 0; i < arr.length; i++) if (arr[i] > 0) return i; return 0; }
function hftTouch() {
  const bi = firstNonEmpty(hft.bid), ai = firstNonEmpty(hft.ask);
  return { bidPx: hft.bestBid - bi * hft.tick, askPx: hft.bestBid + hft.tick / 2 + ai * hft.tick + hft.tick / 2 };
}
function hftStep() {
  hft.t++;
  const r = Math.random();
  // limit-order arrivals near the touch (geometric depth)
  if (r < 0.5) {
    const side = Math.random() < 0.5 ? hft.bid : hft.ask;
    const depth = Math.min(hft.levels - 1, Math.floor(-Math.log(Math.random()) * 4));
    side[depth] += 1 + Math.floor(Math.random() * 4);
  }
  // cancels
  if (Math.random() < 0.35) {
    const side = Math.random() < 0.5 ? hft.bid : hft.ask;
    const i = Math.floor(Math.random() * 12);
    side[i] = Math.max(0, side[i] - (1 + Math.floor(Math.random() * 3)));
  }
  // market orders — flow has short-term momentum via imbalance
  if (Math.random() < 0.06) {
    const bSum = hft.bid.slice(0, 8).reduce((a, b) => a + b, 0);
    const aSum = hft.ask.slice(0, 8).reduce((a, b) => a + b, 0);
    const buyProb = 0.5 + 0.25 * ((bSum - aSum) / Math.max(1, bSum + aSum));
    const isBuy = Math.random() < buyProb;
    let size = 1 + Math.floor(Math.random() * 8);
    const book = isBuy ? hft.ask : hft.bid;
    const t0 = hftTouch();
    let lvl = 0;
    const tradePx = isBuy ? t0.askPx : t0.bidPx;
    while (size > 0 && lvl < hft.levels) {
      const take = Math.min(size, book[lvl]);
      book[lvl] -= take; size -= take;
      if (book[lvl] === 0 && size > 0) lvl++; else break;
    }
    // drift the ladder anchor if a side is swept
    if (lvl > 1) hft.bestBid += (isBuy ? 1 : -1) * hft.tick * lvl * 0.5;
    hft.tape.unshift({ t: hft.t, side: isBuy ? 'B' : 'S', px: tradePx, size: 1 + Math.floor(Math.random() * 8), us: false });

    // our resting quote fills if the trade reaches it
    const q = hft.activeQuote;
    if (q) {
      if (!isBuy && q.bidPx >= tradePx - hft.tick * lvl) hftFill('BUY', q.bidPx);
      if (isBuy && q.askPx <= tradePx + hft.tick * lvl) hftFill('SELL', q.askPx);
    }
  }
  // strategy: re-quote every 25ms based on the mid it SAW latency ms ago
  const latency = +$('#hft-latency').value;
  if (hft.t % 25 === 0) {
    const delayedIdx = Math.max(0, hft.mids.length - 1 - latency);
    const seenMid = hft.mids[delayedIdx];
    const spreadBps = +$('#hft-spread').value;
    const half = (seenMid * spreadBps) / 10000 / 2;
    const skew = -hft.inv * hft.tick * 0.4;        // inventory mean-reversion
    hft.pendingQuotes.push({ applyAt: hft.t + latency, bidPx: seenMid - half + skew, askPx: seenMid + half + skew });
    hft.quoteUpdates++;
  }
  while (hft.pendingQuotes.length && hft.pendingQuotes[0].applyAt <= hft.t) {
    hft.activeQuote = hft.pendingQuotes.shift();
  }
  const t1 = hftTouch();
  const mid = (t1.bidPx + t1.askPx) / 2;
  hft.mids.push(mid);
  if (hft.mids.length > 4000) hft.mids.shift();
  // adverse-selection sampling 400ms after each fill
  for (const f of hft.fillMarks) {
    if (!f.done && hft.t - f.t >= 400) {
      f.done = true;
      const dir = f.side === 'BUY' ? 1 : -1;
      hft.advSamples.push(dir * ((mid - f.px) / f.px) * 10000);
    }
  }
}
function hftFill(side, px) {
  hft.fills++;
  hft.inv += side === 'BUY' ? 1 : -1;
  hft.cash += side === 'BUY' ? -px : px;
  hft.fillMarks.push({ t: hft.t, side, px, done: false });
  hft.tape.unshift({ t: hft.t, side: side === 'BUY' ? 'B' : 'S', px, size: 1, us: true });
  hft.activeQuote = null; // quote consumed, next update re-arms
}
function hftStats() {
  const mid = hft.mids[hft.mids.length - 1] || hft.mid0;
  const pnl = hft.cash + hft.inv * mid;
  const adv = hft.advSamples.length ? hft.advSamples.reduce((a, b) => a + b, 0) / hft.advSamples.length : 0;
  $('#hft-stats').innerHTML = `
    <div><span>SIM TIME</span><b>${(hft.t / 1000).toFixed(2)}s (${hft.t.toLocaleString()} ticks)</b></div>
    <div><span>MID</span><b>$${fmt(mid, 2)}</b></div>
    <div><span>INVENTORY</span><b class="${hft.inv === 0 ? '' : signCls(hft.inv)}">${signTxt(hft.inv, 0)}</b></div>
    <div><span>MTM PNL</span><b class="${signCls(pnl)}">${signTxt(pnl, 2)}$</b></div>
    <div><span>FILLS</span><b>${hft.fills}</b></div>
    <div><span>QUOTE UPDATES</span><b>${hft.quoteUpdates}</b></div>
    <div><span>ADVERSE SELECTION</span><b class="${signCls(adv)}">${signTxt(adv, 2)} bps avg</b></div>`;
  if (hft.tape.length > 14) hft.tape.length = 14;
  $('#hft-tape').innerHTML = hft.tape.map((x) => `
    <div><span class="${x.us ? 'us' : x.side === 'B' ? 'b' : 's'}">${x.us ? '◆ US' : x.side === 'B' ? '▲ BUY' : '▼ SELL'}</span>
    <span>$${fmt(x.px, 2)}</span><span class="hint">×${x.size}</span></div>`).join('');
}
function hftDraw() {
  const cv = $('#hft-canvas');
  const { ctx, W, H } = ctx2d(cv);
  const t = hftTouch();
  const mid = (t.bidPx + t.askPx) / 2;
  // left 45%: ladder (top 18 levels/side); right: mid sparkline
  const ladderW = W * 0.42, rowH = Math.min(9, H / 40);
  const maxQ = Math.max(...hft.bid.slice(0, 18), ...hft.ask.slice(0, 18), 1);
  ctx.fillStyle = C.dim; ctx.fillText('ORDER BOOK', 8, 12);
  for (let i = 0; i < 18; i++) {
    // asks above mid, bids below
    const ay = H / 2 - 12 - i * rowH, by = H / 2 + 4 + i * rowH;
    ctx.fillStyle = 'rgba(234,57,67,.55)';
    ctx.fillRect(60, ay, (hft.ask[i] / maxQ) * (ladderW - 70), rowH - 2);
    ctx.fillStyle = 'rgba(22,199,132,.55)';
    ctx.fillRect(60, by, (hft.bid[i] / maxQ) * (ladderW - 70), rowH - 2);
    if (i === 0) {
      ctx.fillStyle = C.red; ctx.fillText(fmt(t.askPx, 1), 8, ay + rowH - 3);
      ctx.fillStyle = C.green; ctx.fillText(fmt(t.bidPx, 1), 8, by + rowH - 3);
    }
  }
  // our quotes on the ladder
  const q = hft.activeQuote;
  if (q) {
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.5;
    const yFor = (px) => H / 2 + ((mid - px) / hft.tick) * rowH * 0.9;
    for (const px of [q.bidPx, q.askPx]) {
      const y = Math.max(8, Math.min(H - 8, yFor(px)));
      ctx.beginPath(); ctx.moveTo(56, y); ctx.lineTo(ladderW, y); ctx.stroke();
    }
    ctx.fillStyle = C.amber; ctx.fillText('◄ our quotes', ladderW - 74, Math.max(16, Math.min(H - 12, H / 2 - 24)));
  }
  // mid sparkline (right)
  const xs = ladderW + 14, xw = W - xs - 8;
  const win = hft.mids.slice(-1200);
  const lo = Math.min(...win), hi = Math.max(...win), span = hi - lo || 1;
  ctx.fillStyle = C.dim; ctx.fillText(`MID (last ${(win.length / 1000).toFixed(1)}s)`, xs, 12);
  ctx.strokeStyle = C.blue; ctx.lineWidth = 2; ctx.beginPath();
  win.forEach((m, i) => {
    const x = xs + (i / (win.length - 1)) * xw;
    const y = 20 + (1 - (m - lo) / span) * (H - 40);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
  // our fills on the sparkline
  for (const f of hft.fillMarks.slice(-40)) {
    const idx = win.length - (hft.t - f.t) - 1;
    if (idx < 0) continue;
    const x = xs + (idx / (win.length - 1)) * xw;
    const y = 20 + (1 - (f.px - lo) / span) * (H - 40);
    ctx.fillStyle = f.side === 'BUY' ? C.green : C.red;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#06090f'; ctx.lineWidth = 1; ctx.stroke(); // 2px surface ring
  }
}
function hftLoop() {
  if (!hft.running) return;
  const speed = +$('#hft-speed').value;
  const steps = 16 * speed; // 16ms frame × speed = simulated ms per frame
  for (let i = 0; i < steps; i++) hftStep();
  hftDraw();
  if (hft.t % 160 < steps) hftStats();
  hft.raf = requestAnimationFrame(hftLoop);
}
function initHft() {
  hftReset();
  $('#hft-toggle').addEventListener('click', () => {
    hft.running = !hft.running;
    $('#hft-toggle').textContent = hft.running ? '⏸ PAUSE' : '▶ RUN';
    if (hft.running) hftLoop(); else cancelAnimationFrame(hft.raf);
  });
  $('#hft-reset').addEventListener('click', () => { const was = hft.running; hft.running = false; cancelAnimationFrame(hft.raf); hftReset(); if (was) { hft.running = true; hftLoop(); } });
  $('#hft-latency').addEventListener('input', () => { $('#hft-latency-v').textContent = $('#hft-latency').value + 'ms'; });
  $('#hft-spread').addEventListener('input', () => { $('#hft-spread-v').textContent = $('#hft-spread').value + 'bps'; });
}

/* ============================================================ */
/* TAB 5: ML ALPHA                                               */
/* ============================================================ */
function initMl() {
  const uni = window.__universe || [];
  $('#ml-symbol').innerHTML = uni.slice(0, 33).map((u) => `<option value="${u.symbol}">${u.base}${u.yahoo ? ' ◆' : ''}</option>`).join('') || '<option value="BTCUSDT">BTC</option>';
  if (uni.some((u) => u.symbol === 'BTCUSDT')) $('#ml-symbol').value = 'BTCUSDT';
  $('#ml-run').addEventListener('click', runMl);
  runMl();
}
async function runMl() {
  $('#ml-timing').innerHTML = '<span class="q-badge amber">training boosted trees + ridge (walk-forward)…</span>';
  $('#ml-cards').innerHTML = '';
  try {
    const d = await apiJson(`/api/quant/ml?binance=${$('#ml-symbol').value}`, { timeout: 90000 });
    $('#ml-timing').innerHTML = `<span class="q-badge green">trained + evaluated in ${d.computeMs} ms</span>
      <span class="q-badge">${d.trainBars} train / ${d.testBars} test bars</span>
      <span class="q-badge">${d.boosted.nStumps} boosted stumps · ${d.features} features</span>`;
    const b = d.boosted, r = d.ridge;
    $('#ml-cards').innerHTML = cards([
      { k: 'OOS SHARPE (BOOSTED)', v: fmt(b.oosSharpe, 2), cls: signCls(b.oosSharpe), s: 'net of 2bps costs' },
      { k: 'INFORMATION COEFF', v: fmt(b.ic, 3), cls: signCls(b.ic), s: 'corr(pred, realized)' },
      { k: 'HIT RATE', v: fmt(b.hitRatePct, 1) + '%' },
      { k: 'STRATEGY RETURN', v: signTxt(b.totalReturnPct, 1) + '%', cls: signCls(b.totalReturnPct), s: `buy&hold ${signTxt(b.buyHoldPct, 1)}%` },
      { k: 'RIDGE BASELINE', v: `SR ${fmt(r.oosSharpe, 2)}`, s: `IC ${fmt(r.ic, 3)} · hit ${fmt(r.hitRatePct, 1)}%` },
    ]);
    drawLines($('#ml-curve'), [
      { name: 'ML STRATEGY', color: C.blue, values: b.curve.map((p) => p.value) },
      { name: 'BUY & HOLD', color: C.dim, values: b.bhCurve.map((p) => p.value) },
    ], { yFmt: (v) => fmt(v, 3) });
    const maxImp = Math.max(...d.importance.map((i) => i.pct), 1);
    $('#ml-importance').innerHTML = d.importance.map((i) => barRow(i.name, i.pct, maxImp)).join('');
    $('#ml-note').textContent = d.note;
  } catch (e) {
    $('#ml-timing').innerHTML = `<span class="q-badge" style="color:var(--red)">⚠ ${e.message}</span>`;
  }
}

/* ============================================================ */
/* TAB 6: ARBITRAGE                                              */
/* ============================================================ */
let arbTimer = null;
function initArb() {
  $('#arb-run').addEventListener('click', runArb);
  arbTimer = setInterval(() => { if (activeTab === 'arb' && $('#arb-auto').checked) runArb(); }, 10000);
  runArb();
}
async function runArb() {
  $('#arb-status').innerHTML = '<span class="q-badge amber">polling 6 venues…</span>';
  try {
    const p = new URLSearchParams({
      feeBps: $('#arb-fee').value, slippageBps: $('#arb-slip').value,
      latencyMs: $('#arb-lat').value, sizeUsd: $('#arb-size').value,
    });
    const d = await apiJson(`/api/quant/arb?${p}`);
    const up = d.exchanges.filter((e) => e.up);
    $('#arb-status').innerHTML = `<span class="q-badge green">${up.length}/${d.exchanges.length} venues live</span>
      <span class="q-badge">${new Date(d.at).toLocaleTimeString('en-GB')}</span>`;
    $('#arb-opps').innerHTML = `<thead><tr>
      <th>SYM</th><th>BUY @ (ask)</th><th>SELL @ (bid)</th>
      <th class="num">GROSS</th><th class="num">FEES+SLIP</th><th class="num">LATENCY σ√t</th><th class="num">NET</th><th class="num">NET $ (${fmt(d.params.sizeUsd, 0)})</th><th></th>
    </tr></thead><tbody>${d.opportunities.map((o) => `<tr>
      <td><b>${o.sym}</b></td>
      <td>${o.buyEx} <span class="hint">$${fmtPx(o.buyPrice)}</span></td>
      <td>${o.sellEx} <span class="hint">$${fmtPx(o.sellPrice)}</span></td>
      <td class="num">${fmt(o.grossBps, 1)} bps <span class="hint">(${o.grossPct}%)</span></td>
      <td class="num">−${fmt(o.costBps, 1)}</td><td class="num">−${fmt(o.latencyBps, 1)}</td>
      <td class="num"><b class="${signCls(o.netBps)}">${signTxt(o.netBps, 1)} bps</b></td>
      <td class="num ${signCls(o.netUsd)}">${signTxt(o.netUsd)}$</td>
      <td>${o.viable ? '<span class="badge BUY">VIABLE</span>' : '<span class="badge NEUTRAL">NO EDGE</span>'}</td>
    </tr>`).join('')}</tbody>`;
    const exs = up.map((e) => e.name);
    $('#arb-grid').innerHTML = `<thead><tr><th>SYM</th>${exs.map((e) => `<th class="num">${e.toUpperCase()}</th>`).join('')}</tr></thead>
      <tbody>${d.grid.map((g) => `<tr><td><b>${g.sym}</b></td>${exs.map((e) => {
        const q = g.quotes[e];
        return `<td class="num">${q ? `<span class="up">${fmtPx(q.bid)}</span> / <span class="down">${fmtPx(q.ask)}</span>` : '<span class="hint">–</span>'}</td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
    $('#arb-note').textContent = d.note;
  } catch (e) {
    $('#arb-status').innerHTML = `<span class="q-badge" style="color:var(--red)">⚠ ${e.message}</span>`;
  }
}

/* ============================================================ */
/* TAB 7: OPTIMIZER                                              */
/* ============================================================ */
function initOptimizer() {
  $('#po-run').addEventListener('click', runOptimizer);
  runOptimizer();
}
async function runOptimizer() {
  $('#po-timing').innerHTML = '<span class="q-badge amber">optimizing (first run builds the matrix — ~20s)…</span>';
  try {
    const p = new URLSearchParams({ maxWeightPct: $('#po-maxw').value, sectorCapPct: $('#po-sector').value, turnoverPenalty: $('#po-turn').value });
    const d = await apiJson(`/api/quant/optimize?${p}`, { timeout: 120000 });
    $('#po-timing').innerHTML = `<span class="q-badge green">${d.nAssets} assets solved in ${d.computeMs} ms</span>`;
    $('#po-stats').innerHTML = cards([
      { k: 'EXP SHARPE', v: fmt(d.stats.sharpe, 2), cls: 'blue' },
      { k: 'EXP RETURN', v: signTxt(d.stats.expReturnPct, 1) + '%', cls: signCls(d.stats.expReturnPct) },
      { k: 'EXP VOL', v: fmt(d.stats.expVolPct, 1) + '%' },
      { k: 'HOLDINGS', v: d.stats.nHoldings, s: `effective N ${d.stats.effectiveN}` },
      { k: 'TURNOVER vs EQ-WEIGHT', v: fmt(d.stats.turnoverVsEqualPct, 0) + '%' },
    ]);
    const maxW = Math.max(...d.holdings.map((h) => h.weightPct), 1);
    $('#po-holdings').innerHTML = d.holdings.slice(0, 22).map((h) =>
      barRow(`${h.sym} <span class="hint">${h.sector}</span>`, h.weightPct, maxW, '', fmt(h.weightPct, 2) + '%')).join('');
    const maxS = Math.max(...d.sectorBreakdown.map((s) => s.pct), 1);
    $('#po-sectors').innerHTML = d.sectorBreakdown.map((s) => barRow(s.sector, s.pct, maxS, 'amber')).join('');
    // frontier scatter + our portfolio
    const cv = $('#po-frontier');
    const { ctx, W, H } = ctx2d(cv);
    const pts = [...d.frontier];
    const vlo = Math.min(...pts.map((p2) => p2.volPct)) * 0.9, vhi = Math.max(...pts.map((p2) => p2.volPct), d.stats.expVolPct) * 1.08;
    const rlo = Math.min(...pts.map((p2) => p2.retPct), 0), rhi = Math.max(...pts.map((p2) => p2.retPct), d.stats.expReturnPct) * 1.1;
    const X = (v) => 40 + ((v - vlo) / (vhi - vlo || 1)) * (W - 52);
    const Y = (r) => 12 + (1 - (r - rlo) / (rhi - rlo || 1)) * (H - 34);
    ctx.strokeStyle = C.grid;
    ctx.strokeRect(40, 8, W - 52, H - 30);
    ctx.fillStyle = C.dim; ctx.fillText('vol% →', W - 50, H - 6); ctx.fillText('ret%', 4, 16);
    ctx.strokeStyle = C.blue; ctx.lineWidth = 2; ctx.beginPath();
    pts.sort((a, b) => a.volPct - b.volPct).forEach((p2, i) => { const x = X(p2.volPct), y = Y(p2.retPct); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.stroke();
    pts.forEach((p2) => { ctx.fillStyle = C.blue; ctx.beginPath(); ctx.arc(X(p2.volPct), Y(p2.retPct), 3.5, 0, Math.PI * 2); ctx.fill(); });
    ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(X(d.stats.expVolPct), Y(d.stats.expReturnPct), 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillText('◄ max-Sharpe', X(d.stats.expVolPct) + 8, Y(d.stats.expReturnPct) + 3);
  } catch (e) {
    $('#po-timing').innerHTML = `<span class="q-badge" style="color:var(--red)">⚠ ${e.message}</span>`;
  }
}

/* ============================================================ */
/* TAB 8: RISK ENGINE                                            */
/* ============================================================ */
function initRisk() {
  $('#risk-run').addEventListener('click', runRisk);
  runRisk();
}
async function runRisk() {
  $('#risk-cards').innerHTML = '<div class="loading">computing VaR / stress…</div>';
  try {
    const d = await apiJson(`/api/quant/risk?basis=${$('#risk-basis').value}&notional=${$('#risk-notional').value}`, { timeout: 120000 });
    $('#risk-cards').innerHTML = cards([
      { k: '99% VaR (1d, hist)', v: '−$' + fmt(d.var.var99Usd, 0), cls: 'down', s: d.var.hist99Pct + '% of notional' },
      { k: '99% EXPECTED SHORTFALL', v: '−$' + fmt(d.var.es99Usd, 0), cls: 'down', s: d.var.es99Pct + '%' },
      { k: '95% VaR', v: d.var.hist95Pct + '%', s: 'ES95 ' + d.var.es95Pct + '%' },
      { k: 'CORNISH-FISHER 99%', v: d.var.cf99Pct + '%', s: `skew ${d.var.skew} · xkurt ${d.var.excessKurtosis}` },
      { k: '10-DAY 99% VaR (√t)', v: d.var.var99_10dPct + '%' },
      { k: 'ANN VOL', v: d.annVolPct + '%', s: `${d.nAssets} assets · ${d.window}d` },
    ]);
    drawHist($('#risk-hist'), d.histogram.map((h) => ({ lo: h.lo * 100, count: h.count })), {
      vlines: [
        { x: -d.var.hist95Pct, color: C.amber, label: 'VaR95' },
        { x: -d.var.hist99Pct, color: C.red, label: 'VaR99' },
      ],
      xFmt: (v) => fmt(v, 1) + '%',
    });
    $('#risk-comp').innerHTML = d.componentVar.map((c2) => `<div class="row">
      <span class="sym">${c2.sym} <span class="hint">${c2.weightPct}%</span></span><b class="down">${fmt(c2.cvarPct, 2)}%</b></div>`).join('');
    $('#risk-stress').innerHTML = `<thead><tr><th>SCENARIO</th><th class="num">BTC SHOCK</th><th class="num">PORT LOSS %</th><th class="num">PORT LOSS $</th></tr></thead>
      <tbody>${d.stress.map((s) => `<tr>
        <td>${s.name}</td><td class="num down">${fmt(s.btcShock * 100, 0)}%</td>
        <td class="num"><b class="down">${fmt(s.portLossPct, 1)}%</b></td>
        <td class="num down">${fmt(s.portLossUsd, 0)}$</td></tr>`).join('')}</tbody>`;
    $('#risk-note').textContent = `Basis: ${d.basis}. ${d.note}`;
  } catch (e) {
    $('#risk-cards').innerHTML = `<div class="loading">⚠ ${e.message}</div>`;
  }
}

/* ============================================================ */
/* TAB 9: STAT-ARB                                               */
/* ============================================================ */
function initStatarb() {
  $('#sa-run').addEventListener('click', runStatarb);
  runStatarb();
}
async function runStatarb() {
  $('#sa-timing').innerHTML = '<span class="q-badge amber">backtesting ~1,770 pairs…</span>';
  try {
    const d = await apiJson('/api/quant/statarb', { timeout: 180000 });
    $('#sa-timing').innerHTML = `<span class="q-badge green">${d.nStrategies.toLocaleString()} strategies in ${d.computeMs} ms</span>`;
    $('#sa-cards').innerHTML = cards([
      { k: 'STRATEGIES TESTED', v: d.nStrategies.toLocaleString(), s: `${d.nAssets} assets · ${d.window}d window` },
      { k: 'PASS COINTEGRATION', v: d.cointegratedCount, s: 'ADF t < −3' },
      { k: 'NOISE CEILING', v: 'SR ' + fmt(d.noiseCeiling, 1), cls: 'amber', s: 'E[max Sharpe | pure noise]' },
      { k: 'SHARPE DISTRIBUTION', v: `${fmt(d.meanSharpe, 2)} ± ${fmt(d.stdSharpe, 2)}`, s: 'mean ± std across pairs' },
    ]);
    drawHist($('#sa-hist'), d.histogram.map((b) => ({ lo: b.lo, count: b.count })), {
      vlines: [{ x: d.noiseCeiling, color: C.red, label: `noise ceiling ${fmt(d.noiseCeiling, 1)}` }],
      xFmt: (v) => 'SR ' + fmt(v, 1),
    });
    const table = (rows) => `<thead><tr><th>PAIR</th><th class="num">β</th><th class="num">ADF t</th><th class="num">½-LIFE</th><th class="num">SHARPE</th><th class="num">TRADES</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="clickable" data-a="${p.symA}" data-b="${p.symB}" data-l="${p.a}/${p.b}">
        <td><b>${p.a}/${p.b}</b></td><td class="num">${p.beta}</td>
        <td class="num ${p.adfT < -3 ? 'up' : ''}">${p.adfT}</td>
        <td class="num">${p.halfLife ?? '–'}d</td>
        <td class="num"><b class="${signCls(p.sharpe)}">${fmt(p.sharpe, 2)}</b></td>
        <td class="num">${p.trades}</td></tr>`).join('')}</tbody>`;
    $('#sa-top-all').innerHTML = table(d.topAll);
    $('#sa-top-coint').innerHTML = table(d.topCointegrated);
    document.querySelectorAll('#sa-top-all tr.clickable, #sa-top-coint tr.clickable').forEach((tr) =>
      tr.addEventListener('click', () => loadPair(tr.dataset.a, tr.dataset.b, tr.dataset.l)));
    $('#sa-note').textContent = d.note;
    if (d.topCointegrated[0]) loadPair(d.topCointegrated[0].symA, d.topCointegrated[0].symB, `${d.topCointegrated[0].a}/${d.topCointegrated[0].b}`);
  } catch (e) {
    $('#sa-timing').innerHTML = `<span class="q-badge" style="color:var(--red)">⚠ ${e.message}</span>`;
  }
}
async function loadPair(a, b, label) {
  $('#sa-pair-label').textContent = label + ' (long spread < −2σ, exit 0)';
  try {
    const d = await apiJson(`/api/quant/statarb/pair?a=${a}&b=${b}`);
    drawLines($('#sa-zchart'), [{ name: 'z', color: C.purple, values: d.series.map((p) => p.z) }], {
      yFmt: (v) => fmt(v, 1) + 'σ', zeroLine: true,
      guides: [{ y: 2, color: C.red, label: '+2σ short' }, { y: -2, color: C.green, label: '−2σ long' }, { y: 0, color: C.dim }],
    });
  } catch { /* ignore */ }
}

/* ---------------- boot ---------------- */
setStatus().then(() => { inited.trade = true; initTrade(); });
