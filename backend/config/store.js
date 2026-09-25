// Permanent storage for provider/model settings, using JSONBin.io (free).
// This replaces the local models.json file — local files on Render don't
// survive a restart, but this does, and the admin panel can change it
// anytime without ever touching GitHub or code again.
//
// The record keeps exactly these top-level keys: providers, linkedModels,
// globalRules, users. Validation below only checks/normalises their TYPES in
// memory — it never renames or restructures stored data.

const BIN_ID = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const BASE = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Throws a clear (secret-free) error when the stored record is unusable, and
// fills in missing optional keys with empty defaults so downstream code can
// rely on their shape.
function validateConfig(config, { forWrite = false } = {}) {
  if (!isPlainObject(config)) {
    throw new Error('Stored configuration is not a JSON object — check the JSONBin record.');
  }
  for (const key of ['providers', 'linkedModels', 'users']) {
    if (config[key] !== undefined && !Array.isArray(config[key])) {
      throw new Error(`Stored configuration field "${key}" must be an array.`);
    }
  }
  if (config.globalRules !== undefined && typeof config.globalRules !== 'string') {
    throw new Error('Stored configuration field "globalRules" must be a string.');
  }
  if (forWrite) {
    for (const key of ['providers', 'linkedModels', 'users']) {
      if (!Array.isArray(config[key])) {
        throw new Error(`Configuration field "${key}" must be an array before saving.`);
      }
    }
    if (typeof config.globalRules !== 'string') {
      throw new Error('Configuration field "globalRules" must be a string before saving.');
    }
  }

  if (config.providers === undefined) config.providers = [];
  if (config.linkedModels === undefined) config.linkedModels = [];
  if (config.users === undefined) config.users = [];
  if (config.globalRules === undefined) config.globalRules = '';
  return config;
}

async function loadModelConfig() {
  const res = await fetch(`${BASE}/latest`, {
    headers: { 'X-Master-Key': API_KEY }
  });
  if (!res.ok) throw new Error('Could not load config from JSONBin — check JSONBIN_BIN_ID / JSONBIN_API_KEY.');
  const data = await res.json();
  return validateConfig(data.record);
}

async function saveModelConfig(config) {
  validateConfig(config, { forWrite: true });
  const res = await fetch(BASE, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': API_KEY },
    body: JSON.stringify(config)
  });
  if (!res.ok) throw new Error('Could not save config to JSONBin — check JSONBIN_BIN_ID / JSONBIN_API_KEY.');
}

module.exports = { loadModelConfig, saveModelConfig, validateConfig };
