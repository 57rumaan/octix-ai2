const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { loadModelConfig } = require('../config/store');
const { asyncHandler, createRateLimiter, HttpError } = require('../lib/middleware');
const { isSupportedProvider } = require('../lib/providers');

// Input limits — body size is capped at 10mb in server.js (image data URLs),
// these cap the actual text a single request may carry.
const MAX_MESSAGE_CHARS = 10000;
const MAX_PROMPT_CHARS = 2000;
const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024;

// Chat and image generation require a logged-in user session.
function requireSession(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Please log in to use the chat.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Session expired — please log in again.' });
  }
  next();
}

// Rate limits are keyed per logged-in user (not per IP): behind a reverse
// proxy every request shares the proxy's IP, which would make an IP bucket a
// single global limit for the whole site.
const userKey = (req) => `u:${req.user && req.user.userId ? req.user.userId : 'anon'}`;
const chatLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: 'You are sending messages too quickly. Wait a moment and try again.',
  keyFn: userKey
});
const imageLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: 'Too many image generations. Try again in a few minutes.',
  keyFn: userKey
});

// GET /api/chat/models — public list for the picker dropdown.
// Only "groups" (config.linkedModels) show up here now — a group can hold
// just one model or several, so it covers both cases.
router.get('/models', async (req, res) => {
  try {
    const config = await loadModelConfig();
    const list = [];
    for (const group of (config.linkedModels || [])) {
      if (group.enabled) {
        list.push({
          id: group.id,
          customName: group.name,
          isLinked: true,
          ttsEnabled: !!group.tts,
          composerFeatures: group.composerFeatures || { files: true, photos: true, generateImage: true, generateVideo: true },
          customActions: group.customActions || []
        });
      }
    }
    res.json(list);
  } catch (err) {
    console.error(err);
    res.json([]);
  }
});

// POST /api/chat  { message, modelId, imageDataUrl? }
// modelId is always a group id now. Requires a logged-in session.
router.post('/', requireSession, chatLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { message, modelId, imageDataUrl } = body;

  if (typeof modelId !== 'string' || !modelId.trim()) {
    return res.status(400).json({ error: 'No model is selected.' });
  }
  if (message !== undefined && message !== null && typeof message !== 'string') {
    return res.status(400).json({ error: 'Message must be text.' });
  }
  if (imageDataUrl !== undefined && imageDataUrl !== null && typeof imageDataUrl !== 'string') {
    return res.status(400).json({ error: 'Image must be sent as a data URL.' });
  }
  if (!message && !imageDataUrl) return res.status(400).json({ error: 'message is required' });
  if (message && message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters).` });
  }
  if (imageDataUrl) {
    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUrl)) {
      return res.status(400).json({ error: 'Unsupported image format.' });
    }
    if (imageDataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
      return res.status(400).json({ error: 'Image is too large.' });
    }
  }

  let config;
  try {
    config = await loadModelConfig();
  } catch (err) {
    console.error(err);
    throw new HttpError(503, 'Could not reach the settings store. Server configuration problem — check JSONBIN_BIN_ID / JSONBIN_API_KEY.');
  }

  const user = (config.users || []).find(u => u.id === req.user.userId);
  if (!user) return res.status(401).json({ error: 'Your account no longer exists. Please log in again.' });

  const group = (config.linkedModels || []).find(g => g.id === modelId);
  if (!group) {
    return res.status(404).json({ error: 'That model is not available. Pick another one in the model selector.', model: 'system' });
  }
  if (!group.enabled) {
    return res.status(403).json({ error: `"${group.name}" is currently disabled. Pick another model.`, model: 'system' });
  }
  const chatCap = (group.capabilities || []).find(c => c.type === 'chat');
  if (!chatCap) {
    return res.json({ reply: `"${group.name}" doesn't have a chat model in it yet — add one in the admin panel.`, model: 'system' });
  }
  const providerDef = (config.providers || []).find(p => p.id === chatCap.providerId);
  if (!providerDef) {
    return res.json({ reply: 'The chat model in this group no longer exists — check the admin panel.', model: 'system' });
  }
  if (!isSupportedProvider(providerDef.id)) {
    return res.status(501).json({
      error: `Provider "${providerDef.id}" has no backend adapter on this server yet — pick another model.`,
      model: 'system'
    });
  }
  const apiKey = process.env[providerDef.apiKeyEnv];
  if (!apiKey) {
    return res.json({ reply: `"${group.name}" is set up but its API key (${providerDef.apiKeyEnv}) isn't set on the server yet.`, model: 'system' });
  }
  const underlying = (providerDef.models || []).find(m => m.id === chatCap.modelId);
  const modelRules = underlying?.rules || '';

  try {
    const reply = await callProvider(providerDef.id, apiKey, chatCap.modelId, message, imageDataUrl, modelRules, config.globalRules);
    res.json({ reply, model: group.name });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, model: 'system' });
    }
    console.error(err);
    res.status(502).json({ error: 'That model failed to respond. Try again or switch models.', model: 'system' });
  }
}));

