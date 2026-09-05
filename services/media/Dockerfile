# ExamGuard Media/SFU — Multi-stage Docker build
# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace root files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy package files
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY packages/auth/package.json packages/auth/
COPY packages/database/package.json packages/database/
COPY services/media/package.json services/media/

# Install pnpm and dependencies
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/config/ packages/config/
COPY packages/types/ packages/types/
COPY packages/auth/ packages/auth/
COPY packages/database/ packages/database/
COPY services/media/ services/media/

# Build
RUN pnpm --filter @examguard/types build
RUN pnpm --filter @examguard/config build
RUN pnpm --filter @examguard/auth build
RUN pnpm --filter @examguard/media build

# Stage 2: Production
FROM node:20-alpine AS production

# Install mediasoup dependencies and ffmpeg
RUN apk add --no-cache tini ffmpeg

WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=builder /app/node_modules/.modules.yaml ./node_modules/
COPY --from=builder /app/services/media/dist ./services/media/dist
COPY --from=builder /app/services/media/package.json ./services/media/
COPY --from=builder /app/packages/config/dist ./packages/config/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/auth/dist ./packages/auth/dist

# Create non-root user
RUN addgroup -g 1001 -S examguard && \
    adduser -S examguard -u 1001 -G examguard

# Create storage directory for recordings
RUN mkdir -p /app/storage/recordings && chown -R examguard:examguard /app

USER examguard

# SFU signaling port + media ports
EXPOSE 4010 40000-49999/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4010/status || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "services/media/dist/index.js"]
