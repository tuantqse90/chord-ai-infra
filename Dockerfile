# The sign-in island (React + Privy) is bundled in its own stage; the runtime image carries only the built files.
FROM oven/bun:1.3-alpine AS web
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./web
RUN mkdir -p public && bun run build:web

FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY public ./public
COPY --from=web /app/public/privy ./public/privy
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun
ENV PORT=8798 DB_PATH=/app/data/chord-agents.db
EXPOSE 8798
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8798/v1/config >/dev/null || exit 1
CMD ["bun", "src/server.ts"]
