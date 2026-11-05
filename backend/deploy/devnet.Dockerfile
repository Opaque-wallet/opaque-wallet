# Opaque's privacy layer on the EIP-8141 devnet as ONE Railway service
# (opaque-eth-devnet, whose RAILWAY_DOCKERFILE_PATH points here):
# backend/ethereum/devnet-stack.ts. The wallet page is on Vercel (frontend:
# npm run deploy, /testnet/devnet).
#
# Six relays, the exit, the attester and settler (one FramePQAccount, FORS
# only), the CRE stand-in and a test credential authority in one process: one
# operator, a devnet only.
FROM node:22-alpine

RUN apk add --no-cache su-exec && addgroup -S opaque && adduser -S -G opaque opaque
WORKDIR /app

# .dockerignore keeps .env, .stack and every .key out of this COPY. Secrets
# arrive as the service's environment variables, never in a layer.
COPY . .

# One install per directory: a bare import resolves from the importing file's
# own node_modules. backend/.npmrc keeps viem 2.56.3 beside the devnet support.
RUN for d in packages/protocol-types packages/pq-wallet packages/ring-client graph backend; do \
      npm ci --omit=dev --no-audit --no-fund --prefix "$d" || exit 1; done \
 && mkdir -p backend/.stack frontend/public \
 && chown -R opaque:opaque backend/.stack frontend/public

WORKDIR /app/backend
# backend/.stack is the service's volume: the attester's signature count, the
# stand-in's intent key and credential MAC. Railway mounts it owned by root, so
# hand it to the service's user, then drop root for good.
CMD ["sh", "-c", "chown -R opaque:opaque /app/backend/.stack && exec su-exec opaque node ethereum/devnet-stack.ts"]
