// Shared route helpers: async error forwarding, HTTP errors, in-memory rate
// limiting, plus the 404 / global error middlewares mounted by server.js.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true; // safe to show the message to the client
  }
}

// Express 4 does not catch rejected promises from async handlers, and Node
// exits on unhandled rejections — so every async route is wrapped in this.
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Minimal in-memory fixed-window rate limiter (single process only).
function createRateLimiter({ windowMs, max, message = 'Too many requests. Please try again later.', keyFn }) {
  const hits = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60 * 1000));
  if (typeof sweeper.unref === 'function') sweeper.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn ? keyFn(req) : String(req.ip || 'unknown');
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: `Unknown route: ${req.method} ${req.originalUrl}` });
}

// Final middleware — must be registered after every route.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, err);
  }
  const message = status >= 500
    ? 'Something went wrong on the server. Try again in a moment.'
    : (err && err.expose ? err.message : 'Request failed.');
  res.status(status).json({ error: message });
}

module.exports = { HttpError, asyncHandler, createRateLimiter, notFoundHandler, errorHandler };
