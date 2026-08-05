#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
CHUNK_DIR="${CHUNK_DIR:-/app/data/chunks}"
RUNTIME_ENV="${DATA_DIR}/runtime.env"

mkdir -p /run/nginx "$DATA_DIR" "$CHUNK_DIR"

is_placeholder() {
  value="${1:-}"
  case "$value" in
    ""|replace_with_*|replace_me|change_me|changeme|your_secret_here|your_session_secret|placeholder)
      return 0
      ;;
  esac
  return 1
}

read_runtime_value() {
  key="$1"
  if [ ! -f "$RUNTIME_ENV" ]; then
    return 0
  fi
  grep -E "^${key}=" "$RUNTIME_ENV" | tail -n 1 | cut -d= -f2- || true
}

save_runtime_value() {
  key="$1"
  value="$2"
  tmp="${RUNTIME_ENV}.tmp"
  if [ -f "$RUNTIME_ENV" ]; then
    grep -Ev "^${key}=" "$RUNTIME_ENV" > "$tmp" || true
  else
    : > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$RUNTIME_ENV"
  chmod 600 "$RUNTIME_ENV"
}

ensure_secret() {
  key="$1"
  eval "current=\${$key:-}"
  if ! is_placeholder "$current"; then
    return 0
  fi

  persisted="$(read_runtime_value "$key")"
  if ! is_placeholder "$persisted"; then
    export "$key=$persisted"
    return 0
  fi

  generated="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")"
  export "$key=$generated"
  save_runtime_value "$key" "$generated"
  echo "[k-vault] Generated persistent ${key} in ${RUNTIME_ENV}."
}

ensure_secret CONFIG_ENCRYPTION_KEY
ensure_secret SESSION_SECRET

export DATA_DIR
export CHUNK_DIR
export DB_PATH="${DB_PATH:-${DATA_DIR}/k-vault.db}"

export PORT=8787

node /app/server/index.js &
api_pid="$!"

nginx -g 'daemon off;' &
nginx_pid="$!"

shutdown() {
  kill -TERM "$api_pid" "$nginx_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$nginx_pid" 2>/dev/null || true
}

trap 'shutdown; exit 0' INT TERM

while true; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    wait "$api_pid" || exit "$?"
    exit 1
  fi

  if ! kill -0 "$nginx_pid" 2>/dev/null; then
    wait "$nginx_pid" || exit "$?"
    exit 1
  fi

  sleep 2
done
