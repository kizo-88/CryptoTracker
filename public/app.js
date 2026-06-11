/* CryptoTracker Terminal — frontend */
const $ = (sel) => document.querySelector(sel);

const state = {
  coins: [],
  selected: { symbol: 'BTC', binance: 'BTCUSDT', id: 'bitcoin', name: 'Bitcoin' },
  interval: '4h',
  pmTab: 'crypto',
  pmData: null,
  selectedSignal: null,
  selectedPmMarket: null, // holds { id, question, price } for trading
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
      // Update symbol indicator on manual order form
      $('#order-crypto-symbol').textContent = c.symbol;
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
  mk(sig.entry, '#3b82f6', `◄ ENTRY ${sig.lean}`, LightweightCharts.LineStyle.Solid, 2);
  mk(sig.stopLoss, '#ea3943', 'SL');
  sig.takeProfits.forEach((tp) => mk(tp.price, '#16c784', tp.label));
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
  const reqId = ++signalReq;
  const { symbol, binance, id, name } = state.selected;
  $('#coin-title').textContent = `${symbol} / USDT`;
  $('#signal-card').innerHTML = '<div class="loading">analysing…</div>';
  $('#analysis').innerHTML = '<div class="loading">computing indicators…</div>';
  try {
    const res = await fetch(`/api/signal?binance=${binance}&id=${id}&interval=${state.interval}`);
    const data = await res.json();
    if (reqId !== signalReq) return;
    if (data.error) throw new Error(data.error);

    state.selectedSignal = data.signal; // Cache signal locally for auto-fill

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
    $('#polymarket').innerHTML = `<div class="loading">no active ${state.pmTab} markets right now${state.pmTab === 'crypto' ? ' — check the TRENDING tab' : ''}</div>`;
    return;
  }
  $('#polymarket').innerHTML = items
    .map((m) => {
      // every option of the market, sorted by implied probability
      const opts = [...m.outcomes]
        .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
        .slice(0, 6)
        .map((o) => {
          const pctNum = o.price != null ? o.price * 100 : null;
          return `
          <div class="pm-opt">
            <span class="nm" title="${o.name}">${o.name}</span>
            <span class="bar"><i class="${pctNum != null && pctNum < 50 ? 'lo' : ''}" style="width:${pctNum ?? 0}%"></i></span>
            <span class="pc">${pctNum != null ? pctNum.toFixed(0) + '%' : '–'}</span>
          </div>`;
        })
        .join('');
      const more = m.outcomes.length > 6 ? `<div class="pm-meta">+${m.outcomes.length - 6} more options</div>` : '';

      // Quant engine estimation block
      let quantHtml = '';
      if (m.quant && m.quant.signal) {
        const q = m.quant;
        const sig = q.signal;
        const dirClass = sig.action.startsWith('BUY') ? sig.action : 'HOLD';
        const recText = sig.action === 'HOLD' ? 'HOLD' : `BUY ${sig.direction}`;
        quantHtml = `
        <div class="pm-quant-badge">
          <span>MODEL PROB: <b>${(q.modelProbability * 100).toFixed(0)}%</b> (CI: [${(q.credibleInterval[0]*100).toFixed(0)}-${(q.credibleInterval[1]*100).toFixed(0)}%])</span>
          <span class="edge-val ${dirClass}">EDGE: <b>${sig.edge >= 0 ? '+' : ''}${(sig.edge * 100).toFixed(1)}%</b> (${recText})</span>
        </div>`;
      }

      // Quick trade buttons
      const yesPrice = m.outcomes[0]?.price != null ? (m.outcomes[0].price * 100).toFixed(0) + '¢' : '–';
      const noPrice = m.outcomes[0]?.price != null ? ((1.0 - m.outcomes[0].price) * 100).toFixed(0) + '¢' : '–';
      const tradeRow = `
      <div class="pm-trade-row">
        <button class="btn-pm-action BUY-YES" data-id="${m.id}" data-q="${m.question.replace(/"/g, '&quot;')}" data-outcome="YES" data-px="${m.outcomes[0]?.price || 0.5}">BUY YES ${yesPrice}</button>
        <button class="btn-pm-action BUY-NO" data-id="${m.id}" data-q="${m.question.replace(/"/g, '&quot;')}" data-outcome="NO" data-px="${1.0 - (m.outcomes[0]?.price || 0.5)}">BUY NO ${noPrice}</button>
      </div>`;

      return `
      <div class="pm-item">
        <div class="pm-q"><a href="${m.url}" target="_blank" rel="noopener">${m.question}</a></div>
        ${opts}${more}
        ${quantHtml}
        ${tradeRow}
        <div class="pm-meta">vol24h $${fmtBig(m.volume24h)} ${m.endDate ? '· ends ' + new Date(m.endDate).toLocaleDateString() : ''}</div>
      </div>`;
    })
    .join('');

  // Bind Polymarket quick trade buttons
  document.querySelectorAll('.btn-pm-action').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { id, q, outcome, px } = btn.dataset;
      state.selectedPmMarket = { id, question: q, price: +px };

      // Switch to order tab
      switchTab('order');

      // Update Polymarket order selection pane
      $('#pm-order-selection').innerHTML = `
        <span class="q">${q}</span>
        <span class="stat">Target: <b>${outcome}</b> · Current Price: <b>${(+px * 100).toFixed(0)}¢</b></span>`;
      
      // Select outcome radio button
      document.querySelectorAll('#poly-outcome button').forEach((b) => b.classList.remove('active'));
      $(`#poly-outcome button[data-outcome="${outcome}"]`).classList.add('active');

      // Enable submit button
      $('#btn-submit-poly').removeAttribute('disabled');
      $('#poly-order-status').className = 'status-msg';
      $('#poly-order-status').textContent = '';
    });
  });
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
  
  // Update Live Balance indicator in Bottom hub
  $('#bal-mexc-live').textContent = acct.totalUsd != null ? `$${acct.totalUsd.toLocaleString()}` : 'CONNECTED';

  $('#mexc-disconnect').addEventListener('click', async () => {
    await fetch('/api/disconnect/mexc', { method: 'POST' });
    connections.mexc = false;
    $('#mexc-dot').className = 'dot off';
    $('#mexc-form').style.display = '';
    $('#mexc-result').innerHTML = '';
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
    const res = await fetch('/api/connect/mexc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, secret }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    $('#mexc-key').value = '';
    $('#mexc-secret').value = '';
    const acct = await (await fetch('/api/mexc/account')).json();
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
    const st = await (await fetch('/api/mexc/status')).json();
    if (st.connected) {
      const acct = await (await fetch('/api/mexc/account')).json();
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
    const data = await (await fetch(`/api/polymarket/positions?address=${encodeURIComponent(address)}`)).json();
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

// Position cancel/close helper
async function closePosition(market, id, price) {
  try {
    const res = await fetch('/api/trade/close', {
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

// 1. Portfolio Updates (Balances and Open Positions)
async function loadPortfolio() {
  try {
    const snap = await (await fetch('/api/portfolio')).json();
    if (snap.error) return;

    // Balances
    $('#bal-crypto-paper').textContent = `$${snap.paperBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    $('#bal-poly-paper').textContent = `$${snap.polymarketPaperBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

    // Render Crypto Positions
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

    // Render Polymarket Positions
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
    console.error('Error loading portfolio:', err.message);
  }
}

// Bind closePosition globally for inline HTML onclick handlers
window.closePosition = closePosition;

// 2. Manual Order Management
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
  const symbol = state.selected.symbol;
  const binanceSymbol = state.selected.binance;
  const side = activeCryptoSide;
  const usdt = $('#crypto-amount').value;
  const price = state.selectedSignal?.entry || (state.coins.find(c => c.symbol === symbol)?.price);
  const sl = $('#crypto-sl').value;
  const tp = $('#crypto-tp').value;
  const mode = $('#crypto-mode').value;

  const statusEl = $('#crypto-order-status');
  statusEl.className = 'status-msg';
  statusEl.textContent = 'submitting order…';

  try {
    const res = await fetch('/api/trade/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        market: 'crypto',
        symbol,
        binanceSymbol,
        side,
        usdt,
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
  
  // Calculate price based on selected YES/NO.
  // YES price is pm.price (if selected YES), NO price is 1.0 - YES price (if selected NO)
  // Wait, if they clicked Buy NO from shortcut, state.selectedPmMarket.price is already pre-set to the NO price!
  // But let's check: if outcome matches selection, use price; else invert YES price.
  let price = pm.price;
  
  const statusEl = $('#poly-order-status');
  statusEl.className = 'status-msg';
  statusEl.textContent = 'submitting prediction…';

  try {
    const res = await fetch('/api/trade/open', {
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

// 3. Autotrader Configurations
async function loadAutotradeStatus() {
  try {
    const res = await fetch('/api/autotrade/status');
    const data = await res.json();
    if (data.error) return;

    // Crypto Form Fill
    const c = data.crypto;
    $('#crypto-auto-enabled').checked = c.enabled;
    $('#crypto-auto-mode').value = c.mode;
    $('#crypto-auto-confidence').value = c.minConfidence;
    $('#crypto-auto-size').value = c.usdtPerTrade;
    $('#crypto-auto-interval').value = c.intervalMin;
    $('#crypto-auto-max').value = c.maxPositions;
    $('#crypto-auto-dot').className = c.enabled ? 'dot on' : 'dot off';

    // Polymarket Form Fill
    const pm = data.polymarket;
    $('#poly-auto-enabled').checked = pm.enabled;
    $('#poly-auto-mode').value = pm.mode;
    $('#poly-auto-edge').value = pm.minEdge * 100;
    $('#poly-auto-size').value = pm.usdcPerTrade;
    $('#poly-auto-interval').value = pm.intervalMin;
    $('#poly-auto-max').value = pm.maxPositions;
    $('#poly-auto-dot').className = pm.enabled ? 'dot on' : 'dot off';

    // Logs window rendering
    if (Array.isArray(data.log)) {
      const logsHtml = data.log.map((log) => {
        const timeStr = new Date(log.at).toLocaleTimeString('en-GB');
        return `<div class="log-line ${log.level}">[${timeStr}] ${log.msg}</div>`;
      }).join('');
      $('#autotrade-logs').innerHTML = logsHtml || '<div class="hint">No bot activities logged yet.</div>';
    }
  } catch (err) {
    console.error('Error loading autotrader status:', err.message);
  }
}

$('#btn-save-crypto-auto').addEventListener('click', async () => {
  const enabled = $('#crypto-auto-enabled').checked;
  const mode = $('#crypto-auto-mode').value;
  const minConfidence = $('#crypto-auto-confidence').value;
  const usdtPerTrade = $('#crypto-auto-size').value;
  const intervalMin = $('#crypto-auto-interval').value;
  const maxPositions = $('#crypto-auto-max').value;

  try {
    await fetch('/api/autotrade/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        market: 'crypto',
        config: { enabled, mode, minConfidence, usdtPerTrade, intervalMin, maxPositions }
      }),
    });
    loadAutotradeStatus();
  } catch (err) {
    alert(`Save crypto bot config failed: ${err.message}`);
  }
});

$('#btn-save-poly-auto').addEventListener('click', async () => {
  const enabled = $('#poly-auto-enabled').checked;
  const mode = $('#poly-auto-mode').value;
  const minEdge = $('#poly-auto-edge').value / 100.0;
  const usdcPerTrade = $('#poly-auto-size').value;
  const intervalMin = $('#poly-auto-interval').value;
  const maxPositions = $('#poly-auto-max').value;

  try {
    await fetch('/api/autotrade/configure', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        market: 'polymarket',
        config: { enabled, mode, minEdge, usdcPerTrade, intervalMin, maxPositions }
      }),
    });
    loadAutotradeStatus();
  } catch (err) {
    alert(`Save poly bot config failed: ${err.message}`);
  }
});

/* ---------------- boot ---------------- */
initChart();
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

// Fast polling for manual paper positions updates
setInterval(loadPortfolio, 5000);
// Medium polling for autotrader status and terminal logs
setInterval(loadAutotradeStatus, 10000);
