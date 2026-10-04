#!/bin/bash
# Descarga FluidR3_GM.sf2 (soundfont General MIDI, licencia MIT) desde el paquete
# fluid-soundfont-gm de Debian y lo deja en app/data/doom/soundfont.sf2. No se
# commitea: app/data/ está en .gitignore y el archivo pesa ~140 MB.
#
# Verificación: el SHA-256 de ESTE .deb viene del índice Packages de Debian
# (deb.debian.org/debian/dists/stable/main/binary-amd64/Packages.xz, campo
# SHA256 de fluid-soundfont-gm 3.1-5.3). Si el .deb no coincide, se aborta sin
# dejar nada. El .sf2 se extrae de ese .deb verificado.
#
# Uso: bash scripts/fetch-doom-soundfont.sh   (desde app/)

set -euo pipefail

SF_DEB_NAME="fluid-soundfont-gm_3.1-5.3_all.deb"
SF_DEB_URL="${DOOM_SOUNDFONT_DEB_URL:-https://deb.debian.org/debian/pool/main/f/fluid-soundfont/${SF_DEB_NAME}}"
SF_DEB_SHA256="6f531493ac4e4d9772fd96b2488ea1790af81c196135fbdd25997da0781fc60e"
SF2_IN_DEB="usr/share/sounds/sf2/FluidR3_GM.sf2"

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${DOOM_WAD_DIR:-$APP_DIR/data/doom}"
DEST_SF2="$DEST_DIR/soundfont.sf2"

if [ -f "$DEST_SF2" ]; then
  echo "[DOOM] Ya existe: $DEST_SF2"
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

echo "[DOOM] Descargando $SF_DEB_NAME desde Debian..."
curl -fL --retry 3 -o "$TMP_DIR/$SF_DEB_NAME" "$SF_DEB_URL"

GOT_SHA256="$(sha256_of "$TMP_DIR/$SF_DEB_NAME")"
if [ "$GOT_SHA256" != "$SF_DEB_SHA256" ]; then
  echo "[DOOM] SHA-256 no coincide (esperado $SF_DEB_SHA256, recibido $GOT_SHA256). Abortando." >&2
  exit 1
fi

# A .deb is an ar archive holding data.tar.{xz,zst,gz}; tar detects the compression.
# bsdtar reads both ar flavours (macOS ar does not read Debian's GNU names); the
# Pi has GNU ar from binutils.
mkdir -p "$TMP_DIR/ar" "$TMP_DIR/root"
if command -v bsdtar >/dev/null 2>&1; then
  bsdtar -xf "$TMP_DIR/$SF_DEB_NAME" -C "$TMP_DIR/ar"
else
  (cd "$TMP_DIR/ar" && ar x "$TMP_DIR/$SF_DEB_NAME")
fi
tar -xf "$TMP_DIR"/ar/data.tar.* -C "$TMP_DIR/root"

if [ ! -f "$TMP_DIR/root/$SF2_IN_DEB" ]; then
  echo "[DOOM] El paquete no trae $SF2_IN_DEB. Abortando." >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$TMP_DIR/root/$SF2_IN_DEB" "$DEST_SF2.partial"
mv "$DEST_SF2.partial" "$DEST_SF2"
echo "[DOOM] Listo: $DEST_SF2 (SHA-256 del .sf2: $(sha256_of "$DEST_SF2"))"
