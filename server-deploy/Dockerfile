FROM oven/bun:1.2.23-alpine

WORKDIR /opt/codex-gateway

COPY package.json tsconfig.json ./
RUN bun install --production

COPY src ./src
COPY start.sh ./start.sh

RUN addgroup -S codex \
  && adduser -S codex -G codex \
  && mkdir -p /opt/codex-gateway/data \
  && chmod +x /opt/codex-gateway/start.sh \
  && chown -R codex:codex /opt/codex-gateway

USER codex

EXPOSE 4777 4778

CMD ["./start.sh"]
