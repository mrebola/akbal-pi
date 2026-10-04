# Respaldos de Wardrive (solo en la Pi)

Los datos de Wardrive contienen posiciones GPS, nombres de redes y handshakes.
Por eso **los respaldos viven solo en el dispositivo y nunca se suben al repo**.
Este documento describe qué se respalda, dónde está y cómo restaurarlo; no
contiene datos de las sesiones.

## Estado actual (2026-10-04)

- **Respaldo completo fuera de la Pi:** copia de `~/wardrive-sessions/` (2422
  archivos, 14 GB) más la base y el paquete esencial, en una carpeta local del
  equipo de trabajo del dueño. Verificada por nombre y tamaño de cada archivo.
  No está en el repo ni en GitHub.
- **En la Pi se borraron** las capturas crudas (`.cap`, `.pcapng`) y los
  handshakes (`.hc22000`) de `~/wardrive-sessions/`. Quedan los metadatos
  (`.json`, `.jsonl`, `.csv`, `.txt`, `.log`), la base y las carpetas de sesión.
- La base `wardrive-drive.db` todavía guarda los nombres de los archivos de
  handshake borrados; esas referencias ya no apuntan a nada en la Pi.

## Dónde está

Carpeta de respaldos en la Pi: `~/backups/`, con permisos `700` (solo el usuario
del servicio).

Respaldo esencial del 2026-10-04: `~/backups/wardrive-essentials-20261004/`

| Archivo | Qué es |
|---|---|
| `wardrive-drive.db` | Base SQLite de Wardrive (redes vistas, handshakes, sesiones y trayectorias GPS). Copia hecha con la API de respaldo de SQLite, consistente aunque el servicio esté activo. |
| `sessions-essentials.tar.gz` | Metadatos y handshakes de las sesiones de `~/wardrive-sessions/`: archivos `.hc22000`, `.json`, `.jsonl`, `.csv`, `.txt` y `.log` (310 archivos). |
| `file-list.txt` | Lista exacta de rutas dentro del `.tar.gz`. |
| `SHA256SUMS` | Sumas SHA-256 de los dos archivos principales. |

## Qué NO incluye

- Las capturas crudas de cada sesión (`ring/*.cap` y `*.pcapng`), unos 13 GB
  solo en las tres sesiones principales. No caben en el disco libre de la Pi
  (quedaban 4.7 GB). Si las necesitas, hay que copiarlas a un disco externo.
- Los archivos `.bpf` (filtros de captura, se regeneran solos).
- Los respaldos de otras bases (`gnss.db`, `aircraft-radar.db`).

## Verificar un respaldo

```bash
cd ~/backups/wardrive-essentials-20261004
sha256sum -c SHA256SUMS
tar -tzf sessions-essentials.tar.gz | wc -l   # debe dar 310
```

## Restaurar

- Base de datos: copia `wardrive-drive.db` a `~/akbal-pi/app/data/` con el
  servicio detenido.
- Sesiones: extrae el `.tar.gz` dentro de `~/wardrive-sessions/`. Las carpetas
  conservan su nombre original (`drive-AAAAMMDD-HHMMSS`).

## Cómo volver a hacer un respaldo

Con el servicio activo se puede repetir el mismo procedimiento: copia la base con
la API de respaldo de SQLite (no con `cp`) y empaqueta solo los archivos de texto
y handshakes. Antes de crear uno nuevo, revisa el espacio libre con `df -h ~`.
