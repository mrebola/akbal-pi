#!/usr/bin/env python3
"""Estima la frecuencia fundamental (F0) de un WAV mono/estereo por
autocorrelación, para verificar si una voz de TTS suena masculina o femenina
sin adivinar por el nombre del modelo.

Uso: python3 estimate-f0.py archivo.wav [archivo2.wav ...]

Referencia aproximada: voz masculina ~85-180 Hz, voz femenina ~165-255 Hz
(hay solape; usar como señal, no como verdad absoluta).
"""
import sys
import wave
import numpy as np


def estimate_f0(path):
    wf = wave.open(path, "rb")
    sr = wf.getframerate()
    n = wf.getnframes()
    raw = wf.readframes(n)
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
    if wf.getnchannels() > 1:
        data = data[::wf.getnchannels()]

    frame_len = int(0.04 * sr)
    hop = frame_len // 2
    f0s = []
    for start in range(0, len(data) - frame_len, hop):
        frame = data[start:start + frame_len]
        if np.max(np.abs(frame)) < 500:  # silencio, saltar
            continue
        frame = frame - np.mean(frame)
        corr = np.correlate(frame, frame, mode="full")[len(frame) - 1:]
        min_lag = int(sr / 300)  # 300 Hz
        max_lag = int(sr / 70)   # 70 Hz
        seg = corr[min_lag:max_lag]
        if len(seg) == 0:
            continue
        peak = np.argmax(seg) + min_lag
        if corr[peak] > 0.3 * corr[0]:
            f0s.append(sr / peak)

    if not f0s:
        return None, 0
    return float(np.median(f0s)), len(f0s)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    for path in sys.argv[1:]:
        f0, n_frames = estimate_f0(path)
        if f0 is None:
            print(f"{path}: no se pudo estimar F0 (¿silencio?)")
        else:
            print(f"{path}: F0 mediana ~= {f0:.1f} Hz ({n_frames} frames sonoros)")
