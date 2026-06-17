/* CryptoTracker Terminal — frontend */
const $ = (sel) => document.querySelector(sel);

const state = {
  coins: [],
  category: 'crypto', // crypto | forex | indices | klci | ipo
  selected: { symbol: 'BTC', source: 'crypto', binance: 'BTCUSDT', id: 'bitcoin', name: 'Bitcoin' },
  interval: '4h',
  chartType: 'candles', // candles | volume | bookmap
  pmTab: 'crypto',
  pmData: null,
  selectedSignal: null,
  selectedPmMarket: null, // holds { id, question, price } for trading
  showZones: true,        // SMC / S-R zone boxes on the chart
  showOsc: true,          // RSI + Stochastic oscillator panels
};

// Returns the backend host URL the dashboard should call.
// Priority: explicit setting (CONNECT modal) > relative paths.
function getApiHost() {
  const saved = localStorage.getItem('apiHost');
  if (saved != null && saved !== '') return upgradeHttp(saved);
  return '';
}

// When the dashboard is served over HTTPS (Cloudflare Pages), the browser blocks
// any plain http:// backend call as "mixed content". A Cloudflare-tunnel hostname
// is reachable over https anyway, so transparently upgrade a remote http:// backend
// URL to https://. localhost is left as-is (it stays http and is exempt).
function upgradeHttp(url) {
  if (location.protocol === 'https:' &&
      /^http:\/\//i.test(url) &&
      !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(url)) {
    return url.replace(/^http:\/\//i, 'https://');
  }
  return url;
}

/* ---------------- backend fetch helper ---------------- */
// Fetch JSON from the backend with a timeout, failing *cleanly* when the backend
// is unreachable. A down tunnel returns Cloudflare's HTML 502 page, which would
// otherwise throw "Unexpected token '<'" as JSON on every poll.
let backendDown = false, lastBackendWarn = 0;
async function apiJson(path, opts = {}) {
  const { timeout = 12000, ...init } = opts;
  let res;
  try {
    res = await fetch(getApiHost() + path, { signal: AbortSignal.timeout(timeout), ...init });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'backend timed out' : 'backend unreachable');
  }
  if (!res.ok) throw new Error(`backend HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error('backend returned a non-JSON response (unreachable?)'); }
}
// Surface one banner + one console line when the backend goes down, instead of
// spamming an error on every 5-second poll. Cleared on the next success.
function markBackendDown(where, err) {
  backendDown = true;
  const b = $('#backend-banner');
  if (b) { b.textContent = `⚠ Backend offline (${getApiHost() || 'same origin'}) — ${err.message}. Check CONNECT → Terminal Backend API.`; b.classList.remove('hidden'); }
  const now = Date.now();
  if (now - lastBackendWarn > 30000) { lastBackendWarn = now; console.warn(`Backend offline — ${where}: ${err.message}`); } // throttle, don't spam each poll
}
function markBackendUp() {
  const b = $('#backend-banner');
  if (b) b.classList.add('hidden');
  if (backendDown) { backendDown = false; lastBackendWarn = 0; console.info('Backend back online'); }
}

/* ---------------- formatting helpers ---------------- */
function fmtPrice(p) {
  if (p == null) return '–';
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(8).replace(/0+$/, '0');
}
function fmtBig(n) {
  if (n == null) return '–';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  return n.toLocaleString();
}
function pct(v) {
  if (v == null) return '<span class="dim">–</span>';
  const cls = v >= 0 ? 'up' : 'down';
  return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span>`;
}
// Price label for a scanner row — crypto gets "$", tradfi shows the raw quote.
function rowPrice(c) {
  if (c.price == null) return '–';
  const v = c.price;
  const num =
    v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : v >= 100 ? v.toFixed(2)
    : v >= 1 ? v.toFixed(4)
    : v.toFixed(5);
  return c.source === 'yahoo' ? num : '$' + fmtPrice(v);
}
// Quote-pair suffix shown beside the chart title. Crypto is the USDⓈ-M
// perpetual we actually trade, so flag it as PERP.
function quoteSuffix(sel) {
  if (sel.source === 'yahoo') return '';
  return ' / USDT PERP';
}

/* ---------------- clock ---------------- */
setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString('en-GB') + ' LOCAL';
}, 1000);

/* ---------------- global stats ---------------- */
async function loadGlobal() {
  try {
    const g = await apiJson('/api/global');
    markBackendUp();
    const chg = g.marketCapChange24h;
    $('#global-stats').innerHTML = `
      <span>MCAP <b>$${fmtBig(g.totalMarketCap)}</b> <span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '▲' : '▼'}${Math.abs(chg).toFixed(2)}%</span></span>
      <span>VOL24H <b>$${fmtBig(g.totalVolume)}</b></span>
      <span>BTC.D <b>${g.btcDominance?.toFixed(1)}%</b></span>
      <span>ETH.D <b>${g.ethDominance?.toFixed(1)}%</b></span>`;
  } catch { /* keep old values */ }
}

/* ---------------- scanner ---------------- */
async function loadScan(autoSelectFirst = false) {
  if (state.category === 'polymarket') { await loadPolymarket(autoSelectFirst); return; }
  try {
    const coins = await apiJson(`/api/scan?category=${state.category}`);
    markBackendUp();
    if (Array.isArray(coins)) {
      state.coins = coins;
      renderScanner();
      if (autoSelectFirst && coins.length) selectRow(coins[0]);
      else if (state.chartType === 'bookmap') renderBookmap();
    }
  } catch { /* keep old values */ }
}

// Build state.selected from a scanner row, branching on data source.
function selectRow(c) {
  if (c.source === 'yahoo') {
    state.selected = { symbol: c.symbol, source: 'yahoo', yahoo: c.yahoo, name: c.name };
  } else {
    state.selected = { symbol: c.symbol, source: 'crypto', binance: c.binanceSymbol, id: c.id, name: c.name };
    if ($('#order-crypto-symbol')) $('#order-crypto-symbol').textContent = c.symbol;
  }
  renderScanner();
  loadSignal();
}

function renderScanner() {
  if (state.category === 'polymarket') return renderPolymarketScanner();
  // crypto trades as USDⓈ-M perps — flag the price column so it's clear the
  // scanner is showing futures, not spot. TradFi keeps the plain PRICE header.
  const priceHdr = state.category === 'crypto' ? 'PERP $' : 'PRICE';
  if ($('.scanner-head')) $('.scanner-head').innerHTML = `<span>ASSET</span><span>${priceHdr}</span><span>24H</span><span>SIG</span>`;
  const q = $('#search').value.trim().toLowerCase();
  const list = state.coins.filter(
    (c) => !q || c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)
  );
  $('#scan-count').textContent = `(${list.length})`;
  $('#coin-list').innerHTML = list
    .map(
      (c) => `
    <div class="coin-row ${c.symbol === state.selected.symbol ? 'selected' : ''}" data-sym="${c.symbol}">
      <div><div class="sym">${c.symbol}</div><div class="name">${c.name}</div></div>
      <div class="px">${rowPrice(c)}</div>
      <div class="chg">${pct(c.change24h)}</div>
      <div class="badge ${c.quickSignal}">${c.quickSignal === 'NEUTRAL' ? 'WAIT' : c.quickSignal}</div>
    </div>`
    )
    .join('');
  document.querySelectorAll('.coin-row').forEach((row) => {
    row.addEventListener('click', () => {
      const c = state.coins.find((x) => x.symbol === row.dataset.sym);
      if (c) selectRow(c);
    });
  });
}

$('#search').addEventListener('input', renderScanner);

/* ---------------- scanner category tabs ---------------- */
document.querySelectorAll('#scanner-cats button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.category === btn.dataset.cat) return;
    document.querySelectorAll('#scanner-cats button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.category = btn.dataset.cat;
    $('#search').value = '';
    $('#coin-list').innerHTML = '<div class="loading">loading ' + state.category + '…</div>';
    loadScan(true); // auto-select the first instrument in the new category
  });
});

