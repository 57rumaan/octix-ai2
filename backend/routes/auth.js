const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { loadModelConfig, saveModelConfig } = require('../config/store');

const pendingSignups = new Map();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(toEmail, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set on the server.');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'AETHER AI <onboarding@resend.dev>',
      to: [toEmail],
      subject: 'Your AETHER AI verification code',
      html: `<p>Your verification code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>This code expires in 10 minutes.</p>`
    })
  });
  if (!r.ok) {
    const text = await r.text();
    console.error('Resend send failed:', r.status, text.slice(0, 300));
    throw new Error('Could not send the verification email.');
  }
}

router.post('/send-code', async (req, res) => {
  const { identifier, password, username } = req.body;
  if (!identifier || !password || !username) return res.status(400).json({ error: 'identifier, username, and password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    return res.status(400).json({ error: 'Only email sign-up is supported right now — enter a valid email.' });
  }
  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 2 || cleanUsername.length > 24) {
    return res.status(400).json({ error: 'Username should be 2-24 characters.' });
  }
  try {
    const config = await loadModelConfig();
    const users = config.users || [];
    if (users.find(u => u.identifier === identifier)) {
      return res.status(409).json({ error: 'account already exists' });
    }
    if (users.find(u => (u.username || '').toLowerCase() === cleanUsername.toLowerCase())) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const code = generateCode();
    pendingSignups.set(identifier, { passwordHash, code, username: cleanUsername, expiresAt: Date.now() + 10 * 60 * 1000 });
    await sendVerificationEmail(identifier, code);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not send verification code.' });
  }
});

router.post('/verify-code', async (req, res) => {
  const { identifier, code } = req.body;
  const pending = pendingSignups.get(identifier);
  if (!pending) return res.status(400).json({ error: 'No signup in progress for this email — start again.' });
  if (Date.now() > pending.expiresAt) {
    pendingSignups.delete(identifier);
    return res.status(400).json({ error: 'Code expired — start signup again.' });
  }
  if (code !== pending.code) {
    return res.status(400).json({ error: 'Wrong code.' });
  }
  try {
    const config = await loadModelConfig();
    const users = config.users || [];
    if (users.find(u => u.identifier === identifier)) {
      pendingSignups.delete(identifier);
      return res.status(409).json({ error: 'account already exists' });
    }
    users.push({
      id: Date.now().toString(),
      identifier,
      username: pending.username,
      passwordHash: pending.passwordHash,
      plan: 'free',
      createdAt: new Date().toISOString()
    });
    config.users = users;
    await saveModelConfig(config);
    pendingSignups.delete(identifier);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create account — storage error.' });
  }
});

router.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.status(400).json({ error: 'identifier and password required' });
  try {
    const config = await loadModelConfig();
    const users = config.users || [];
    const user = users.find(u => u.identifier === identifier);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax' }).json({ ok: true, username: user.username || user.identifier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not log in — storage error.' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('session').json({ ok: true });
});

router.get('/me', async (req, res) => {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'not logged in' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const config = await loadModelConfig();
    const users = config.users || [];
    const user = users.find(u => u.id === payload.userId);
    if (!user) return res.status(401).json({ error: 'not logged in' });
    res.json({ identifier: user.identifier, username: user.username || user.identifier, plan: user.plan || 'free' });
  } catch {
    res.status(401).json({ error: 'session expired' });
  }
});

router.post('/delete-account', async (req, res) => {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'not logged in' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const config = await loadModelConfig();
    config.users = (config.users || []).filter(u => u.id !== payload.userId);
    await saveModelConfig(config);
    res.clearCookie('session').json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete account.' });
  }
});

router.post('/oauth/:provider', (req, res) => {
  res.status(501).json({ error: `${req.params.provider} OAuth not wired up yet.` });
});

module.exports = router;
