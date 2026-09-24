const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { loadModelConfig, saveModelConfig } = require('../config/store');

function requireAdmin(req, res, next) {
  const token = req.cookies?.adminSession || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'not logged in' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'session expired' });
  }
}

// POST /api/admin/login  { password }
router.post('/login', async (req, res) => {
  const { password } = req.body;
  const ok = password && (await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH || ''));
  if (!ok) return res.status(401).json({ error: 'wrong password' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.cookie('adminSession', token, { httpOnly: true, sameSite: 'lax' }).json({ ok: true });
});

router.use(requireAdmin);

router.get('/models', async (req, res) => {
  try {
    res.json(await loadModelConfig());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/models', async (req, res) => {
  try {
    const current = await loadModelConfig();
    current.providers = req.body.providers;
    current.globalRules = req.body.globalRules;
    current.linkedModels = req.body.linkedModels || current.linkedModels || [];
    await saveModelConfig(current);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/users', (req, res) => {
  res.json({ note: 'Connect this to your users database to show signups, login history, and per-user chat/usage stats.' });
});

router.post('/rules', async (req, res) => {
  try {
    const config = await loadModelConfig();
    config.globalRules = req.body.globalRules || '';
    await saveModelConfig(config);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