/* ---------------- chart ---------------- */
let chart, candleSeries, emaSeries = {}, priceLines = [];
// oscillator sub-charts (RSI, Stochastic) — separate synced chart instances
let oscRsi, oscRsiSeries, oscStoch, oscStochK, oscStochD, oscReady = false;

function initChart() {
  chart = LightweightCharts.createChart($('#chart'), {
    layout: { background: { color: 'transparent' }, textColor: '#5c6c8a', fontFamily: 'Consolas, monospace' },
    grid: { vertLines: { color: '#131b2c' }, horzLines: { color: '#131b2c' } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e293f' },
    timeScale: { borderColor: '#1e293f', timeVisible: true },
    autoSize: true,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#16c784', downColor: '#ea3943',
    wickUpColor: '#16c784', wickDownColor: '#ea3943',
    borderVisible: false,
  });
  emaSeries.ema20 = chart.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'EMA20' });
  emaSeries.ema50 = chart.addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'EMA50' });
  emaSeries.ema200 = chart.addLineSeries({ color: '#a855f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: 'EMA200' });

  // redraw the zone boxes whenever the chart is panned/zoomed, and keep the
  // oscillator panels' time axis locked to the main chart
  chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (range && oscReady) {
      oscRsi.timeScale().setVisibleLogicalRange(range);
      oscStoch.timeScale().setVisibleLogicalRange(range);
    }
    drawZones();
  });
  initOsc();
}

/* ----- oscillator panels (RSI, Stochastic) ----- */
function initOsc() {
  const elR = $('#osc-rsi'), elS = $('#osc-stoch');
  if (!elR || !elS || typeof LightweightCharts === 'undefined') return;
  const base = () => ({
    layout: { background: { color: 'transparent' }, textColor: '#5c6c8a', fontFamily: 'Consolas, monospace' },
    grid: { vertLines: { color: '#0e1726' }, horzLines: { color: '#0e1726' } },
    rightPriceScale: { borderColor: '#1e293f', minimumWidth: 60 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: false, handleScale: false, // the main chart drives the time axis
    autoSize: true,
  });
  const pin0to100 = { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) };
  const refLine = (series, price, color) =>
    series.createPriceLine({ price, color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: String(price) });

  oscRsi = LightweightCharts.createChart(elR, { ...base(), timeScale: { visible: false, borderColor: '#1e293f' } });
  oscRsiSeries = oscRsi.addLineSeries({ color: '#a855f7', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, ...pin0to100 });
  refLine(oscRsiSeries, 70, '#ea3943'); refLine(oscRsiSeries, 50, '#33415c'); refLine(oscRsiSeries, 30, '#16c784');

  oscStoch = LightweightCharts.createChart(elS, { ...base(), timeScale: { visible: true, timeVisible: true, borderColor: '#1e293f' } });
  oscStochK = oscStoch.addLineSeries({ color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: '%K', ...pin0to100 });
  oscStochD = oscStoch.addLineSeries({ color: '#f0b90b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: '%D' });
  refLine(oscStochK, 80, '#ea3943'); refLine(oscStochK, 20, '#16c784');
  oscReady = true;
}

// push the latest oscillator series and align the time axis to the main chart
function setOscData(osc) {
  if (!oscReady || !osc) return;
  oscRsiSeries.setData(osc.rsi || []);
  oscStochK.setData(osc.stochK || []);
  oscStochD.setData(osc.stochD || []);
  const range = chart.timeScale().getVisibleLogicalRange();
  if (range) {
    oscRsi.timeScale().setVisibleLogicalRange(range);
    oscStoch.timeScale().setVisibleLogicalRange(range);
  }
}

/* ----- SMC / S-R zone boxes drawn on a canvas overlay ----- */
const ZONE_COLORS = {
  support:   { fill: 'rgba(22,199,132,0.10)',  line: 'rgba(22,199,132,0.60)' },
  resistance:{ fill: 'rgba(234,57,67,0.10)',   line: 'rgba(234,57,67,0.60)' },
  ob:        { fill: 'rgba(240,185,11,0.10)',  line: 'rgba(240,185,11,0.70)' },
  fvg:       { fill: 'rgba(59,130,246,0.10)',  line: 'rgba(59,130,246,0.65)' },
  ifvg:      { fill: 'rgba(168,85,247,0.12)',  line: 'rgba(168,85,247,0.70)' },
};
function clearZones() {
  const cv = $('#zone-overlay');
  if (cv && cv.getContext) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}
function drawZones() {
  const cv = $('#zone-overlay'), wrap = $('#chart-wrap');
  if (!cv || !wrap) return;
  const rect = wrap.getBoundingClientRect();
  cv.width = rect.width; cv.height = rect.height;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const sig = state.selectedSignal;
  const inCandleView = !(state.chartType === 'volume' || state.chartType === 'bookmap') && state.category !== 'polymarket';
  if (!state.showZones || !inCandleView || !sig) return;

  const axisW = chart.priceScale('right').width() || 58; // real right-axis width
  const xR = rect.width - axisW;
  const ts = chart.timeScale();
  ctx.font = '9px Consolas';

  const box = (top, bottom, time, type, label, dir) => {
    let yT = candleSeries.priceToCoordinate(top);
    let yB = candleSeries.priceToCoordinate(bottom);
    if (yT == null || yB == null) return;
    if (yT > yB) { const t = yT; yT = yB; yB = t; }
    let xL = ts.timeToCoordinate(time);
    if (xL == null) xL = 0;          // started before the visible range → clamp left
    xL = Math.max(0, xL);
    if (xR <= xL) return;
    const h = Math.max(1.5, yB - yT);
    const c = ZONE_COLORS[type];
    ctx.fillStyle = c.fill; ctx.fillRect(xL, yT, xR - xL, h);
    ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.strokeRect(xL + 0.5, yT + 0.5, xR - xL - 1, h - 1);
    ctx.fillStyle = c.line;
    const tag = dir ? `${label} ${dir === 'bull' ? '▲' : '▼'}` : label;
    ctx.fillText(tag, Math.min(xR - 34, xL + 3), yT + (h >= 12 ? 10 : -2));
  };

  const lv = sig.levels || { support: [], resistance: [] };
  lv.support.forEach((l) => box(l.hi ?? l.price, l.lo ?? l.price, ts ? lastTime() : null, 'support', 'S'));
  lv.resistance.forEach((l) => box(l.hi ?? l.price, l.lo ?? l.price, lastTime(), 'resistance', 'R'));
  const z = sig.zones || { ob: [], fvg: [], ifvg: [] };
  z.fvg.forEach((g) => box(g.top, g.bottom, g.time, 'fvg', 'FVG', g.kind));
  z.ifvg.forEach((g) => box(g.top, g.bottom, g.time, 'ifvg', 'IFVG', g.kind));
  z.ob.forEach((o) => box(o.top, o.bottom, o.time, 'ob', 'OB', o.kind));
}
// S/R levels have no explicit start time — anchor their boxes near the left so
// they span the whole visible window.
function lastTime() {
  const r = chart.timeScale().getVisibleRange();
  return r ? r.from : (state.candles && state.candles[0] ? state.candles[0].time : null);
}

function setPriceLines(sig, lastTime) {
  priceLines.forEach((l) => candleSeries.removePriceLine(l));
  priceLines = [];
  const mk = (price, color, title, style, width = 1) =>
    priceLines.push(
      candleSeries.createPriceLine({
        price, color, lineWidth: width,
        lineStyle: style ?? LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: true, title,
      })
    );
  mk(sig.entry, '#3b82f6', `◄ ENTRY ${sig.lean}`, LightweightCharts.LineStyle.Solid, 2);
  mk(sig.stopLoss, '#ea3943', 'SL');
  sig.takeProfits.forEach((tp) => mk(tp.price, '#16c784', tp.label));
  // S/R are now drawn as shaded zone boxes (see drawZones), not dotted lines.
  if (lastTime) {
    candleSeries.setMarkers([
      {
        time: lastTime,
        position: sig.lean === 'LONG' ? 'belowBar' : 'aboveBar',
        shape: sig.lean === 'LONG' ? 'arrowUp' : 'arrowDown',
        color: '#3b82f6',
        text: `ENTRY $${fmtPrice(sig.entry)}`,
      },
    ]);
  }
}

/* ---------------- signal ---------------- */
let signalReq = 0;
async function loadSignal() {
  const sel = state.selected;
  if (sel.source === 'polymarket') return; // polymarket has its own detail view
  const reqId = ++signalReq;
  const { symbol, name } = sel;
  $('#coin-title').textContent = `${symbol}${quoteSuffix(sel)}`;
  $('#analysis-sym').textContent = symbol;
  applyView(); // ensure instrument view (chart/heatmap), not polymarket detail
  $('#signal-card').innerHTML = '<div class="loading">analysing…</div>';
  $('#analysis').innerHTML = '<div class="loading">computing indicators…</div>';
  try {
    const path = sel.source === 'yahoo'
      ? `/api/signal?source=yahoo&symbol=${encodeURIComponent(sel.yahoo)}&interval=${state.interval}`
      : `/api/signal?binance=${sel.binance}&id=${sel.id}&interval=${state.interval}`;
    const data = await apiJson(path);
    markBackendUp();
    if (reqId !== signalReq) return;
    if (data.error) throw new Error(data.error);

    state.selectedSignal = data.signal; // Cache signal locally for auto-fill
    state.candles = data.candles;       // for the volume-profile overlay

    candleSeries.setData(data.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    emaSeries.ema20.setData(data.signal.overlays.ema20);
    emaSeries.ema50.setData(data.signal.overlays.ema50);
    emaSeries.ema200.setData(data.signal.overlays.ema200);
    chart.timeScale().fitContent();
    setPriceLines(data.signal, data.candles[data.candles.length - 1]?.time);
    setOscData(data.signal.osc);
    drawZones();
    // the chart paints on the next frame — redraw zones & re-align the osc panels
    // once coordinates are available (the synchronous pass above runs pre-paint)
    requestAnimationFrame(() => {
      const r = chart.timeScale().getVisibleLogicalRange();
      if (r && oscReady) { oscRsi.timeScale().setVisibleLogicalRange(r); oscStoch.timeScale().setVisibleLogicalRange(r); }
      drawZones();
    });
    if (state.chartType === 'volume') drawVolumeProfile();
    else if (state.chartType === 'bookmap') renderBookmap();

    $('#chart-source').textContent = `data: ${data.source} · ${data.interval} · ${data.candles.length} candles`;
    renderSignalCard(data.signal, name);
    renderAnalysis(data.signal);
  } catch (err) {
    if (reqId !== signalReq) return;
    $('#signal-card').innerHTML = `<div class="loading">⚠ ${err.message}</div>`;
    $('#analysis').innerHTML = `<div class="loading">no data</div>`;
  }
}

function renderSignalCard(sig, name) {
  const tps = sig.takeProfits
    .map(
      (tp) => `
      <div class="lbl"><img src="asset/trophy.png" alt="" />${tp.label}</div><div class="val tp">$${fmtPrice(tp.price)}</div>
      <div class="r">${tp.r}R</div><div></div><div></div>`
    )
    .join('');
  $('#signal-card').innerHTML = `
    <div class="sig-grid">
      <div class="sig-dir ${sig.direction}">
        ${sig.direction}
        <small>confidence ${sig.confidence}% · score ${sig.score}</small>
        <small>${name}</small>
      </div>
      <div class="lvl-table">
        <div class="lbl"><img src="asset/wallet.png" alt="" />ENTRY</div><div class="val entry">$${fmtPrice(sig.entry)}</div><div class="r"></div>
        <div class="lbl"><img src="asset/pig.png" alt="" />RISK</div><div class="val">${sig.riskPct}%</div>
        <div class="lbl"><img src="asset/safe.png" alt="" />STOP LOSS</div><div class="val sl">$${fmtPrice(sig.stopLoss)}</div><div class="r"></div><div></div><div></div>
        ${tps}
      </div>
    </div>`;
}

// colour an oscillator value against its overbought/oversold bands
function oscClass(v, low, high) {
  if (v == null) return '';
  if (v >= high) return 'down'; // overbought = red (reversal risk)
  if (v <= low) return 'up';    // oversold = green (bounce zone)
  return '';
}

function renderAnalysis(sig) {
  const I = sig.indicators;
  const lv = sig.levels || { support: [], resistance: [] };
  const srRows = (arr, cls, prefix) =>
    arr.length
      ? arr.map((l, i) => `<div><span>${prefix}${i + 1}</span><b class="${cls}">${l.price} <small>×${l.strength}</small></b></div>`).join('')
      : `<div><span>${prefix}</span><b>–</b></div>`;
  $('#analysis').innerHTML = `
    <div class="ind-grid">
      <div><span>RSI(14)</span><b>${I.rsi ?? '–'}</b></div>
      <div><span>RSI(5) ·10/90</span><b class="${oscClass(I.rsi5, 10, 90)}">${I.rsi5 ?? '–'}</b></div>
      <div><span>STOCH %K ·20/80</span><b class="${oscClass(I.stochK, 20, 80)}">${I.stochK ?? '–'}</b></div>
      <div><span>STOCH %D</span><b>${I.stochD ?? '–'}</b></div>
      <div><span>MACD</span><b>${I.macdLine ?? '–'}</b></div>
      <div><span>MACD SIG</span><b>${I.macdSignal ?? '–'}</b></div>
      <div><span>ATR(14)</span><b>${I.atr ?? '–'}</b></div>
      <div><span>EMA20</span><b>${I.ema20 ?? '–'}</b></div>
      <div><span>EMA50</span><b>${I.ema50 ?? '–'}</b></div>
      <div><span>EMA200</span><b>${I.ema200 ?? '–'}</b></div>
      <div><span>BB UP/LO</span><b>${I.bbUpper ?? '–'} / ${I.bbLower ?? '–'}</b></div>
      <div><span>SWING HI/LO</span><b>${I.swingHigh ?? '–'} / ${I.swingLow ?? '–'}</b></div>
    </div>
    <div class="sr-block">
      <div class="sr-col"><div class="sr-head">RESISTANCE</div>${srRows(lv.resistance, 'down', 'R')}</div>
      <div class="sr-col"><div class="sr-head">SUPPORT</div>${srRows(lv.support, 'up', 'S')}</div>
    </div>
    <ul class="reasons">${sig.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>`;
}

/* ---------------- timeframe buttons ---------------- */
document.querySelectorAll('.tf-buttons button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-buttons button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.interval = btn.dataset.tf;
    loadSignal();
  });
});

