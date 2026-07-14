FROM node:22.12.0-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY raffle-indexer.mjs ./
RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV RAFFLE_INDEX_HOST=0.0.0.0 \
    RAFFLE_INDEX_PORT=8787 \
    RAFFLE_INDEX_DATA=/data
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1

CMD ["node", "raffle-indexer.mjs"]
