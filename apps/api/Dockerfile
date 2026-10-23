# Контекст сборки — корень репозитория (npm workspaces): docker build -f apps/api/Dockerfile .
# Debian slim, не Alpine: Prisma требует openssl/glibc (ROADMAP S0, главный риск).
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api
COPY apps/api apps/api
RUN npm run build -w apps/api

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# prisma CLI лежит в dependencies: нужен в рантайме для migrate deploy и db seed
RUN npm ci -w apps/api --omit=dev && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
COPY apps/api/docker-entrypoint.sh apps/api/
RUN chmod +x apps/api/docker-entrypoint.sh
WORKDIR /repo/apps/api
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main"]
