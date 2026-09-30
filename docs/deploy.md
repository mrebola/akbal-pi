# Deploy / actualizar Akbal en la Pi (git clone + `whisplay update`)

> Reemplaza al rsync manual que documentaba el README hasta ahora. Sigue
> siendo válido para un dispositivo sin acceso a GitHub — ver la sección
> ["Sin acceso a git"](#sin-acceso-a-git-alternativa-rsync) más abajo — pero
> el flujo normal es este.

## Por qué

El repo (`mrebola/akbal-pi` en GitHub) tiene esta forma:

```
akbal-pi/
├── README.md, AGENTS.md, docs/, setup/
└── app/          # esto es lo que corre en la Pi
```

`whisplay-ai-chatbot` (el proyecto de PiSugar del que este es fork) asumía
que la raíz del repo clonado ERA directamente lo que corre en el
dispositivo — de ahí que `whisplay update` (`cli/commands.sh`) hiciera
`git pull` parado en el propio directorio del proyecto. Como acá `app/` es
una subcarpeta del repo, no su raíz, ese supuesto ya no vale — `resolve_update_git_root`
(`cli/common.sh`) lo resuelve solo: si `app/` no tiene su propio `.git`,
sube un nivel y hace el `pull` ahí, donde en verdad está el repo.

## Setup inicial (una sola vez por dispositivo)

```bash
git clone https://github.com/mrebola/akbal-pi.git ~/akbal-pi
cd ~/akbal-pi/app
cp .env.template .env
nano .env                      # completar según setup/akbal.env.example
bash install_dependencies.sh
bash build.sh
bash startup.sh                 # crea chatbot.service apuntando a esta ruta
```

`startup.sh` detecta su propia ubicación (`PROJECT_DIR`, resuelto desde
`${BASH_SOURCE[0]}`) — no hace falta que el checkout se llame
`whisplay-ai-chatbot` ni que viva en una ruta fija; el `chatbot.service`
generado usa la ruta real de `~/akbal-pi/app` (`WorkingDirectory`,
`ExecStart`, y los logs en `$PROJECT_DIR/chatbot.log`).

## Actualizar a la versión más nueva

```bash
whisplay update      # git pull --ff-only (en la raíz real del repo) + deps + build
whisplay service restart
```

`whisplay version` muestra el tag/commit corriendo, para confirmar qué
quedó desplegado.

## Migrar un dispositivo que ya tenía una copia por rsync

Si el dispositivo viene de antes de este cambio (código copiado a mano,
sin `.git`, típicamente en `~/whisplay-ai-chatbot/app/`):

1. Clonar aparte, sin tocar lo que ya corre:
   `git clone https://github.com/mrebola/akbal-pi.git ~/akbal-pi`
2. Copiar el estado real del deploy viejo al clon nuevo (nunca al revés):
   `.env`, `data/`, `knowledge/` (y cualquier otro directorio de runtime
   que tengas — ver `.gitignore` de `app/` para la lista completa).
3. Build: `cd ~/akbal-pi/app && bash build.sh`.
4. Reapuntar el servicio: `bash startup.sh` (recrea `chatbot.service` con
   las rutas de `~/akbal-pi/app`) o editar a mano
   `/etc/systemd/system/chatbot.service` + `sudo systemctl daemon-reload`.
5. `sudo systemctl restart chatbot.service` y verificar
   (`systemctl status`, `curl localhost:8090`, `tail -f chatbot.log`)
   **antes** de borrar la copia vieja — movela a un backup
   (`mv ~/whisplay-ai-chatbot ~/whisplay-ai-chatbot.bak-$(date +%Y%m%d)`),
   nunca la borres directo hasta confirmar que el nuevo deploy funciona.

## Sin acceso a git (alternativa: rsync)

Si el dispositivo no tiene salida a GitHub (red aislada, proxy, etc.), se
puede seguir desplegando por rsync — sin el `git pull` de `whisplay
update`, así que cada actualización hay que repetir el rsync a mano:

```bash
rsync -az /ruta/local/akbal-pi/app/ <usuario>@<host-de-la-pi>:~/whisplay-ai-chatbot/app/
ssh <usuario>@<host-de-la-pi> "cd ~/whisplay-ai-chatbot/app && bash build.sh && sudo systemctl restart chatbot.service"
```

Sin `--delete` (no borra en el destino lo que ya no exista en el origen —
más lento para limpiar cruft, pero no arriesga borrar algo por accidente),
y excluyendo lo mismo que `.env`/`.gitignore` ya marcan como runtime-only.

## Validado en un dispositivo real

Este flujo (migración de rsync a clon + `whisplay update` + `startup.sh`
regenerando el service) se probó de punta a punta en un Whisplay HAT real
(29/09/2026): clon, copia de `.env`/`data`/`knowledge`, build,
`startup.sh`, verificación (servicio activo, 0 reinicios, `whisplay
update`/`whisplay version` corriendo bien), y recién ahí se archivó
(nunca se borró) la instalación vieja por rsync.
