// Fail fast at boot instead of failing later during requests.
// Only names of missing variables are printed — never their values.

const REQUIRED_ENV = [
  'JWT_SECRET',          // signs user + admin session tokens
  'ADMIN_PASSWORD_HASH', // bcrypt hash compared on /api/admin/login
  'JSONBIN_BIN_ID',      // config/user store (config/store.js)
  'JSONBIN_API_KEY'      // config/user store (config/store.js)
];

const OPTIONAL_ENV = ['RESEND_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'HUGGINGFACE_API_KEY'];

function validateStartupEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`[startup] Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[startup] Copy backend/.env.example to backend/.env and fill in the values, then restart.');
    process.exit(1);
  }

  if (String(process.env.JWT_SECRET).length < 16) {
    console.error('[startup] JWT_SECRET is too short — use at least 16 characters.');
    process.exit(1);
  }

  const hash = String(process.env.ADMIN_PASSWORD_HASH);
  if (!/^\$2[aby]\$/.test(hash)) {
    console.error('[startup] ADMIN_PASSWORD_HASH does not look like a bcrypt hash.');
    console.error('[startup] Generate one with: node -e "console.log(require(\'bcryptjs\').hashSync(\'YOUR_PASSWORD\', 10))"');
    process.exit(1);
  }

  const absentOptional = OPTIONAL_ENV.filter((name) => !process.env[name]);
  if (absentOptional.length) {
    console.warn(`[startup] Optional variables not set (related features stay off): ${absentOptional.join(', ')}`);
  }
}

module.exports = { validateStartupEnv, REQUIRED_ENV };
