# syntax=docker/dockerfile:1.7
FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache nginx \
  && mkdir -p /run/nginx /usr/share/nginx/html /app/data

WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev
COPY server/ ./

WORKDIR /app
COPY index.html admin.html gallery.html webdav.html login.html preview.html block-img.html whitelist-on.html admin-imgtc.html admin-waterfall.html /usr/share/nginx/html/
COPY *.css *.js *.svg *.png *.ico /usr/share/nginx/html/
COPY docker/nginx.conf /etc/nginx/http.d/default.conf
COPY docker/entrypoint.sh /usr/local/bin/k-vault-entrypoint
RUN chmod +x /usr/local/bin/k-vault-entrypoint

ENV NODE_ENV=production \
  PORT=8787 \
  DATA_DIR=/app/data \
  DB_PATH=/app/data/k-vault.db \
  CHUNK_DIR=/app/data/chunks

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

ENTRYPOINT ["k-vault-entrypoint"]
