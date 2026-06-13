# CryptoTracker Terminal

Terminal-style web dashboard that scans the crypto market and Polymarket
prediction markets, runs a technical-analysis signal engine, and renders
TradingView-style charts with **entry / stop-loss / take-profit** levels.

## Features

- **Market scanner** — top 100 coins by market cap (CoinGecko), with quick
  momentum BUY / SELL / WAIT badges, search, auto-refresh every 60 s.
- **Signal engine** — EMA(20/50/200) trend stack, RSI(14), MACD(12/26/9),
  Bollinger Bands, ATR(14) and swing high/low detection, combined into a
  weighted score → LONG / SHORT / NEUTRAL with confidence %.
- **Trade levels** — ATR + swing-based entry, stop-loss and three take-profit
  targets (1.5R / 2.5R / 4R), drawn as price lines on the chart.
- **Charts** — lightweight-charts candlesticks with EMA overlays, 1H / 4H / 1D
  timeframes. Klines from Binance public API with CoinGecko OHLC fallback.
- **Polymarket** — live prediction markets via the public Gamma API, with a
  crypto-related filter and trending tab. Every market shows **all outcome
  options** with implied-probability bars and 24h volume.
- **Account connections** (CONNECT button in the header):
  - **MEXC** — spot balances with USD estimates via signed API (use a
    read-only key; keys are held in server memory only, or set
    `MEXC_API_KEY` / `MEXC_API_SECRET` in `.env`).
  - **Phantom** — Solana wallet connect via the browser extension, shows
    address + SOL balance.
  - **Polymarket** — paste your Polygon wallet address to see portfolio
    value, open positions and PnL (public data API, read-only).
- **Global stats bar** — total market cap, 24h volume, BTC/ETH dominance.

### Trading hub (bottom panel)

- **Manual trading** — place orders directly from the dashboard:
  - **Crypto** — paper trading (simulated fills vs live prices) or **live MEXC
    spot** market orders. One-click *auto-fill from signal* drops the engine's
    entry / SL / TP straight into the order ticket. Open positions are tracked
    with live unrealized PnL and auto-closed when SL/TP is hit.
  - **Polymarket** — BUY YES / BUY NO buttons on every market route the
    contract into the order ticket (paper trading; live CLOB is scaffolded).
- **Quant engine** (Fincept-style, pure JS) — for each Polymarket contract a
  **Particle Filter** + **Monte Carlo** ensemble estimates the "true"
  probability, with a **credible interval**, volatility estimate and
  **Kelly-criterion edge** detection. Markets show a model-probability badge
  and a BUY YES/NO edge recommendation.
- **Auto-trader** — two independent bots (crypto + Polymarket) that run on a
  timer, scan the market, and open positions automatically when the signal
  confidence / quant edge clears your threshold. Fully configurable
  (mode, interval, min-confidence/edge, size, max positions) with a live
  runtime log. **Defaults to paper mode** — live mode is opt-in per bot.

> ⚠ **Safety:** everything defaults to **paper trading**. Live crypto orders
> require a MEXC key *with trade permission* and explicit `LIVE` selection.
> Start in paper mode and understand the bot before risking real funds.

No API keys required for market data — all sources are free public endpoints.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## API

| Endpoint | Description |
|---|---|
| `GET /api/scan` | Top-100 market scan with quick signals |
| `GET /api/global` | Global market stats |
| `GET /api/signal?binance=BTCUSDT&id=bitcoin&interval=4h` | Candles + indicators + signal with entry/TP/SL |
| `GET /api/polymarket` | Polymarket crypto + trending markets |
| `GET /api/polymarket/positions?address=0x…` | Polymarket account positions + PnL |
| `POST /api/connect/mexc` | Connect MEXC (`{key, secret}`, kept in memory) |
| `GET /api/mexc/account` | MEXC spot balances with USD estimates |
| `GET /api/portfolio` | Open positions + balances + PnL (crypto & Polymarket) |
| `POST /api/trade/open` | Open a position (`{market, …}`, paper or live) |
| `POST /api/trade/close` | Close a position (`{market, id, price}`) |
| `GET /api/autotrade/status` | Both bots' config + runtime log |
| `POST /api/autotrade/configure` | Update a bot (`{market, config}`) |

## Disclaimer

Signals are algorithmic technical analysis for educational purposes — **not
financial advice**. Always do your own research and manage risk.