/* ============================================================ */
/* ============== CHART VIEWS (candles/vp/heatmap) ============ */
/* ============================================================ */
function show(el, yes) { if (el) el.classList.toggle('hidden', !yes); }

function setActiveCT() {
  document.querySelectorAll('#ct-buttons button').forEach((b) =>
    b.classList.toggle('active', b.dataset.ct === state.chartType));
}

// Decide which view is visible based on category + chart type.
function applyView() {
  const isPoly = state.category === 'polymarket';
  const isBook = !isPoly && state.chartType === 'bookmap';
  const isVol = !isPoly && state.chartType === 'volume';
  const candleView = !isPoly && !isBook && !isVol;
  show($('#poly-detail'), isPoly);
  show($('#bookmap-view'), isBook);
  show($('#chart-wrap'), !isPoly && !isBook);
  show($('#osc-panels'), candleView && state.showOsc);
  show($('#signal-card'), !isPoly);
  document.querySelectorAll('#ct-buttons button').forEach((b) => { b.disabled = isPoly; });
  document.querySelectorAll('#tf-buttons button').forEach((b) => { b.disabled = isPoly; });
  if (isBook) renderBookmap();
  if (isVol) drawVolumeProfile(); else clearVolumeProfile();
  if (candleView) {
    drawZones();
    // osc panels may have just become visible — let them re-measure, then resync
    if (state.showOsc && oscReady) requestAnimationFrame(() => {
      const r = chart.timeScale().getVisibleLogicalRange();
      if (r) { oscRsi.timeScale().setVisibleLogicalRange(r); oscStoch.timeScale().setVisibleLogicalRange(r); }
    });
  } else { clearZones(); }
}

