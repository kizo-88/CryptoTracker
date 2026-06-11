const fs = require('fs');
const path = require('path');

// minimal .env loader (no dependency): KEY=VALUE lines, # comments
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !m[1].startsWith('#') && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const express = require('express');
const apiRoutes = require('./routes/api');
const autotrader = require('./services/autotrader');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', apiRoutes);

autotrader.init();

app.listen(PORT, () => {
  console.log(`CryptoTracker terminal running at http://localhost:${PORT}`);
});
