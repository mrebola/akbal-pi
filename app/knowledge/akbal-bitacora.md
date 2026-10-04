# Bitácora de Akbal

## 2026-10-04 — Versión 1.1.2: tres radios, confirmaciones y DOOM original
Wardrive usa hasta tres radios a la vez: una ataca y las demás descubren
redes en paralelo, así que la banda se recorre más rápido. Detener una sesión
ahora siempre pide confirmación en la pantalla, para que una pulsación
accidental no corte la captura. El radar Wi-Fi ya no arranca al iniciar la
Pi: se enciende cuando alguien lo mira y se apaga solo. El menú de la pantalla
cambió de orden, con Conectar a wifi primero, y se quitó Freedoom: DOOM ahora
es solo el original, con su archivo `Doom1.WAD`.

## 2026-10-03 — El chat web aprende a operar el equipo
El chat del panel web (antes solo conversaba con el modelo, sin saber nada
del dispositivo) ganó herramientas propias: puede consultar el estado del
Radar Wi-Fi, el Radar de Aviones, GNSS, Wifi Audit y Wardrive, y responde
con enlaces directos a la sección correspondiente. Por ahora son solo de
lectura — iniciar/detener escaneos y las acciones de Wifi Audit (que
necesitan confirmación explícita) quedaron para una siguiente etapa.

También se le dio a Akbal una identidad propia editable (este mismo
archivo y sus vecinos en `app/knowledge/`, más `app/soul/akbal.md`) — antes
el system prompt era el de la plantilla original del fork, sin
personalizar.

## 2026-10-01 a 2026-10-03 — Rediseño y estabilización de Wardrive y el panel web
Varias sesiones de trabajo seguidas arreglando el flujo de Wardrive
(conducción): el mapa no se limpiaba al iniciar una sesión nueva después
de ver una anterior, el ticker de actividad se quedaba vacío, y el botón
"Ver" de una sesión fallaba sin GPS. En paralelo se rediseñó la navegación
del panel entero (dropdowns, menú de hamburguesa en móvil, panel de
estado "AKBAL OK") y se corrigieron varios desbordes en pantallas
angostas (iPhone).

## 2026-09-30 — Crack Station
Nace Crack Station como su propia sección: inventario de handshakes
capturados, progreso en vivo de ataques por diccionario (rockyou,
weakpass) y por máscara, con su propio mapa y gestión de archivos/sesiones.
