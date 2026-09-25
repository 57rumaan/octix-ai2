# Production image: serves BOTH the backend and the frontend.
#
# Layout inside the container:
#   /app/backend/server.js   ← node entrypoint (serves ../frontend and ./admin)
#   /app/frontend/           ← chat UI
#
# Required at runtime: PORT, JWT_SECRET, ADMIN_PASSWORD_HASH,
# JSONBIN_BIN_ID, JSONBIN_API_KEY (see backend/.env.example).

FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app/backend

# Reproducible, production-only install (lockfile must be committed).
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Application code (backend + admin dashboard + chat frontend).
# .dockerignore keeps .env and node_modules out of the image.
COPY backend/ ./
COPY frontend/ /app/frontend/

# Non-root runtime user (node ships with the official image).
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