// POST /api/chat/generate-image  { linkedModelId, prompt }
// Uses the group's own image-generation model if it has one; otherwise the
// frontend falls back to the free default generator.
router.post('/generate-image', requireSession, imageLimiter, asyncHandler(async (req, res) => {
  const { linkedModelId, prompt } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt is required' });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: `Prompt is too long (max ${MAX_PROMPT_CHARS} characters).` });
  }
  if (linkedModelId !== undefined && linkedModelId !== null && typeof linkedModelId !== 'string') {
    return res.status(400).json({ error: 'Invalid model id.' });
  }

  let config;
  try {
    config = await loadModelConfig();
  } catch (err) {
    console.error(err);
    return res.json({ fallback: true });
  }

  const group = (config.linkedModels || []).find(g => g.id === linkedModelId);
  if (!group || !group.enabled) return res.json({ fallback: true });
  const imageCap = (group.capabilities || []).find(c => c.type === 'image');
  if (!imageCap) return res.json({ fallback: true });

  const providerDef = (config.providers || []).find(p => p.id === imageCap.providerId);
  if (!providerDef || !isSupportedProvider(providerDef.id)) return res.json({ fallback: true });
  const apiKey = process.env[providerDef.apiKeyEnv];
  if (!apiKey) return res.json({ fallback: true });

  const url = await generateImage(providerDef.id, apiKey, imageCap.modelId, prompt);
  if (!url) return res.json({ fallback: true });
  res.json({ url });
}));

// ---- Provider helpers -------------------------------------------------

// Strips anything key-shaped and truncates before an upstream message is
// shown to a client.
function sanitizeProviderMessage(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted]')
    .replace(/(key=)[A-Za-z0-9_-]+/gi, '$1[redacted]')
    .trim()
    .slice(0, 240);
}

function extractUpstreamMessage(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const candidate = parsed && (
      (parsed.error && (parsed.error.message || parsed.error)) ||
      parsed.message ||
      (parsed.error && parsed.error.status)
    );
    return typeof candidate === 'string' ? sanitizeProviderMessage(candidate) : '';
  } catch {
    return '';
  }
}

// Turns a failed upstream HTTP response into a safe, useful client error.
function toProviderError(providerLabel, status, rawBody) {
  const detail = extractUpstreamMessage(rawBody);
  const looksLikeKeyProblem = status === 401 || status === 403 ||
    /api[_ ]key|unauthorized|permission_denied|invalid_api_key/i.test(detail);
  if (looksLikeKeyProblem) {
    return new HttpError(502, `${providerLabel} rejected the API key for this model. Update it on the server.`);
  }
  if (status === 429) {
    return new HttpError(503, `${providerLabel} is rate-limiting requests right now. Try again in a minute.`);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new HttpError(502, `${providerLabel} rejected the request${detail ? `: ${detail}` : ' for this model'}.`);
  }
  return new HttpError(502, `${providerLabel} is unavailable right now (status ${status}). Try again shortly.`);
}

async function readJsonOrThrow(response, providerLabel) {
  const raw = await response.text();
  if (!response.ok) throw toProviderError(providerLabel, response.status, raw);
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(502, `${providerLabel} returned an unexpected response. Try again shortly.`);
  }
}

