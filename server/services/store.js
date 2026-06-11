// Tiny JSON file persistence for trading state (positions, history, config).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DIR, 'state.json');

const DEFAULTS = {
  paper: { balance: 10000, startBalance: 10000 },
  positions: [], // open positions (paper and live)
  history: [],   // closed positions, newest first
  autotrade: {
    enabled: false,
    mode: 'paper',        // 'paper' | 'live' — live requires explicit opt-in
    intervalMin: 5,
    minConfidence: 55,
    usdtPerTrade: 100,
    maxPositions: 5,
    universe: 20,         // how many top coins to scan
    candleInterval: '1h',
  },
  polymarketPaper: { balance: 10000, startBalance: 10000 },
  polymarketPositions: [], // open Polymarket positions
  polymarketHistory: [],   // closed Polymarket positions, newest first
  polymarketAutotrade: {
    enabled: false,
    mode: 'paper',
    intervalMin: 5,
    minEdge: 0.05,
    minConfidence: 65,
    usdcPerTrade: 50,
    maxPositions: 5,
    maxExposure: 200,
  },
  log: [], // autotrader event log, newest first
};

let state = null;

function load() {
  if (state) return state;
  try {
    state = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
    state.autotrade = { ...DEFAULTS.autotrade, ...state.autotrade };
    state.paper = { ...DEFAULTS.paper, ...state.paper };
    state.polymarketAutotrade = { ...DEFAULTS.polymarketAutotrade, ...state.polymarketAutotrade };
    state.polymarketPaper = { ...DEFAULTS.polymarketPaper, ...state.polymarketPaper };
  } catch {
    state = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return state;
}

function save() {
  if (!state) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

module.exports = { load, save };