document.querySelectorAll('#ct-buttons button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.category === 'polymarket') return;
    state.chartType = btn.dataset.ct;
    setActiveCT();
    applyView();
    if (state.chartType === 'volume') { chart.timeScale().fitContent(); requestAnimationFrame(drawVolumeProfile); }
  });
});
// independent overlay toggles: ZONES (SMC/S-R boxes) and OSC (RSI/Stoch panels)
document.querySelectorAll('#overlay-toggles button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const on = btn.classList.toggle('active');
    if (btn.dataset.tog === 'zones') { state.showZones = on; show($('#zone-legend'), on); drawZones(); }
    else if (btn.dataset.tog === 'osc') { state.showOsc = on; applyView(); }
  });
});
window.addEventListener('resize', () => {
  if (state.category === 'polymarket') return;
  if (state.chartType === 'volume') drawVolumeProfile();
  else if (state.chartType === 'bookmap') renderBookmap();
  else drawZones();
});

/* ----- volume profile (volume-by-price histogram overlay) ----- */
function clearVolumeProfile() {
  const cv = $('#vp-overlay');
  if (cv && cv.getContext) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}
function drawVolumeProfile() {
  const cv = $('#vp-overlay');
  const wrap = $('#chart-wrap');
  if (!cv || !wrap || !state.candles || !state.candles.length) return;
  const rect = wrap.getBoundingClientRect();
  cv.width = rect.width; cv.height = rect.height;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  let lo = Infinity, hi = -Infinity, totalVol = 0;
  for (const c of state.candles) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; totalVol += c.volume || 0; }
  if (!(hi > lo)) return;
  if (totalVol <= 0) {
    ctx.fillStyle = '#5c6c8a'; ctx.font = '11px Consolas';
    ctx.fillText('volume profile: no volume data for this instrument', 12, 18);
    return;
  }
  const bins = 48;
  const vol = new Array(bins).fill(0);
  for (const c of state.candles) {
    const mid = (c.high + c.low) / 2;
    let b = Math.floor(((mid - lo) / (hi - lo)) * bins);
    b = Math.max(0, Math.min(bins - 1, b));
    vol[b] += c.volume || 0;
  }
  const maxVol = Math.max(...vol);
  const axisW = 58;             // leave room for the right price axis
  const maxW = rect.width * 0.30;
  for (let b = 0; b < bins; b++) {
    if (!vol[b]) continue;
    const pLow = lo + (b / bins) * (hi - lo);
    const pHigh = lo + ((b + 1) / bins) * (hi - lo);
    const yTop = candleSeries.priceToCoordinate(pHigh);
    const yBot = candleSeries.priceToCoordinate(pLow);
    if (yTop == null || yBot == null) continue;
    const h = Math.max(1, yBot - yTop - 1);
    const w = (vol[b] / maxVol) * maxW;
    ctx.fillStyle = vol[b] === maxVol ? 'rgba(240,185,11,0.55)' : 'rgba(59,130,246,0.35)'; // POC = amber
    ctx.fillRect(rect.width - axisW - w, yTop, w, h);
  }
}

/* ----- bookmap-style heatmap (time × price traded-volume heat, plus a
   live order-book liquidity column on the right edge for crypto) ----- */
// blue → cyan → green → yellow → red heat ramp for intensity t in [0,1]
function heatColor(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [10, 16, 40], [33, 80, 180], [22, 199, 199], [120, 210, 90], [240, 185, 11], [234, 57, 67],
  ];
  const x = t * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

