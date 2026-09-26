require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const { validateStartupEnv } = require('./lib/env');
const { notFoundHandler, errorHandler } = require('./lib/middleware');

// Fail clearly at boot when critical configuration is missing, instead of
// failing later on the first request. Only variable NAMES are printed.
validateStartupEnv();

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ---- Health check (no secrets, no config data) ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

// ---- Public frontend (the chat app) ----
app.use('/', express.static(path.join(__dirname, '../frontend')));

// ---- Admin dashboard is served from its OWN path, not linked from the chat UI ----
// This is the "separate URL" admin panel — reachable only if you know the path,
// and every action behind it still requires a real login (see routes/admin.js).
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---- API routes ----
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);

// ---- Anything else: JSON 404, then a single global error handler ----
app.use('/api', notFoundHandler);
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Octix AI server running on http://localhost:${PORT}`));
