FROM oven/bun:1.3-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R bun:bun /app/data
USER bun
ENV PORT=8799 DB_PATH=/app/data/ask2049.db
EXPOSE 8799
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8799/v1/config >/dev/null || exit 1
CMD ["bun", "src/server.ts"]
