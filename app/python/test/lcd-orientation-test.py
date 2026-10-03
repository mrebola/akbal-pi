#!/usr/bin/env python3
# Prueba física de orientación del LCD (no es un test automatizado).
#
# Antes de correrla, detén el servicio que dibuja en la pantalla:
#   sudo systemctl stop chatbot.service
# Luego:
#   python3 python/test/lcd-orientation-test.py <modo>
#
# Modos:
#   1 = vertical actual (240x280, MADCTL 0xC0)
#   2 = horizontal (280x240, MADCTL 0x70)
#   3 = horizontal invertida (280x240, MADCTL 0xA0)
#
# Dibuja cuatro cuadrantes: rojo arriba-izquierda, verde arriba-derecha,
# azul abajo-izquierda, blanco abajo-derecha. Mantiene 8 s y regresa el
# panel a vertical. Reinicia el servicio al terminar:
#   sudo systemctl start chatbot.service

import os
import sys
import time

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from whisplay import WhisplayBoard  # noqa: E402
from utils import ImageUtils  # noqa: E402

DIRECTION = {1: 0xC0, 2: 0x70, 3: 0xA0}
SIZE = {1: (240, 280), 2: (280, 240), 3: (280, 240)}
HOLD_SECONDS = 8


def main():
    mode = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    if mode not in DIRECTION:
        sys.exit("modo debe ser 1, 2 o 3")

    width, height = SIZE[mode]
    board = WhisplayBoard()
    try:
        board._send_command(0x36, DIRECTION[mode])

        img = Image.new("RGB", (width, height), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, 0, width // 2 - 1, height // 2 - 1], fill=(255, 0, 0))
        draw.rectangle([width // 2, 0, width - 1, height // 2 - 1], fill=(0, 255, 0))
        draw.rectangle([0, height // 2, width // 2 - 1, height - 1], fill=(0, 0, 255))
        draw.rectangle([width // 2, height // 2, width - 1, height - 1], fill=(255, 255, 255))

        pixels = bytes(ImageUtils.image_to_rgb565(img, width, height))
        board.set_window(0, 0, width - 1, height - 1, use_horizontal=mode)
        board._send_data(pixels)
        print(f"[OrientationTest] modo {mode}: {width}x{height}, mostrando {HOLD_SECONDS} s")
        time.sleep(HOLD_SECONDS)
    finally:
        board._send_command(0x36, DIRECTION[1])
        board.set_window(0, 0, 239, 279, use_horizontal=1)
        board._send_data(bytes(240 * 280 * 2))
        print("[OrientationTest] panel regresado a vertical")


if __name__ == "__main__":
    main()
