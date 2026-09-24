require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AETHER AI server running on http://localhost:${PORT}`));
