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
  crypto-related filter and trending tab (implied probabilities + 24h volume).
- **Global stats bar** — total market cap, 24h volume, BTC/ETH dominance.

No API keys required — all data sources are free public endpoints.

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

## Disclaimer

Signals are algorithmic technical analysis for educational purposes — **not
financial advice**. Always do your own research and manage risk.
