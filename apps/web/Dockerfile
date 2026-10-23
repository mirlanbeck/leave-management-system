# Контекст сборки — корень репозитория (npm workspaces): docker build -f apps/web/Dockerfile .
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web
COPY apps/web apps/web
RUN npm run build -w apps/web

FROM nginx:1.28.0-bookworm
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
