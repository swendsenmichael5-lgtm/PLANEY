// Optional local static server. The game itself is fully static + P2P —
// any static host (GitHub raw mirrors, Pages, etc.) can serve public/ as-is.
const path = require('path');
const express = require('express');

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PLANEY boarding at http://localhost:${PORT}`));
