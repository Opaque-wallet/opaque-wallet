# The whole stack as ONE service, for a PaaS that gives one port and one TLS
# name (Railway: the service's RAILWAY_DOCKERFILE_PATH points here). docs/hosting.md.
#
# Six relays, the exit, the CRE stand-in, the egress and the credential
# authority in one process, every public route on $PORT. One box, one
# operator: the wallet's footer says so.
FROM node:22-alpine

RUN apk add --no-cache su-exec && addgroup -S opaque && adduser -S -G opaque opaque
WORKDIR /app

# .dockerignore keeps .env, .stack and every .key out of this COPY. Secrets
# arrive as the service's environment variables, never in a layer.
COPY . .

# One install per directory: a bare import resolves from the importing file's
# own node_modules, and stack.ts reaches into all of these.
RUN for d in packages/protocol-types packages/pq-wallet packages/ring-client graph backend; do \
      npm ci --omit=dev --no-audit --no-fund --prefix "$d" || exit 1; done \
 && mkdir -p backend/.stack frontend/public \
 && chown opaque:opaque backend/.stack frontend/public

WORKDIR /app/backend
# backend/.backups is opaque-mainnet's volume: the passkey backups
# (mesh/backup-store.ts). Railway mounts it owned by root, so hand it to the
# service's user, then drop root for good. A service without it skips that.
# The image's own user stays root for that reason alone (only root can take
# over a root-owned mount): node runs as `opaque`, and only a shell opened
# into the container (railway ssh) is root. Audited 2026-10-21 (overlord F-27),
# accepted: a non-root image can't write the volume Railway gives it.
CMD ["sh", "-c", "if [ -d /app/backend/.backups ]; then chown -R opaque:opaque /app/backend/.backups; fi && exec su-exec opaque node stack.ts"]
