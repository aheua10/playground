# --- Build stage: install dev dependencies (TypeScript) and compile src/ -> dist/
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage: compiled JS + production dependencies only
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Static Docker CLI, used only when SANDBOX=docker (see docker-compose.sandbox.yml).
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
# Task workspaces, owned by the unprivileged user (a volume in docker-compose.yml).
RUN mkdir /workspaces && chown node:node /workspaces
ENV WORKSPACES_DIR=/workspaces
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/main.js"]
