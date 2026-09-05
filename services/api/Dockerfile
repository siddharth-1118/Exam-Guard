# ExamGuard API (production-ish image; dev runs via pnpm for hot reload)
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY services/api ./services/api
RUN pnpm install --frozen-lockfile --filter @examguard/api... 

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/services/api ./services/api
WORKDIR /app/services/api
RUN npx prisma generate --schema ../../packages/database/prisma/schema.prisma \
  && pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/api/dist ./services/api/dist
WORKDIR /app/services/api
EXPOSE 4000
USER node
CMD ["node", "dist/main.js"]