let bookmapRetries = 0;
async function renderBookmap() {
  const view = $('#bookmap-view');
  const cv = $('#bookmap-canvas');
  if (!view || !cv || !state.candles || !state.candles.length) return;
  const rect = view.getBoundingClientRect();
  if (rect.width < 5 || rect.height < 5) { // not laid out yet — retry a few frames
    if (bookmapRetries++ < 30) requestAnimationFrame(renderBookmap);
    return;
  }
  bookmapRetries = 0;
  cv.width = rect.width; cv.height = rect.height;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#06090f';
  ctx.fillRect(0, 0, cv.width, cv.height);

  const candles = state.candles.slice(-140); // most recent columns
  let lo = Infinity, hi = -Infinity;
  for (const c of candles) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  if (!(hi > lo)) return;
  const pad = (hi - lo) * 0.04; lo -= pad; hi += pad; // breathing room

  const rows = 70;
  const bookW = state.selected.source === 'crypto' ? 70 : 0; // live book column (crypto only)
  const gridW = cv.width - bookW;
  const colW = gridW / candles.length;
  const yOf = (price) => cv.height - ((price - lo) / (hi - lo)) * cv.height;
  const rowOf = (price) => Math.floor(((price - lo) / (hi - lo)) * rows);

  // traded-volume heat: spread each candle's volume across the price rows it spans
  let maxCell = 0;
  const grid = candles.map((c) => {
    const col = new Array(rows).fill(0);
    const r1 = Math.max(0, rowOf(c.low)), r2 = Math.min(rows - 1, rowOf(c.high));
    const span = Math.max(1, r2 - r1 + 1);
    const per = (c.volume || 0) / span;
    for (let r = r1; r <= r2; r++) { col[r] += per; if (col[r] > maxCell) maxCell = col[r]; }
    return col;
  });
  const rowH = cv.height / rows;
  if (maxCell > 0) {
    for (let x = 0; x < candles.length; x++) {
      for (let r = 0; r < rows; r++) {
        const v = grid[x][r];
        if (!v) continue;
        ctx.fillStyle = heatColor(Math.pow(v / maxCell, 0.55));
        ctx.fillRect(x * colW, cv.height - (r + 1) * rowH, colW + 0.5, rowH + 0.5);
      }
    }
  } else {
    ctx.fillStyle = '#5c6c8a'; ctx.font = '11px Consolas';
    ctx.fillText('no traded-volume data for this instrument (forex/indices)', 12, 30);
  }

  // close-price line for orientation
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2; ctx.beginPath();
  candles.forEach((c, x) => {
    const px = x * colW + colW / 2, py = yOf(c.close);
    x === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.stroke();

  // live order-book liquidity column (resting bids/asks) on the right edge
  let legend = `BOOKMAP · traded volume heat · ${candles.length} bars`;
  if (bookW > 0) {
    try {
      const depth = await (await fetch(getApiHost() + `/api/depth?binance=${state.selected.binance}`)).json();
      if (depth && !depth.error) {
        const buckets = new Array(rows).fill(0);
        let maxLiq = 0;
        const add = (arr) => arr.forEach(({ price, qty }) => {
          if (price < lo || price > hi) return;
          const r = Math.min(rows - 1, Math.max(0, rowOf(price)));
          buckets[r] += qty; if (buckets[r] > maxLiq) maxLiq = buckets[r];
        });
        add(depth.bids); add(depth.asks);
        if (maxLiq > 0) {
          const x0 = gridW;
          for (let r = 0; r < rows; r++) {
            if (!buckets[r]) continue;
            const w = (buckets[r] / maxLiq) * bookW;
            const midPrice = lo + ((r + 0.5) / rows) * (hi - lo);
            ctx.fillStyle = depth.mid != null && midPrice >= depth.mid ? 'rgba(234,57,67,.75)' : 'rgba(22,199,132,.75)';
            ctx.fillRect(x0, cv.height - (r + 1) * rowH, w, rowH + 0.5);
          }
          ctx.strokeStyle = 'rgba(92,108,138,.5)'; ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, cv.height); ctx.stroke();
          legend += ' · right: live book (green bids / red asks)';
        }
      }
    } catch { /* no book → just the volume heat */ }
  }
  $('#bookmap-legend').textContent = legend;
}

/* ============================================================ */
/* =================== POLYMARKET (in scanner) =============== */
/* ============================================================ */
function dedupeMarkets(arr) {
  const seen = new Set(); const out = [];
  for (const m of arr) { if (!seen.has(m.id)) { seen.add(m.id); out.push(m); } }
  return out;
}

async function loadPolymarket(autoSelect = false) {
  try {
    const data = await (await fetch(getApiHost() + '/api/polymarket')).json();
    if (data && !data.error) {
      state.pmData = data;
      state.pmMarkets = dedupeMarkets([...(data.crypto || []), ...(data.trending || [])]);
      if (state.category === 'polymarket') {
        renderPolymarketScanner();
        if (autoSelect && state.pmMarkets.length) selectPolyMarket(state.pmMarkets[0]);
      }
    }
  } catch { /* keep old values */ }
}

function renderPolymarketScanner() {
  const markets = state.pmMarkets || [];
  const q = $('#search').value.trim().toLowerCase();
  const list = markets.filter((m) => !q || m.question.toLowerCase().includes(q));
  $('.scanner-head') && ($('.scanner-head').innerHTML = '<span>MARKET</span><span>YES</span><span>EDGE</span>');
  $('#scan-count').textContent = `(${list.length})`;
  if (!list.length) { $('#coin-list').innerHTML = '<div class="loading">loading markets…</div>'; return; }
  $('#coin-list').innerHTML = list.map((m) => {
    const yes = m.outcomes[0]?.price;
    const yesPct = yes != null ? Math.round(yes * 100) : null;
    const edge = m.quant?.signal?.edge;
    const edgeTxt = edge != null ? `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(0)}%` : '—';
    const edgeCls = edge == null ? 'NEUTRAL' : edge > 0.02 ? 'BUY' : edge < -0.02 ? 'SELL' : 'NEUTRAL';
    return `<div class="coin-row pm-row ${m.id === state.selectedPmMarket?.id ? 'selected' : ''}" data-id="${m.id}">
      <div class="pm-qrow" title="${m.question.replace(/"/g, '&quot;')}">${m.question}</div>
      <div class="px">${yesPct != null ? yesPct + '%' : '–'}</div>
      <div class="badge ${edgeCls}">${edgeTxt}</div>
    </div>`;
  }).join('');
  $('#coin-list').querySelectorAll('.pm-row').forEach((row) => row.addEventListener('click', () => {
    const m = state.pmMarkets.find((x) => x.id === row.dataset.id);
    if (m) selectPolyMarket(m);
  }));
}

function selectPolyMarket(m) {
  state.selectedPmMarket = { id: m.id, question: m.question, price: m.outcomes[0]?.price ?? 0.5, market: m };
  state.selected = { symbol: 'POLY', source: 'polymarket', name: m.question };
  $('#coin-title').textContent = 'POLYMARKET';
  $('#analysis-sym').textContent = '';
  renderPolymarketScanner();
  applyView();
  renderPolyDetail(m);
  renderPolyAnalysis(m);
}

function renderPolyDetail(m) {
  const host = $('#poly-detail');
  if (!host) return;
  const opts = [...m.outcomes].sort((a, b) => (b.price ?? 0) - (a.price ?? 0)).map((o) => {
    const p = o.price != null ? o.price * 100 : null;
    return `<div class="pm-opt"><span class="nm" title="${o.name}">${o.name}</span>
      <span class="bar"><i class="${p != null && p < 50 ? 'lo' : ''}" style="width:${p ?? 0}%"></i></span>
      <span class="pc">${p != null ? p.toFixed(0) + '%' : '–'}</span></div>`;
  }).join('');
  const yes = m.outcomes[0]?.price ?? 0.5;
  const q = m.quant;
  let quant = '<div class="hint">quant model is still warming up for this market…</div>';
  if (q && q.signal) {
    const s = q.signal;
    const recCls = s.action.startsWith('BUY') ? (s.direction === 'YES' ? 'up' : 'down') : '';
    quant = `<div class="poly-quant">
      <div><span>MODEL PROB</span><b>${(q.modelProbability * 100).toFixed(1)}%</b></div>
      <div><span>95% CI</span><b>${(q.credibleInterval[0] * 100).toFixed(0)}–${(q.credibleInterval[1] * 100).toFixed(0)}%</b></div>
      <div><span>MONTE CARLO</span><b>${(q.mcProbability * 100).toFixed(1)}%</b></div>
      <div><span>VOLATILITY</span><b>${(q.volatility * 100).toFixed(0)}%</b></div>
      <div><span>DAYS LEFT</span><b>${q.daysToExpiry}</b></div>
      <div><span>EDGE</span><b class="${s.edge >= 0 ? 'up' : 'down'}">${s.edge >= 0 ? '+' : ''}${(s.edge * 100).toFixed(1)}%</b></div>
    </div>
    <div class="poly-rec ${recCls}">RECOMMENDATION: ${s.action === 'HOLD' ? 'HOLD — no actionable edge'
      : `BUY ${s.direction} · ${s.confidence}% conf${s.kellyFraction ? ' · Kelly ' + (s.kellyFraction * 100).toFixed(1) + '%' : ''}`}</div>`;
  }
  host.innerHTML = `
    <div class="poly-detail-head"><a href="${m.url}" target="_blank" rel="noopener">${m.question} ↗</a></div>
    <div class="poly-opts">${opts}</div>
    ${quant}
    <div class="poly-trade">
      <button class="btn-pm-action BUY-YES" data-outcome="YES" data-px="${yes}">BUY YES ${(yes * 100).toFixed(0)}¢</button>
      <button class="btn-pm-action BUY-NO" data-outcome="NO" data-px="${1 - yes}">BUY NO ${((1 - yes) * 100).toFixed(0)}¢</button>
    </div>
    <div class="pm-meta">vol24h $${fmtBig(m.volume24h)} ${m.endDate ? '· ends ' + new Date(m.endDate).toLocaleDateString() : ''}</div>`;
  host.querySelectorAll('.btn-pm-action').forEach((b) =>
    b.addEventListener('click', () => prepPolyOrder(m, b.dataset.outcome, +b.dataset.px)));
}

function renderPolyAnalysis(m) {
  const q = m.quant;
  if (!q || !q.signal) { $('#analysis').innerHTML = '<div class="loading">quant model warming up…</div>'; return; }
  const s = q.signal;
  const yesNow = m.outcomes[0]?.price != null ? (m.outcomes[0].price * 100).toFixed(1) + '%' : '–';
  $('#analysis').innerHTML = `
    <div class="ind-grid">
      <div><span>MARKET YES</span><b>${yesNow}</b></div>
      <div><span>MODEL PROB</span><b>${(q.modelProbability * 100).toFixed(1)}%</b></div>
      <div><span>MONTE CARLO</span><b>${(q.mcProbability * 100).toFixed(1)}%</b></div>
      <div><span>95% CI</span><b>${(q.credibleInterval[0] * 100).toFixed(0)}-${(q.credibleInterval[1] * 100).toFixed(0)}%</b></div>
      <div><span>VOLATILITY</span><b>${(q.volatility * 100).toFixed(0)}%</b></div>
      <div><span>DAYS LEFT</span><b>${q.daysToExpiry}</b></div>
    </div>
    <ul class="reasons">
      <li>Quant ensemble = 60% particle filter + 40% Monte Carlo simulation</li>
      <li>Edge ${s.edge >= 0 ? '+' : ''}${(s.edge * 100).toFixed(1)}% (model − market) → ${s.action === 'HOLD' ? 'no actionable edge' : 'BUY ' + s.direction}</li>
      ${s.kellyFraction ? `<li>Half-Kelly stake suggestion: ${(s.kellyFraction * 100).toFixed(1)}% of bankroll</li>` : ''}
      <li>Model confidence ${s.confidence}%</li>
    </ul>`;
}

function prepPolyOrder(m, outcome, px) {
  state.selectedPmMarket = { id: m.id, question: m.question, price: +px, market: m };
  switchTab('order');
  $('#pm-order-selection').innerHTML = `
    <span class="q">${m.question}</span>
    <span class="stat">Target: <b>${outcome}</b> · Price: <b>${(+px * 100).toFixed(0)}¢</b></span>`;
  document.querySelectorAll('#poly-outcome button').forEach((b) => b.classList.remove('active'));
  const ob = $(`#poly-outcome button[data-outcome="${outcome}"]`);
  if (ob) { ob.classList.add('active'); activePolyOutcome = outcome; }
  $('#btn-submit-poly').removeAttribute('disabled');
  $('#poly-order-status').className = 'status-msg';
  $('#poly-order-status').textContent = '';
}

/* ---------------- accounts modal ---------------- */
const connections = { mexc: false, phantom: false, polymarket: false };

function updateConnCount() {
  const n = Object.values(connections).filter(Boolean).length;
  $('#conn-count').textContent = n ? `(${n})` : '';
}

$('#btn-connect').addEventListener('click', () => $('#modal-overlay').classList.remove('hidden'));
$('#modal-close').addEventListener('click', () => $('#modal-overlay').classList.add('hidden'));
$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#modal-overlay').classList.add('hidden');
});

