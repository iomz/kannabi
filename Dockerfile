FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.32.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# A deployment's plugin list names the plugins to build in. Fetching them
# needs git, which the build stage has no other use for; a build with no list
# is Kannabi core and fetches nothing.
RUN if [ -f kannabi.plugins.json ]; then \
      apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
      && rm -rf /var/lib/apt/lists/* && pnpm plugins:sync; \
    fi
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/kannabi && chown node:node /var/lib/kannabi
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/build/client ./build/client
USER node
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
