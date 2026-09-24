const express = require('express');
const router = express.Router();
const { loadModelConfig } = require('../config/store');

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
// modelId is always a group id now.
router.post('/', async (req, res) => {
  const { message, modelId, imageDataUrl } = req.body;
  if (!message && !imageDataUrl) return res.status(400).json({ error: 'message is required' });

  let config;
  try {
    config = await loadModelConfig();
  } catch (err) {
    console.error(err);
    return res.json({ reply: 'Could not reach the settings store. Check JSONBIN_BIN_ID / JSONBIN_API_KEY on the server.', model: 'system' });
  }

  const group = (config.linkedModels || []).find(g => g.id === modelId);
  if (!group) {
    return res.json({ reply: 'No AI model is selected yet. Create a group and add a chat model to it in the admin panel.', model: 'system' });
  }
  const chatCap = (group.capabilities || []).find(c => c.type === 'chat');
  if (!chatCap) {
    return res.json({ reply: `"${group.name}" doesn't have a chat model in it yet — add one in the admin panel.`, model: 'system' });
  }
  const providerDef = config.providers.find(p => p.id === chatCap.providerId);
  if (!providerDef) {
    return res.json({ reply: 'The chat model in this group no longer exists — check the admin panel.', model: 'system' });
  }
  const apiKey = process.env[providerDef.apiKeyEnv];
  if (!apiKey) {
    return res.json({ reply: `"${group.name}" is set up but its API key (${providerDef.apiKeyEnv}) isn't set on the server yet.`, model: 'system' });
  }
  const underlying = providerDef.models.find(m => m.id === chatCap.modelId);
  const modelRules = underlying?.rules || '';

  try {
    const reply = await callProvider(providerDef.id, apiKey, chatCap.modelId, message, imageDataUrl, modelRules, config.globalRules);
    res.json({ reply, model: group.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: 'That model failed to respond. Try again or switch models.', model: 'system' });
  }
});

// POST /api/chat/generate-image  { linkedModelId, prompt }
// Uses the group's own image-generation model if it has one; otherwise the
// frontend falls back to the free default generator.
router.post('/generate-image', async (req, res) => {
  const { linkedModelId, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const config = await loadModelConfig();
    const group = (config.linkedModels || []).find(g => g.id === linkedModelId);
    const imageCap = group && (group.capabilities || []).find(c => c.type === 'image');
    if (!imageCap) return res.json({ fallback: true });

    const providerDef = config.providers.find(p => p.id === imageCap.providerId);
    if (!providerDef) return res.json({ fallback: true });
    const apiKey = process.env[providerDef.apiKeyEnv];
    if (!apiKey) return res.json({ fallback: true });

    const url = await generateImage(providerDef.id, apiKey, imageCap.modelId, prompt);
    if (!url) return res.json({ fallback: true });
    res.json({ url });
  } catch (err) {
    console.error(err);
    res.json({ fallback: true });
  }
});

async function generateImage(providerId, apiKey, modelId, prompt) {
  if (providerId === 'openai') {
    const r = await fetch(`https://router.huggingface.co/hf-inference/models/${modelId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, prompt, n: 1, size: '1024x1024' })
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.data?.[0]?.url || null;
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
    const data = await r.json();
    return data.choices?.[0]?.message?.content || 'No reply.';
  }

  if (providerId === 'google') {
    const parts = [{ text: message || 'Describe this image.' }];
    if (imageDataUrl) {
      const match = imageDataUrl.match(/^data:(.+);base64,(.+)$/);
      if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }] })
    });
    const data = await r.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No reply.';
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
    const raw = await r.text();
    if (!r.ok) {
      console.error(`Groq returned status ${r.status}:`, raw.slice(0, 500));
      throw new Error(`Groq request failed (status ${r.status})`);
    }
    const data = JSON.parse(raw);
    return data.choices?.[0]?.message?.content || 'No reply.';
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
    const raw = await r.text();
    if (!r.ok) {
      console.error(`Hugging Face returned status ${r.status}:`, raw.slice(0, 500));
      throw new Error(`Hugging Face request failed (status ${r.status})`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.error('Hugging Face returned non-JSON:', raw.slice(0, 500));
      throw new Error('Hugging Face returned an unexpected response.');
    }
    return data.choices?.[0]?.message?.content || 'No reply.';
  }

  throw new Error(`No handler wired up for provider "${providerId}" yet.`);
}

module.exports = router;
