// Permanent storage for provider/model settings, using JSONBin.io (free).
// This replaces the local models.json file — local files on Render don't
// survive a restart, but this does, and the admin panel can change it
// anytime without ever touching GitHub or code again.

const BIN_ID = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const BASE = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

async function loadModelConfig() {
  const res = await fetch(`${BASE}/latest`, {
    headers: { 'X-Master-Key': API_KEY }
  });
  if (!res.ok) throw new Error('Could not load config from JSONBin — check JSONBIN_BIN_ID / JSONBIN_API_KEY.');
  const data = await res.json();
  return data.record;
}

async function saveModelConfig(config) {
  const res = await fetch(BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY },
    body: JSON.stringify(config)
  });
  if (!res.ok) throw new Error('Could not save config to JSONBin — check JSONBIN_BIN_ID / JSONBIN_API_KEY.');
}

module.exports = { loadModelConfig, saveModelConfig };
