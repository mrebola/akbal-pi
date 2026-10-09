#!/usr/bin/env bash
# Self-signed TLS cert for the Akbal web admin so getUserMedia (camera) works
# over https from any device on the tailnet / direct-AP, not just localhost.
# Idempotent: regenerates only if missing. cert/key live under data/tls/
# (gitignored). The browser shows a one-time "not trusted" warning per device.
set -euo pipefail
cd "$(dirname "$0")/.."   # app/
TLS_DIR="${WEB_ADMIN_TLS_DIR:-data/tls}"
mkdir -p "$TLS_DIR"
if [ -s "$TLS_DIR/cert.pem" ] && [ -s "$TLS_DIR/key.pem" ]; then
  echo "[tls] cert already present in $TLS_DIR — skipping"
  exit 0
fi
HOST="$(hostname)"
SANS="DNS:localhost,DNS:${HOST},DNS:${HOST}.local,IP:127.0.0.1"
if command -v tailscale >/dev/null 2>&1; then
  TS_DNS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName":"\([^"]*\)\.".*/\1/p' | head -1)"
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "${TS_DNS:-}" ] && SANS="$SANS,DNS:$TS_DNS"
  [ -n "${TS_IP:-}" ] && SANS="$SANS,IP:$TS_IP"
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
  -subj "/CN=${HOST}" -addext "subjectAltName=${SANS}"
chmod 600 "$TLS_DIR/key.pem"
echo "[tls] generated self-signed cert in $TLS_DIR (SANs: $SANS)"
