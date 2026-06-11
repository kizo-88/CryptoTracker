/* CryptoTracker Terminal — frontend */
const $ = (sel) => document.querySelector(sel);

const state = {
  coins: [],
  selected: { symbol: 'BTC', binance: 'BTCUSDT', id: 'bitcoin', name: 'Bitcoin' },
  interval: '4h',
  pmTab: 'crypto',
  pmData: null,
};

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

/* ---------------- clock ---------------- */
setInterval(() => {
  $('#clock').textContent = new Date().toLocaleTimeString('en-GB') + ' LOCAL';
}, 1000);

/* ---------------- global stats ---------------- */
async function loadGlobal() {
  try {
    const g = await (await fetch('/api/global')).json();
    const chg = g.marketCapChange24h;
    $('#global-stats').innerHTML = `
      <span>MCAP <b>$${fmtBig(g.totalMarketCap)}</b> <span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '▲' : '▼'}${Math.abs(chg).toFixed(2)}%</span></span>
      <span>VOL24H <b>$${fmtBig(g.totalVolume)}</b></span>
      <span>BTC.D <b>${g.btcDominance?.toFixed(1)}%</b></span>
      <span>ETH.D <b>${g.ethDominance?.toFixed(1)}%</b></span>`;
  } catch { /* keep old values */ }
}

/* ---------------- scanner ---------------- */
async function loadScan() {
  try {
    const coins = await (await fetch('/api/scan')).json();
    if (Array.isArray(coins)) {
      state.coins = coins;
      renderScanner();
    }
  } catch { /* keep old values */ }
}

function renderScanner() {
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
      <div class="px">$${fmtPrice(c.price)}</div>
      <div class="chg">${pct(c.change24h)}</div>
      <div class="badge ${c.quickSignal}">${c.quickSignal === 'NEUTRAL' ? 'WAIT' : c.quickSignal}</div>
    </div>`
    )
    .join('');
  document.querySelectorAll('.coin-row').forEach((row) => {
    row.addEventListener('click', () => {
      const c = state.coins.find((x) => x.symbol === row.dataset.sym);
      if (!c) return;
      state.selected = { symbol: c.symbol, binance: c.binanceSymbol, id: c.id, name: c.name };
      renderScanner();
      loadSignal();
    });
  });
}

$('#search').addEventListener('input', renderScanner);

/* ---------------- chart ---------------- */
let chart, candleSeries, emaSeries = {}, priceLines = [];

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
  // entry is the boldest line on the chart so it reads at a glance
  mk(sig.entry, '#3b82f6', `◄ ENTRY ${sig.lean}`, LightweightCharts.LineStyle.Solid, 2);
  mk(sig.stopLoss, '#ea3943', 'SL');
  sig.takeProfits.forEach((tp) => mk(tp.price, '#16c784', tp.label));
  // arrow marker on the latest candle pointing at the entry
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
let signalReq = 0; // guards against a slow stale response overwriting a newer one
async function loadSignal() {
  const reqId = ++signalReq;
  const { symbol, binance, id, name } = state.selected;
  $('#coin-title').textContent = `${symbol} / USDT`;
  $('#signal-card').innerHTML = '<div class="loading">analysing…</div>';
  $('#analysis').innerHTML = '<div class="loading">computing indicators…</div>';
  try {
    const res = await fetch(`/api/signal?binance=${binance}&id=${id}&interval=${state.interval}`);
    const data = await res.json();
    if (reqId !== signalReq) return; // a newer request superseded this one
    if (data.error) throw new Error(data.error);

    candleSeries.setData(data.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    emaSeries.ema20.setData(data.signal.overlays.ema20);
    emaSeries.ema50.setData(data.signal.overlays.ema50);
    emaSeries.ema200.setData(data.signal.overlays.ema200);
    chart.timeScale().fitContent();
    setPriceLines(data.signal, data.candles[data.candles.length - 1]?.time);

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
      <div class="lbl">${tp.label}</div><div class="val tp">$${fmtPrice(tp.price)}</div>
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
        <div class="lbl">ENTRY</div><div class="val entry">$${fmtPrice(sig.entry)}</div><div class="r"></div>
        <div class="lbl">RISK</div><div class="val">${sig.riskPct}%</div>
        <div class="lbl">STOP LOSS</div><div class="val sl">$${fmtPrice(sig.stopLoss)}</div><div class="r"></div><div></div><div></div>
        ${tps}
      </div>
    </div>`;
}