// Configure API Host
const activeHost = getApiHost();
$('#api-host-url').value = activeHost;
if (activeHost) {
  $('#api-dot').className = 'dot on';
}

$('#api-host-save').addEventListener('click', async () => {
  let host = $('#api-host-url').value.trim();
  if (host) host = host.replace(/\/+$/, ''); // strip trailing slash
  if (host) { host = upgradeHttp(host); $('#api-host-url').value = host; } // avoid http→mixed-content on an https page

  const resultEl = $('#api-host-result');
  resultEl.className = 'acct-result';
  resultEl.innerHTML = 'testing connection…';

  try {
    const testUrl = host ? `${host}/api/global` : '/api/global';
    const res = await fetch(testUrl, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Server returned status ${res.status}`);
    await res.json();

    if (host) {
      localStorage.setItem('apiHost', host);
      $('#api-dot').className = 'dot on';
    } else {
      localStorage.removeItem('apiHost');
      $('#api-dot').className = 'dot off';
    }
    
    resultEl.innerHTML = '<span class="up" style="color:var(--green)">✓ Connection verified! Reloading dashboard…</span>';
    setTimeout(() => {
      loadGlobal();
      loadScan();
      loadSignal();
      loadPolymarket();
      loadPortfolio();
      loadAutotradeStatus();
    }, 800);
  } catch (err) {
    resultEl.innerHTML = `<span class="err">⚠ Connection failed: ${err.message}</span>`;
    $('#api-dot').className = 'dot off';
  }
});

// Fetch and render the USDⓈ-M FUTURES wallet (contract account). Drives the
// "MEXC FUTURES" balance card and the wallet breakdown in the CONNECT modal.
// MEXC sometimes blocks the contract account API on retail keys, so failures
// degrade gracefully to an explanatory note.
async function loadMexcFutures() {
  const card = $('#bal-mexc-live');
  const box = $('#mexc-futures-result');
  try {
    const data = await (await fetch(getApiHost() + '/api/mexc/futures')).json();
    if (data.error) throw new Error(data.error);
    const total = data.totalUsd ?? 0;
    if (card) card.textContent = `$${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    if (box) {
      if (!data.assets || !data.assets.length) {
        box.innerHTML = '<div class="total-line">FUTURES WALLET</div><div class="hint">no funded futures assets — wallet is empty</div>';
      } else {
        const rows = data.assets.map((a) => `
          <tr><td>${a.currency}</td><td>${a.equity}</td><td>${a.available}</td>
          <td class="${a.unrealized >= 0 ? 'up' : 'down'}">${a.unrealized >= 0 ? '+' : ''}${a.unrealized}</td></tr>`).join('');
        box.innerHTML = `
          <div class="total-line">FUTURES WALLET EQUITY $${total.toLocaleString()}</div>
          <table class="bal-table"><tr><th>COIN</th><th>EQUITY</th><th>AVAIL</th><th>uPNL</th></tr>${rows}</table>`;
      }
    }
  } catch (err) {
    if (card) card.textContent = 'N/A';
    if (box) box.innerHTML = `<div class="hint">⚠ futures wallet unavailable — ${err.message}</div>`;
  }
}

function renderMexcAccount(acct) {
  connections.mexc = true;
  $('#mexc-dot').className = 'dot on';
  $('#mexc-form').style.display = 'none';
  updateConnCount();
  const rows = acct.balances
    .slice(0, 12)
    .map(
      (b) => `<tr><td>${b.asset}</td><td>${b.total}</td>
        <td>${b.usdValue != null ? '$' + b.usdValue.toLocaleString() : '–'}</td></tr>`
    )
    .join('');
  $('#mexc-result').innerHTML = `
    ${acct.totalUsd != null ? `<div class="total-line">EST. TOTAL $${acct.totalUsd.toLocaleString()}</div>` : ''}
    <table class="bal-table"><tr><th>ASSET</th><th>BALANCE</th><th>USD</th></tr>${rows}</table>
    ${acct.balances.length > 12 ? `<div class="hint">+${acct.balances.length - 12} more assets</div>` : ''}
    <div class="acct-row"><button id="mexc-disconnect" class="btn-go" style="background:var(--red)">DISCONNECT</button></div>`;
  
  // the headline card now shows the FUTURES wallet (what live trades draw on)
  loadMexcFutures();

  $('#mexc-disconnect').addEventListener('click', async () => {
    await fetch(getApiHost() + '/api/disconnect/mexc', { method: 'POST' });
    connections.mexc = false;
    $('#mexc-dot').className = 'dot off';
    $('#mexc-form').style.display = '';
    $('#mexc-result').innerHTML = '';
    $('#mexc-futures-result').innerHTML = '';
    $('#bal-mexc-live').textContent = 'DISCONNECTED';
    updateConnCount();
  });
}

$('#mexc-connect').addEventListener('click', async () => {
  const key = $('#mexc-key').value.trim();
  const secret = $('#mexc-secret').value.trim();
  if (!key || !secret) {
    $('#mexc-result').innerHTML = '<span class="err">enter both API key and secret</span>';
    return;
  }
  $('#mexc-connect').disabled = true;
  $('#mexc-result').innerHTML = 'connecting…';
  try {
    const res = await fetch(getApiHost() + '/api/connect/mexc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, secret }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    $('#mexc-key').value = '';
    $('#mexc-secret').value = '';
    const acct = await (await fetch(getApiHost() + '/api/mexc/account')).json();
    if (acct.error) throw new Error(acct.error);
    renderMexcAccount(acct);
  } catch (err) {
    $('#mexc-result').innerHTML = `<span class="err">⚠ ${err.message}</span>`;
  } finally {
    $('#mexc-connect').disabled = false;
  }
});

(async () => {
  try {
    const st = await (await fetch(getApiHost() + '/api/mexc/status')).json();
    if (st.connected) {
      const acct = await (await fetch(getApiHost() + '/api/mexc/account')).json();
      if (!acct.error) renderMexcAccount(acct);
    }
  } catch { /* stay disconnected */ }
})();

/* ----- Phantom (Solana browser wallet) ----- */
async function fetchSolBalance(pubkey) {
  const res = await fetch('https://api.mainnet-beta.solana.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey] }),
  });
  const data = await res.json();
  return data?.result?.value != null ? data.result.value / 1e9 : null;
}

async function phantomConnect(onlyIfTrusted) {
  const provider = window.phantom?.solana;
  if (!provider?.isPhantom) {
    if (!onlyIfTrusted) {
      $('#phantom-result').innerHTML =
        '<span class="err">⚠ Phantom extension not detected — install it from <a href="https://phantom.app" target="_blank" rel="noopener" style="color:var(--blue)">phantom.app</a> and reload</span>';
    }
    return;
  }
  try {
    const resp = await provider.connect(onlyIfTrusted ? { onlyIfTrusted: true } : undefined);
    const pubkey = resp.publicKey.toString();
    connections.phantom = true;
    $('#phantom-dot').className = 'dot on';
    updateConnCount();
    $('#phantom-result').innerHTML = `<div class="total-line">${pubkey.slice(0, 6)}…${pubkey.slice(-6)}</div><div>SOL balance: loading…</div>`;
    const sol = await fetchSolBalance(pubkey);
    $('#phantom-result').innerHTML = `
      <div class="total-line">${pubkey.slice(0, 6)}…${pubkey.slice(-6)}</div>
      <div>SOL balance: <b>${sol != null ? sol.toFixed(4) + ' SOL' : 'unavailable (RPC limit)'}</b></div>`;
  } catch (err) {
    if (!onlyIfTrusted) $('#phantom-result').innerHTML = `<span class="err">⚠ ${err.message}</span>`;
  }
}

$('#phantom-connect').addEventListener('click', () => phantomConnect(false));
phantomConnect(true);

/* ----- Polymarket wallet ----- */
async function loadPolymarketAccount(address) {
  $('#pm-result').innerHTML = 'loading positions…';
  try {
    const data = await (await fetch(getApiHost() + `/api/polymarket/positions?address=${encodeURIComponent(address)}`)).json();
    if (data.error) throw new Error(data.error);
    connections.polymarket = true;
    $('#pm-dot').className = 'dot on';
    updateConnCount();
    localStorage.setItem('pmAddress', address);
    const items = data.positions
      .slice(0, 10)
      .map((p) => {
        const pnlCls = (p.cashPnl ?? 0) >= 0 ? 'up' : 'down';
        return `
        <div class="pos-item">
          <div class="pos-title">${p.title} — <b>${p.outcome}</b></div>
          <div class="pos-meta">
            <span>size ${p.size?.toFixed(1) ?? '–'}</span>
            <span>avg ${(p.avgPrice * 100).toFixed(0)}¢ → now ${(p.curPrice * 100).toFixed(0)}¢</span>
            <span>value $${p.currentValue?.toFixed(2) ?? '–'}</span>
            <span class="${pnlCls}">PnL ${p.cashPnl >= 0 ? '+' : ''}$${p.cashPnl?.toFixed(2)} (${p.percentPnl?.toFixed(1)}%)</span>
          </div>
        </div>`;
      })
      .join('');
    $('#pm-result').innerHTML = `
      ${data.portfolioValue != null ? `<div class="total-line">PORTFOLIO VALUE $${data.portfolioValue.toLocaleString()}</div>` : ''}
      ${items || '<div class="hint">no open positions on this address</div>'}`;
  } catch (err) {
    $('#pm-result').innerHTML = `<span class="err">⚠ ${err.message}</span>`;
  }
}

$('#pm-connect').addEventListener('click', () => {
  const address = $('#pm-address').value.trim();
  if (address) loadPolymarketAccount(address);
});
if (localStorage.getItem('pmAddress')) {
  $('#pm-address').value = localStorage.getItem('pmAddress');
  loadPolymarketAccount(localStorage.getItem('pmAddress'));
}

/* ------------------------------------------------------------- */
/* -------------------- TRADING HUB SYSTEM -------------------- */
/* ------------------------------------------------------------- */

let activeHubTab = 'positions';
function switchTab(tabId) {
  activeHubTab = tabId;
  document.querySelectorAll('.hub-tabs button').forEach((btn) => btn.classList.remove('active'));
  $(`#hub-tab-${tabId}`).classList.add('active');

  document.querySelectorAll('.hub-pane').forEach((pane) => pane.classList.add('hidden'));
  $(`#hub-pane-${tabId}`).classList.remove('hidden');
}

document.querySelectorAll('.hub-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.id.replace('hub-tab-', '');
    switchTab(tab);
  });
});

