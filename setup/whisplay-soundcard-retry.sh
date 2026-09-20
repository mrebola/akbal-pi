#!/bin/bash
# Actively retries binding the WM8960 codec driver if `whisplaysound` didn't
# register on the automatic, kernel-boot-time probe attempt — see
# docs/whisplay-audio-fix.md ("Causa raíz encontrada"). The wm8960 driver's
# probe() fails with a hard I2C error (-EAGAIN), not -EPROBE_DEFER, so the
# kernel never retries it on its own; the previous version of
# whisplay-soundcard-warmup.service only waited passively for up to 30s,
# which accomplished nothing once that single automatic attempt had already
# failed. This unbinds/rebinds the I2C device instead, forcing a fresh
# probe() call, several times with pauses between attempts.
#
# Installed as the ExecStart of whisplay-soundcard-warmup.service (see
# ../docs/whisplay-audio-fix.md for install steps). No hardware reset line
# exists for this codec (checked the compiled overlay — no reset-gpios
# property), so this can only help if the earlier failure was a transient
# I2C bus glitch rather than a persistently marginal power rail; if the
# rail itself is bad the whole time (e.g. running through a noisy PiSugar
# boost converter), no amount of retrying will succeed — see the doc for
# the power-source finding that reliably does fix it.

set -u

WM8960_DEV="1-001a"
DRIVER_DIR="/sys/bus/i2c/drivers/wm8960"
MAX_ATTEMPTS=20
RETRY_DELAY_S=2

card_registered() {
  aplay -l 2>/dev/null | grep -qi whisplaysound
}

if card_registered; then
  logger -t whisplay-soundcard-warmup "whisplaysound already registered, nothing to do"
else
  logger -t whisplay-soundcard-warmup "whisplaysound not registered, retrying wm8960 bind up to ${MAX_ATTEMPTS}x"
  for i in $(seq 1 "$MAX_ATTEMPTS"); do
    echo "$WM8960_DEV" > "$DRIVER_DIR/unbind" 2>/dev/null || true
    sleep 1
    echo "$WM8960_DEV" > "$DRIVER_DIR/bind" 2>/dev/null || true
    sleep "$RETRY_DELAY_S"
    if card_registered; then
      logger -t whisplay-soundcard-warmup "whisplaysound registered after retry $i"
      break
    fi
  done
  card_registered || logger -t whisplay-soundcard-warmup "gave up after ${MAX_ATTEMPTS} retries — whisplaysound still not registered (see docs/whisplay-audio-fix.md)"
fi

card_registered || exit 0

# Same boot-defaults nudge the original warmup script did.
amixer -c whisplaysound cset name="speaker" 80 >/dev/null 2>&1 || true
amixer -c whisplaysound cset name="mic" 80 >/dev/null 2>&1 || true
aplay -l 2>/dev/null | grep -qi "whisplaysound.*wm8960" || exit 0
sleep 8
timeout 3 arecord -q -D hw:whisplaysound -f S16_LE -r 48000 -c 2 -d 1 /dev/null >/dev/null 2>&1 || true
