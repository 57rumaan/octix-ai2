const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { loadModelConfig, saveModelConfig } = require('../config/store');
const { asyncHandler, createRateLimiter, HttpError } = require('../lib/middleware');
const { isSupportedProvider } = require('../lib/providers');

const adminLoginLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: 'Too many admin login attempts. Try again in a few minutes.'
});

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

// ---- Configuration validation (keeps malformed data out of JSONBin) ----
// These checks only verify types/required fields — they never rename or
// restructure providers, linkedModels, globalRules or users.

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function bad(message) {
  throw new HttpError(400, `Invalid configuration: ${message}`);
}

function validateProviders(providers) {
  if (!Array.isArray(providers)) bad('"providers" must be an array.');
  providers.forEach((provider, i) => {
    if (!isPlainObject(provider)) bad(`provider #${i + 1} must be an object.`);
    if (typeof provider.id !== 'string' || !provider.id.trim()) bad(`provider #${i + 1} needs an id.`);
    if (provider.id.length > 100) bad(`provider #${i + 1} id is too long.`);
    if (typeof provider.label !== 'string' || !provider.label.trim()) bad(`provider "${provider.id}" needs a label.`);
    if (typeof provider.apiKeyEnv !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(provider.apiKeyEnv)) {
      bad(`provider "${provider.id}" has an invalid apiKeyEnv name.`);
    }
    if (!Array.isArray(provider.models)) bad(`provider "${provider.id}" needs a models array.`);
    provider.models.forEach((model, m) => {
      if (!isPlainObject(model)) bad(`model #${m + 1} of "${provider.id}" must be an object.`);
      if (typeof model.id !== 'string' || !model.id.trim()) bad(`model #${m + 1} of "${provider.id}" needs an id.`);
      if (typeof model.customName !== 'string') bad(`model "${model.id}" needs a customName string.`);
      if (model.rules !== undefined && typeof model.rules !== 'string') bad(`model "${model.id}" rules must be a string.`);
      if (model.enabled !== undefined && typeof model.enabled !== 'boolean') bad(`model "${model.id}" enabled must be a boolean.`);
    });
  });
  return providers;
}

function validateLinkedModels(groups) {
  if (!Array.isArray(groups)) bad('"linkedModels" must be an array.');
  groups.forEach((group, i) => {
    if (!isPlainObject(group)) bad(`model #${i + 1} must be an object.`);
    if (typeof group.id !== 'string' || !group.id.trim()) bad(`model #${i + 1} needs an id.`);
    if (typeof group.name !== 'string' || !group.name.trim()) bad(`model "${group.id}" needs a name.`);
    if (group.enabled !== undefined && typeof group.enabled !== 'boolean') bad(`model "${group.name}" enabled must be a boolean.`);
    if (group.tts !== undefined && typeof group.tts !== 'boolean') bad(`model "${group.name}" tts must be a boolean.`);
    if (group.capabilities !== undefined) {
      if (!Array.isArray(group.capabilities)) bad(`model "${group.name}" capabilities must be an array.`);
      group.capabilities.forEach((cap, c) => {
        if (!isPlainObject(cap)) bad(`capability #${c + 1} of "${group.name}" must be an object.`);
        if (typeof cap.type !== 'string' || typeof cap.providerId !== 'string' || typeof cap.modelId !== 'string') {
          bad(`capability #${c + 1} of "${group.name}" must have string type, providerId and modelId.`);
        }
      });
    }
    if (group.tools !== undefined && !Array.isArray(group.tools)) bad(`model "${group.name}" tools must be an array.`);
    if (group.customActions !== undefined) {
      if (!Array.isArray(group.customActions)) bad(`model "${group.name}" customActions must be an array.`);
      group.customActions.forEach((action, a) => {
        if (!isPlainObject(action) || typeof action.label !== 'string' || typeof action.prompt !== 'string') {
          bad(`quick action #${a + 1} of "${group.name}" must have a label and a prompt string.`);
        }
      });
    }
    if (group.composerFeatures !== undefined && !isPlainObject(group.composerFeatures)) {
      bad(`model "${group.name}" composerFeatures must be an object.`);
    }
  });
  return groups;
}

// POST /api/admin/login  { password }
router.post('/login', adminLoginLimiter, asyncHandler(async (req, res) => {
  const password = req.body && req.body.password;
  const ok = typeof password === 'string' && !!password &&
    (await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH || ''));
  if (!ok) return res.status(401).json({ error: 'wrong password' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.cookie('adminSession', token, { httpOnly: true, sameSite: 'lax' }).json({ ok: true });
}));

router.use(requireAdmin);

// The admin UI never needs account data — users (and their password hashes)
// must never leave the server through this endpoint.
router.get('/models', asyncHandler(async (req, res) => {
  const config = await loadModelConfig();
  const safe = {};
  for (const key of Object.keys(config)) {
    if (key === 'users') continue;
    safe[key] = config[key];
  }
  res.json(safe);
}));

router.post('/models', asyncHandler(async (req, res) => {
  const body = req.body;
  if (!isPlainObject(body)) throw new HttpError(400, 'Invalid configuration: body must be an object.');
  if (body.providers === undefined) throw new HttpError(400, 'Invalid configuration: "providers" is required.');

  const providers = validateProviders(body.providers);
  const globalRules = body.globalRules === undefined ? undefined : body.globalRules;
  if (globalRules !== undefined && typeof globalRules !== 'string') bad('"globalRules" must be a string.');
  const linkedModels = body.linkedModels === undefined ? undefined : validateLinkedModels(body.linkedModels);

  const current = await loadModelConfig();

  // Block providers with no backend adapter, unless they already exist in the
  // stored config (so legacy entries never make saves impossible).
  const existingIds = new Set((current.providers || []).map(p => p.id));
  for (const provider of providers) {
    if (!isSupportedProvider(provider.id) && !existingIds.has(provider.id)) {
      throw new HttpError(400, `Provider "${provider.id}" has no backend adapter on this server, so it cannot be added.`);
    }
  }

  // Only the three config sections are overwritten. `users` (and anything
  // else stored) is left exactly as loaded, so an admin save can never wipe
  // accounts.
  current.providers = providers;
  if (globalRules !== undefined) current.globalRules = globalRules;
  if (linkedModels !== undefined) current.linkedModels = linkedModels;
  await saveModelConfig(current);
  res.json({ ok: true });
}));

router.get('/users', (req, res) => {
  res.json({ note: 'Connect this to your users database to show signups, login history, and per-user chat/usage stats.' });
});

router.post('/rules', asyncHandler(async (req, res) => {
  const globalRules = req.body && req.body.globalRules;
  if (globalRules !== undefined && typeof globalRules !== 'string') {
    throw new HttpError(400, 'Invalid configuration: "globalRules" must be a string.');
  }
  const config = await loadModelConfig();
  config.globalRules = globalRules || '';
  await saveModelConfig(config);
  res.json({ ok: true });
}));

module.exports = router;
