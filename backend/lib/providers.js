// The provider ids that callProvider()/generateImage() in routes/chat.js can
// actually talk to. Keep this list in sync with those functions — the admin
// panel (backend/admin/index.html) mirrors it to block creating providers
// that could never work.

const SUPPORTED_PROVIDERS = ['openai', 'google', 'groq', 'huggingface', 'hugging-face'];

function isSupportedProvider(providerId) {
  return SUPPORTED_PROVIDERS.includes(providerId);
}

module.exports = { SUPPORTED_PROVIDERS, isSupportedProvider };
