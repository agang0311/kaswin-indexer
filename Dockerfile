FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY indexer.mjs ./
COPY raffle-indexer.mjs ./
COPY contracts/ ./contracts/
COPY src/ ./src/
COPY artifacts/ ./artifacts/
COPY sdk/ ./sdk/

RUN mkdir -p /data && chown -R node:node /app /data

USER node

ENV KASWIN_DB=/data/events.sqlite \
    KASWIN_API_HOST=0.0.0.0 \
    KASWIN_API_PORT=8788 \
    NODE_ENV=production

EXPOSE 8788

VOLUME ["/data"]

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:8788/v1/rounds?limit=1 || exit 1

ENTRYPOINT ["node", "--max-old-space-size=192", "indexer.mjs", "run", "--db", "/data/events.sqlite", "--api-host", "0.0.0.0", "--api-port", "8788"]
CMD ["--pool"]
