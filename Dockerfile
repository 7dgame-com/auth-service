FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --cache /tmp/.npm-cache

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    AUTH_SERVICE_HOST=0.0.0.0 \
    AUTH_SERVICE_PORT=3010

COPY package*.json ./
RUN npm ci --omit=dev --cache /tmp/.npm-cache \
    && npm cache clean --force

COPY --from=build /app/dist ./dist

EXPOSE 3010
CMD ["node", "dist/run.js"]
