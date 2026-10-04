#!/bin/bash
# Descarga DoomGeneric en un commit fijo (GPL-2.0) y compila doom-engine en
# app/doom/bin/. El código del motor no se commitea: app/doom/ está ignorado.
# Uso: bash scripts/fetch-doom-engine.sh   (desde app/)
set -euo pipefail

DOOMGENERIC_REF="dcb7a8dbc7a16ce3dda29382ac9aae9d77d21284"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$APP_DIR/doom/src"
BIN_DIR="$APP_DIR/doom/bin"
BIN="$BIN_DIR/doom-engine"

if [ -x "$BIN" ]; then
  echo "[DOOM] Motor ya compilado: $BIN"
  exit 0
fi

command -v gcc >/dev/null || { echo "[DOOM] Falta gcc: sudo apt install build-essential" >&2; exit 1; }
command -v git >/dev/null || { echo "[DOOM] Falta git" >&2; exit 1; }

if [ ! -d "$SRC_DIR/.git" ]; then
  mkdir -p "$SRC_DIR"
  git clone --quiet https://github.com/ozkl/doomgeneric.git "$SRC_DIR"
fi
git -C "$SRC_DIR" checkout --quiet "$DOOMGENERIC_REF"

# Lista explícita de objetos del Makefile upstream (build sin SDL/X11), sin
# doomgeneric_*.c de plataforma: cada uno define su propio main() y DG_*.
# La capa de plataforma de Akbal Pi reemplaza a doomgeneric_xlib.c.
# Sin i_sound.c ni i_cdmus.c: su I_* duplicaría i_akbal_sound.c (que los
# reemplaza). Los backends SDL/Allegro (i_sdl*, i_allegro*) no están en la lista.
ENGINE_SRCS=(
  dummy am_map doomdef doomstat dstrings d_event d_items d_iwad d_loop
  d_main d_mode d_net f_finale f_wipe g_game hu_lib hu_stuff info
  i_endoom i_joystick i_scale i_system i_timer memio m_argv m_bbox
  m_cheat m_config m_controls m_fixed m_menu m_misc m_random p_ceilng p_doors
  p_enemy p_floor p_inter p_lights p_map p_maputl p_mobj p_plats p_pspr
  p_saveg p_setup p_sight p_spec p_switch p_telept p_tick p_user r_bsp r_data
  r_draw r_main r_plane r_segs r_sky r_things sha1 sounds statdump st_lib
  st_stuff s_sound tables v_video wi_stuff w_checksum w_file w_main w_wad
  z_zone w_file_stdc i_input i_video doomgeneric mus2mid
)
SRCS=()
for s in "${ENGINE_SRCS[@]}"; do SRCS+=("$SRC_DIR/doomgeneric/$s.c"); done

mkdir -p "$BIN_DIR"
gcc -O2 -DNORMALUNIX -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 \
  -I"$SRC_DIR/doomgeneric" "${SRCS[@]}" \
  "$APP_DIR/doom/engine/doomgeneric_akbal.c" \
  "$APP_DIR/doom/engine/i_akbal_sound.c" \
  "$APP_DIR/doom/engine/i_akbal_music.c" \
  -o "$BIN" -lm
echo "[DOOM] Listo: $BIN"
