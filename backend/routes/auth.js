const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { loadModelConfig, saveModelConfig } = require('../config/store');
const { asyncHandler, createRateLimiter, HttpError } = require('../lib/middleware');

const pendingSignups = new Map();

// Basic abuse protection: email sending and password guessing.
// Per-identifier limits do the real work (they stay accurate behind a reverse
// proxy, where every client appears to share the proxy's IP). The looser
// per-IP ceilings only exist to bound spraying across many identifiers.
const identifierKey = (req) => `${req.ip}|${String(req.body && req.body.identifier || '').slice(0, 120)}`;
const sendCodeIpLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Too many verification codes requested. Try again in a few minutes.'
});
const sendCodeLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: 'Too many verification codes requested. Try again in a few minutes.',
  keyFn: identifierKey
});
const verifyCodeLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: 'Too many code attempts. Try again in a few minutes.',
  keyFn: identifierKey
});
const loginLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Try again in a few minutes.',
  keyFn: identifierKey
});
const loginIpLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 60,
  message: 'Too many login attempts. Try again in a few minutes.'
});

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(toEmail, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new HttpError(503, 'Email verification is not configured on this server (RESEND_API_KEY).');
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
    throw new HttpError(502, 'Could not send the verification email.');
  }
}

router.post('/send-code', sendCodeIpLimiter, sendCodeLimiter, asyncHandler(async (req, res) => {
  const { identifier, password, username } = req.body;
  if (typeof identifier !== 'string' || typeof password !== 'string' || typeof username !== 'string') {
    return res.status(400).json({ error: 'identifier, username, and password are required' });
  }
  if (!identifier || !password || !username) return res.status(400).json({ error: 'identifier, username, and password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
    return res.status(400).json({ error: 'Only email sign-up is supported right now — enter a valid email.' });
  }
  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 2 || cleanUsername.length > 24) {
    return res.status(400).json({ error: 'Username should be 2-24 characters.' });
  }
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
}));

router.post('/verify-code', verifyCodeLimiter, asyncHandler(async (req, res) => {
  const { identifier, code } = req.body;
  if (typeof identifier !== 'string') return res.status(400).json({ error: 'identifier is required' });
  const pending = pendingSignups.get(identifier);
  if (!pending) return res.status(400).json({ error: 'No signup in progress for this email — start again.' });
  if (Date.now() > pending.expiresAt) {
    pendingSignups.delete(identifier);
    return res.status(400).json({ error: 'Code expired — start signup again.' });
  }
  if (String(code ?? '').trim() !== pending.code) {
    return res.status(400).json({ error: 'Wrong code.' });
  }
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
}));

router.post('/login', loginIpLimiter, loginLimiter, asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  if (typeof identifier !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'identifier and password required' });
  }
  if (!identifier || !password) return res.status(400).json({ error: 'identifier and password required' });
  const config = await loadModelConfig();
  const users = config.users || [];
  const user = users.find(u => u.identifier === identifier);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax' }).json({ ok: true, username: user.username || user.identifier });
}));

router.post('/logout', (req, res) => {
  res.clearCookie('session').json({ ok: true });
});

router.get('/me', asyncHandler(async (req, res) => {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'not logged in' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'session expired' });
  }
  const config = await loadModelConfig();
  const users = config.users || [];
  const user = users.find(u => u.id === payload.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  res.json({ identifier: user.identifier, username: user.username || user.identifier, plan: user.plan || 'free' });
}));

router.post('/delete-account', asyncHandler(async (req, res) => {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'not logged in' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'session expired' });
  }
  const config = await loadModelConfig();
  config.users = (config.users || []).filter(u => u.id !== payload.userId);
  await saveModelConfig(config);
  res.clearCookie('session').json({ ok: true });
}));

router.post('/oauth/:provider', (req, res) => {
  res.status(501).json({ error: `${req.params.provider} OAuth not wired up yet.` });
});

module.exports = router;