async function closePosition(market, id, price) {
  try {
    const res = await fetch(getApiHost() + '/api/trade/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market, id, price }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    loadPortfolio();
  } catch (err) {
    alert(`Close trade failed: ${err.message}`);
  }
}

async function loadPortfolio() {
  try {
    const snap = await apiJson('/api/portfolio');
    markBackendUp();
    if (snap.error) return;

    $('#bal-crypto-paper').textContent = `$${snap.paperBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    $('#bal-poly-paper').textContent = `$${snap.polymarketPaperBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    if (!snap.positions || snap.positions.length === 0) {
      $('#crypto-positions-list').innerHTML = '<div class="hint">no open crypto positions</div>';
    } else {
      const rows = snap.positions.map((p) => {
        const pnlCls = (p.uPnl ?? 0) >= 0 ? 'up' : 'down';
        const sign = (p.uPnl ?? 0) >= 0 ? '+' : '';
        const slText = p.sl != null ? p.sl : 'none';
        const tpText = p.tp != null ? p.tp : 'none';
        return `
          <tr>
            <td><b>${p.symbol}</b></td>
            <td><span class="badge ${p.side}">${p.side}</span></td>
            <td>$${fmtPrice(p.entry)}</td>
            <td>$${fmtPrice(p.markPrice)}</td>
            <td>${slText} / ${tpText}</td>
            <td><span class="${pnlCls}">${sign}$${p.uPnl?.toFixed(2) || '0.00'} (${sign}${p.uPnlPct?.toFixed(1) || '0'}%)</span></td>
            <td><button class="btn-close-pos" onclick="closePosition('crypto', '${p.id}', ${p.markPrice})">CLOSE</button></td>
          </tr>`;
      }).join('');
      $('#crypto-positions-list').innerHTML = `
        <table class="trade-table">
          <thead>
            <tr>
              <th>ASSET</th>
              <th>SIDE</th>
              <th>ENTRY</th>
              <th>MARK</th>
              <th>SL/TP</th>
              <th>PNL</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>`;
    }

    if (!snap.polymarketPositions || snap.polymarketPositions.length === 0) {
      $('#poly-positions-list').innerHTML = '<div class="hint">no open prediction positions</div>';
    } else {
      const rows = snap.polymarketPositions.map((p) => {
        const pnlCls = (p.uPnl ?? 0) >= 0 ? 'up' : 'down';
        const sign = (p.uPnl ?? 0) >= 0 ? '+' : '';
        const truncatedQ = p.question.length > 30 ? p.question.slice(0, 28) + '…' : p.question;
        const entryCents = (p.entry * 100).toFixed(0) + '¢';
        const markCents = p.markPrice != null ? (p.markPrice * 100).toFixed(0) + '¢' : '–';
        return `
          <tr>
            <td title="${p.question}"><b>${truncatedQ}</b></td>
            <td><span class="badge ${p.outcome === 'YES' ? 'BUY' : 'SELL'}">${p.outcome}</span></td>
            <td>${entryCents}</td>
            <td>${markCents}</td>
            <td>$${p.sizeUsdc.toFixed(2)}</td>
            <td><span class="${pnlCls}">${sign}$${p.uPnl?.toFixed(2) || '0.00'} (${sign}${p.uPnlPct?.toFixed(1) || '0'}%)</span></td>
            <td><button class="btn-close-pos" onclick="closePosition('polymarket', '${p.id}', ${p.markPrice})">CLOSE</button></td>
          </tr>`;
      }).join('');
      $('#poly-positions-list').innerHTML = `
        <table class="trade-table">
          <thead>
            <tr>
              <th>CONTRACT</th>
              <th>OUTCOME</th>
              <th>ENTRY</th>
              <th>MARK</th>
              <th>SIZE</th>
              <th>PNL</th>
              <th>ACTION</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>`;
    }
  } catch (err) {
    markBackendDown('portfolio', err);
  }
}

window.closePosition = closePosition;

let activeCryptoSide = 'LONG';
document.querySelectorAll('#crypto-side button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#crypto-side button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeCryptoSide = btn.dataset.side;
  });
});

$('#btn-autofill-crypto').addEventListener('click', () => {
  const sig = state.selectedSignal;
  if (!sig) return;
  $('#crypto-sl').value = sig.stopLoss != null ? sig.stopLoss : '';
  $('#crypto-tp').value = sig.takeProfits[0]?.price != null ? sig.takeProfits[0].price : '';
});