function renderAnalysis(sig) {
  const I = sig.indicators;
  $('#analysis').innerHTML = `
    <div class="ind-grid">
      <div><span>RSI(14)</span><b>${I.rsi ?? '–'}</b></div>
      <div><span>ATR(14)</span><b>${I.atr ?? '–'}</b></div>
      <div><span>MACD</span><b>${I.macdLine ?? '–'}</b></div>
      <div><span>MACD SIG</span><b>${I.macdSignal ?? '–'}</b></div>
      <div><span>EMA20</span><b>${I.ema20 ?? '–'}</b></div>
      <div><span>EMA50</span><b>${I.ema50 ?? '–'}</b></div>
      <div><span>EMA200</span><b>${I.ema200 ?? '–'}</b></div>
      <div><span>BB UP/LO</span><b>${I.bbUpper ?? '–'} / ${I.bbLower ?? '–'}</b></div>
      <div><span>SWING HI</span><b>${I.swingHigh ?? '–'}</b></div>
      <div><span>SWING LO</span><b>${I.swingLow ?? '–'}</b></div>
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

/* ---------------- polymarket ---------------- */
async function loadPolymarket() {
  try {
    const data = await (await fetch('/api/polymarket')).json();
    if (data && !data.error) {
      state.pmData = data;
      renderPolymarket();
    }
  } catch { /* keep old values */ }
}

function renderPolymarket() {
  if (!state.pmData) return;
  const items = state.pmData[state.pmTab] || [];
  if (!items.length) {
    $('#polymarket').innerHTML = '<div class="loading">no markets found</div>';
    return;
  }
  $('#polymarket').innerHTML = items
    .map((m) => {
      const yes = m.outcomes[0];
      const yesPct = yes?.price != null ? Math.round(yes.price * 100) : null;
      const outs = m.outcomes
        .slice(0, 2)
        .map((o) => {
          const p = o.price != null ? (o.price * 100).toFixed(0) + '%' : '–';
          const cls = o.price != null && o.price >= 0.5 ? 'hi' : 'lo';
          return `<span class="pm-out">${o.name} <b class="${cls}">${p}</b></span>`;
        })
        .join('');
      return `
      <div class="pm-item">
        <div class="pm-q"><a href="${m.url}" target="_blank" rel="noopener">${m.question}</a></div>
        <div class="pm-outcomes">${outs}</div>
        ${yesPct != null ? `<div class="pm-bar"><i style="width:${yesPct}%"></i></div>` : ''}
        <div class="pm-meta">vol24h $${fmtBig(m.volume24h)} ${m.endDate ? '· ends ' + new Date(m.endDate).toLocaleDateString() : ''}</div>
      </div>`;
    })
    .join('');
}

$('#pm-tab-crypto').addEventListener('click', () => {
  state.pmTab = 'crypto';
  $('#pm-tab-crypto').classList.add('active');
  $('#pm-tab-trending').classList.remove('active');
  renderPolymarket();
});
$('#pm-tab-trending').addEventListener('click', () => {
  state.pmTab = 'trending';
  $('#pm-tab-trending').classList.add('active');
  $('#pm-tab-crypto').classList.remove('active');
  renderPolymarket();
});

/* ---------------- boot ---------------- */
initChart();
loadGlobal();
loadScan();
loadSignal();
loadPolymarket();
setInterval(loadGlobal, 120_000);
setInterval(loadScan, 60_000);
setInterval(loadSignal, 60_000);
setInterval(loadPolymarket, 120_000);
