#!/bin/bash
# Descarga Freedoom 0.13.0 (BSD-3, redistribuible) y deja freedoom1.wad en
# app/data/doom/. No se commitea: app/data/ está en .gitignore y el WAD pesa
# ~29 MB. Verifica el SHA-256 publicado por el proyecto antes de extraer.
#
# Uso: bash scripts/fetch-doom-wad.sh   (desde app/)

set -euo pipefail

FREEDOOM_VERSION="0.13.0"
ZIP_NAME="freedoom-${FREEDOOM_VERSION}.zip"
ZIP_URL="https://github.com/freedoom/freedoom/releases/download/v${FREEDOOM_VERSION}/${ZIP_NAME}"
ZIP_SHA256="3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59"
WAD_IN_ZIP="freedoom-${FREEDOOM_VERSION}/freedoom1.wad"

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${DOOM_WAD_DIR:-$APP_DIR/data/doom}"
DEST_WAD="$DEST_DIR/freedoom1.wad"

if [ -f "$DEST_WAD" ]; then
  echo "[DOOM] Ya existe: $DEST_WAD"
  exit 0
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[DOOM] Descargando $ZIP_NAME desde la release oficial..."
curl -fL --retry 3 -o "$TMP_DIR/$ZIP_NAME" "$ZIP_URL"

GOT_SHA256="$(sha256_of "$TMP_DIR/$ZIP_NAME")"
if [ "$GOT_SHA256" != "$ZIP_SHA256" ]; then
  echo "[DOOM] SHA-256 no coincide (esperado $ZIP_SHA256, recibido $GOT_SHA256). Abortando." >&2
  exit 1
fi

unzip -q -o "$TMP_DIR/$ZIP_NAME" "$WAD_IN_ZIP" -d "$TMP_DIR"
mkdir -p "$DEST_DIR"
mv "$TMP_DIR/$WAD_IN_ZIP" "$DEST_WAD"
echo "[DOOM] Listo: $DEST_WAD"