$('#btn-submit-crypto').addEventListener('click', async () => {
  const statusGuard = $('#crypto-order-status');
  if (state.selected.source === 'yahoo') {
    statusGuard.className = 'status-msg error';
    statusGuard.textContent = 'Forex / indices / KLCI are analysis-only — no broker connected for these. Trading works on crypto (MEXC) & Polymarket.';
    return;
  }
  const symbol = state.selected.symbol;
  const binanceSymbol = state.selected.binance;
  const side = activeCryptoSide;
  const usdt = $('#crypto-amount').value;
  const leverage = $('#crypto-leverage').value;
  const price = state.selectedSignal?.entry || (state.coins.find(c => c.symbol === symbol)?.price);
  const sl = $('#crypto-sl').value;
  const tp = $('#crypto-tp').value;
  const mode = $('#crypto-mode').value;

  const statusEl = $('#crypto-order-status');
  statusEl.className = 'status-msg';
  statusEl.textContent = 'submitting order…';

  try {
    const res = await fetch(getApiHost() + '/api/trade/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        market: 'crypto',
        symbol,
        binanceSymbol,
        side,
        usdt,
        leverage,
        price,
        sl: sl ? sl : null,
        tp: tp ? tp : null,
        mode,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    statusEl.className = 'status-msg success';
    statusEl.textContent = `Success! Opened ${side} ${symbol} pos.`;
    $('#crypto-sl').value = '';
    $('#crypto-tp').value = '';
    loadPortfolio();
  } catch (err) {
    statusEl.className = 'status-msg error';
    statusEl.textContent = `Failed: ${err.message}`;
  }
});

let activePolyOutcome = 'YES';
document.querySelectorAll('#poly-outcome button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#poly-outcome button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activePolyOutcome = btn.dataset.outcome;
  });
});

$('#btn-submit-poly').addEventListener('click', async () => {
  const pm = state.selectedPmMarket;
  if (!pm) return;
  const outcome = activePolyOutcome;
  const sizeUsdc = $('#poly-amount').value;
  const mode = $('#poly-mode').value;
  
  let price = pm.price;
  
  const statusEl = $('#poly-order-status');
  statusEl.className = 'status-msg';
  statusEl.textContent = 'submitting prediction…';

  try {
    const res = await fetch(getApiHost() + '/api/trade/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        market: 'polymarket',
        marketId: pm.id,
        question: pm.question,
        outcome,
        sizeUsdc,
        price,
        mode,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    statusEl.className = 'status-msg success';
    statusEl.textContent = `Success! Purchased ${outcome} contracts.`;
    loadPortfolio();
  } catch (err) {
    statusEl.className = 'status-msg error';
    statusEl.textContent = `Failed: ${err.message}`;
  }
});

// ON/OFF master switch styling for an auto-trade bot. The button's `on` class
// is the source of truth for the bot's enabled state in the UI.
function setAutoToggle(btn, on) {
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  btn.textContent = on ? '■ STOP AUTO-TRADE' : '▶ START AUTO-TRADE';
}
function isAutoOn(btn) { return !!btn && btn.classList.contains('on'); }

async function loadAutotradeStatus() {
  try {
    const data = await apiJson('/api/autotrade/status');
    markBackendUp();
    if (data.error) return;

    // Crypto Bot
    const c = data.crypto;
    setAutoToggle($('#btn-toggle-crypto-auto'), c.enabled);
    $('#crypto-auto-mode').value = c.mode;
    $('#crypto-auto-confidence').value = c.minConfidence;
    $('#crypto-auto-size').value = c.usdtPerTrade;
    $('#crypto-auto-interval').value = c.intervalMin;
    $('#crypto-auto-max').value = c.maxPositions;
    $('#crypto-auto-leverage').value = c.leverage ?? 3;
    $('#crypto-auto-be-trigger').value = c.beTrigger ?? 0.4;
    $('#crypto-auto-be').checked = c.beEnabled !== false;
    $('#crypto-auto-dot').className = c.enabled ? 'dot on' : 'dot off';

    // Polymarket Bot
    const pm = data.polymarket;
    setAutoToggle($('#btn-toggle-poly-auto'), pm.enabled);
    $('#poly-auto-mode').value = pm.mode;
    $('#poly-auto-edge').value = pm.minEdge * 100;
    $('#poly-auto-size').value = pm.usdcPerTrade;
    $('#poly-auto-interval').value = pm.intervalMin;
    $('#poly-auto-max').value = pm.maxPositions;
    $('#poly-auto-dot').className = pm.enabled ? 'dot on' : 'dot off';

    // Logs
    if (Array.isArray(data.log)) {
      const logsHtml = data.log.map((log) => {
        const timeStr = new Date(log.at).toLocaleTimeString('en-GB');
        return `<div class="log-line ${log.level}">[${timeStr}] ${log.msg}</div>`;
      }).join('');
      $('#autotrade-logs').innerHTML = logsHtml || '<div class="hint">No bot activities logged yet.</div>';
    }
  } catch (err) {
    markBackendDown('autotrader', err);
  }
}

// Push the crypto bot config with an explicit enabled flag. Used by both the
// SAVE button (keeps current on/off) and the START/STOP toggle (flips it).
async function applyCryptoAuto(enabled) {
  const mode = $('#crypto-auto-mode').value;
  // guard: don't silently fire real MEXC futures orders
  if (enabled && mode === 'live' &&
      !confirm('Start LIVE auto-trading on MEXC FUTURES? Real leveraged orders will be placed automatically.')) {
    return;
  }
  const config = {
    enabled,
    mode,
    minConfidence: $('#crypto-auto-confidence').value,
    usdtPerTrade: $('#crypto-auto-size').value,
    intervalMin: $('#crypto-auto-interval').value,
    maxPositions: $('#crypto-auto-max').value,
    leverage: $('#crypto-auto-leverage').value,
    beTrigger: $('#crypto-auto-be-trigger').value,
    beEnabled: $('#crypto-auto-be').checked,
  };
  setAutoToggle($('#btn-toggle-crypto-auto'), enabled); // optimistic
  try {
    await fetch(getApiHost() + '/api/autotrade/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: 'crypto', config }),
    });
    loadAutotradeStatus();
  } catch (err) {
    alert(`Save crypto bot config failed: ${err.message}`);
    loadAutotradeStatus(); // resync the toggle with the real state
  }
}
$('#btn-save-crypto-auto').addEventListener('click', () => applyCryptoAuto(isAutoOn($('#btn-toggle-crypto-auto'))));
$('#btn-toggle-crypto-auto').addEventListener('click', () => applyCryptoAuto(!isAutoOn($('#btn-toggle-crypto-auto'))));

async function applyPolyAuto(enabled) {
  const config = {
    enabled,
    mode: $('#poly-auto-mode').value,
    minEdge: $('#poly-auto-edge').value / 100.0,
    usdcPerTrade: $('#poly-auto-size').value,
    intervalMin: $('#poly-auto-interval').value,
    maxPositions: $('#poly-auto-max').value,
  };
  setAutoToggle($('#btn-toggle-poly-auto'), enabled); // optimistic
  try {
    await fetch(getApiHost() + '/api/autotrade/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ market: 'polymarket', config }),
    });
    loadAutotradeStatus();
  } catch (err) {
    alert(`Save poly bot config failed: ${err.message}`);
    loadAutotradeStatus();
  }
}
$('#btn-save-poly-auto').addEventListener('click', () => applyPolyAuto(isAutoOn($('#btn-toggle-poly-auto'))));
$('#btn-toggle-poly-auto').addEventListener('click', () => applyPolyAuto(!isAutoOn($('#btn-toggle-poly-auto'))));

/* ---------------- boot ---------------- */
initChart();
setActiveCT();
loadGlobal();
loadScan();
loadSignal();
loadPolymarket();

// Boot Trading hub
loadPortfolio();
loadAutotradeStatus();

// Setup polling timers
setInterval(loadGlobal, 120_000);
setInterval(loadScan, 60_000);
setInterval(loadSignal, 60_000);
setInterval(loadPolymarket, 120_000);

// Polling for portfolio & autotrader
setInterval(loadPortfolio, 5000);
setInterval(loadAutotradeStatus, 10000);

// refresh the live MEXC futures wallet on a slower cadence (rate-limit friendly)
setInterval(() => { if (connections.mexc) loadMexcFutures(); }, 30000);