async function generateImage(providerId, apiKey, modelId, prompt) {
  if (providerId === 'openai') {
    // OpenAI Images API (this branch previously posted to the Hugging Face
    // router with an OpenAI-shaped body, so it never worked).
    try {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: modelId, prompt, n: 1, size: '1024x1024' })
      });
      const raw = await r.text();
      if (!r.ok) {
        console.error('OpenAI image gen failed:', r.status, sanitizeProviderMessage(raw));
        return null;
      }
      const data = JSON.parse(raw);
      const first = data.data && data.data[0];
      if (first && first.url) return first.url;
      if (first && first.b64_json) return `data:image/png;base64,${first.b64_json}`;
      return null;
    } catch (err) {
      console.error('OpenAI image gen error:', err.message);
      return null;
    }
  }

  if (providerId === 'huggingface' || providerId === 'hugging-face') {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ inputs: prompt })
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('Hugging Face image gen failed:', r.status, text.slice(0, 300));
      return null;
    }
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      const text = await r.text();
      console.error('Hugging Face image gen returned non-image:', text.slice(0, 300));
      return null;
    }
    const buffer = await r.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return `data:${contentType};base64,${base64}`;
  }

  if (providerId === 'replicate') {
    // modelId should be in "owner/model-name" form, e.g. "black-forest-labs/flux-schnell"
    const r = await fetch(`https://api.replicate.com/v1/models/${modelId}/predictions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Prefer: 'wait'
      },
      body: JSON.stringify({ input: { prompt } })
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('Replicate image gen failed:', r.status, text.slice(0, 300));
      return null;
    }
    let data = await r.json();

    const extractOutput = (d) => {
      if (Array.isArray(d.output)) return d.output[0] || null;
      if (typeof d.output === 'string') return d.output;
      return null;
    };

    if (data.status === 'succeeded') return extractOutput(data);

    const getUrl = data.urls?.get;
    for (let i = 0; i < 10 && getUrl; i++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const pr = await fetch(getUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
      const pdata = await pr.json();
      if (pdata.status === 'succeeded') return extractOutput(pdata);
      if (pdata.status === 'failed' || pdata.status === 'canceled') {
        console.error('Replicate prediction failed:', JSON.stringify(pdata).slice(0, 300));
        return null;
      }
    }
    return null;
  }

  return null;
}

function buildUserContent(message, imageDataUrl) {
  if (!imageDataUrl) return message || '';
  return [
    { type: 'text', text: message || 'Describe this image.' },
    { type: 'image_url', image_url: { url: imageDataUrl } }
  ];
}

async function callProvider(providerId, apiKey, modelId, message, imageDataUrl, modelRules, globalRules) {
  const systemPrompt = [globalRules, modelRules].filter(Boolean).join('\n');

  if (providerId === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
          { role: 'user', content: buildUserContent(message, imageDataUrl) }
        ]
      })
    });
    const data = await readJsonOrThrow(r, 'OpenAI');
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new HttpError(502, 'OpenAI returned an empty response. Try again.');
    return content;
  }

  if (providerId === 'google') {
    const parts = [{ text: message || 'Describe this image.' }];
    if (imageDataUrl) {
      const match = imageDataUrl.match(/^data:(.+);base64,(.+)$/);
      if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
    // Gemini has no "system" role — rules go in system_instruction.
    const payload = { contents: [{ parts }] };
    if (systemPrompt) payload.system_instruction = { parts: [{ text: systemPrompt }] };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await readJsonOrThrow(r, 'Google Gemini');
    const candidate = data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts &&
      candidate.content.parts.map(p => p.text).filter(Boolean).join('');
    if (!text) throw new HttpError(502, 'Google Gemini returned an empty response. Try again.');
    return text;
  }

  if (providerId === 'groq') {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        reasoning_format: 'hidden',
        messages: [
          { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
          { role: 'user', content: buildUserContent(message, imageDataUrl) }
        ]
      })
    });
    const data = await readJsonOrThrow(r, 'Groq');
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new HttpError(502, 'Groq returned an empty response. Try again.');
    return content;
  }

  if (providerId === 'huggingface' || providerId === 'hugging-face') {
    const r = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
          { role: 'user', content: buildUserContent(message, imageDataUrl) }
        ]
      })
    });
    const data = await readJsonOrThrow(r, 'Hugging Face');
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new HttpError(502, 'Hugging Face returned an empty response. Try again.');
    return content;
  }

  throw new HttpError(501, `No handler wired up for provider "${providerId}" yet.`);
}

module.exports = router;
