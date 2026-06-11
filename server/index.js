const express = require('express');
const path = require('path');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', apiRoutes);

app.listen(PORT, () => {
  console.log(`CryptoTracker terminal running at http://localhost:${PORT}`);
});
