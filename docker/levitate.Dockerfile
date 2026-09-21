# Levitate with the Kannabi MCP server inside it.
#
# A stdio MCP server has to be a child process of Levitate, so the two share an
# image; there is no way to put Kannabi's MCP in a container of its own and
# still speak stdio. Node 24 satisfies Kannabi's engines (>=24 <25) and falls
# within Levitate's (>=22), so one runtime serves both.
#
# Built through docker/levitate.compose.yml, which supplies the kannabi-src and
# levitate-src build contexts.

# ---- Kannabi: compile the server, then keep only production dependencies ----
FROM node:24-bookworm-slim AS kannabi
WORKDIR /kannabi
RUN npm install --global pnpm@10.32.0
COPY --from=kannabi-src package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --from=kannabi-src tsconfig.server.json ./
COPY --from=kannabi-src server ./server
COPY --from=kannabi-src shared ./shared
# Only the server build. The web UI plays no part in the MCP surface, so this
# skips the React Router build that `pnpm build` would also run.
RUN pnpm exec tsc -p tsconfig.server.json && pnpm prune --prod

# ---- Levitate: build from source ----
FROM node:24-bookworm-slim AS levitate-build
WORKDIR /app
RUN corepack enable
COPY --from=levitate-src package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile
COPY --from=levitate-src src ./src
RUN pnpm build

# ---- Runtime ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=levitate-src package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=levitate-build /app/dist ./dist
COPY --from=levitate-src assets ./assets
COPY --from=kannabi /kannabi /opt/kannabi-mcp
USER node
EXPOSE 18788
