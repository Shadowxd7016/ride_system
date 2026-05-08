// backend/server.js — RideFlow API Server
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app = express();

// ── Middleware ────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'frontend')));

// ── API Routes ────────────────────────────────────────────────────────
app.use('/api/auth',   require('./api/auth'));
app.use('/api/admin',  require('./api/admin'));
app.use('/api/rider',  require('./api/rider'));
app.use('/api/driver', require('./api/driver'));

// ── Health check ──────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Catch-all: serve frontend for any non-API route ───────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀  RideFlow server running on http://localhost:${PORT}`);
});