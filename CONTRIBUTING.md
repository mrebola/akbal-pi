# Contribuir a akbal-pi

## Antes de empezar

1. Lee [`AGENTS.md`](AGENTS.md) (visión general) y
   [`app/AGENTS.md`](app/AGENTS.md) (detalle interno de la app).
2. Configura tu entorno: `cd app && npm install` y `cp .env.template .env`
   (editar con tus valores; **nunca** commitear el `.env`).

## Flujo de trabajo

```bash
cd app
npx tsc --noEmit   # verificar tipos antes de commit
npm run build      # build completo (src/ → dist/)
```

- Commits pequeños y descriptivos, en español o inglés (consistente con el
  historial).
- La validación de features de hardware (audio, display, botón) solo es
  posible en la Raspberry Pi; en el host se verifica compilación.

## ⚠️ Regla crítica: repo público, sin secretos

Este repo es público en GitHub. Prohibido commitear:

- `.env` real (solo `.env.template` / `setup/akbal.env.example`)
- IPs/MACs reales de la LAN (usar `<ip-de-la-pi>`, `aa:bb:cc:dd:ee:ff`)
- SSIDs y contraseñas de wifi
- Hostnames/usernames reales
- API keys, tokens, logs con datos personales, archivos de runtime
  (`chatbot.log`, `data/`, captures de wifiradar)

Checklist antes de cada commit:

```bash
git status              # ¿no se agrega nada de runtime?
git diff --staged | grep -inE 'key|token|secret|password|192\.168\.|10\.0\.'
```

Si un secreto se subió por accidente: rotarlo inmediatamente y avisar al owner.

## Estilo

- TypeScript: ES2020/CommonJS/strict, archivos kebab-case, imports relativos.
- Python: PEP 8, prints con prefijo (`[Server]`, `[Camera]`…).
- Comentarios que expliquen el "por qué"; strings de UI en español.

## Reportar bugs

Abrir un issue con: modelo de hardware, pasos para reproducir, y logs
**sanitizados** (sin IPs, SSIDs ni datos personales).