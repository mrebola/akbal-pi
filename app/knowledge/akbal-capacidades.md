# Qué puede hacer Akbal

## Radar Wi-Fi (WIFIRADAR)
Visualización 3D de redes wifi cercanas, capturando pasivamente con un
adaptador en modo monitor (AR9271). Muestra access points, dispositivos
asociados, canal, señal y seguridad. Tiene modo demo (datos sintéticos)
para cuando no hay hardware de captura conectado. No arranca al iniciar la
Pi: se enciende cuando alguien abre su pantalla o su página web, y se apaga
un minuto después de la última consulta.

## Wifi Audit
Herramienta de laboratorio para practicar auditoría wifi: captura de
handshakes, diccionario y fuerza bruta de contraseñas. Solo puede operar
sobre redes en una lista blanca (allowlist) — por default, únicamente la
red de pruebas dedicada `akbal_lab`. Esa restricción vive en el código
(wifi-audit/service.ts), no solo en este texto: aunque alguien lo pidiera,
Akbal no puede atacar una red fuera de esa lista.

## Wardrive
Captura mientras se conduce: mapa en vivo con GPS, redes vistas en el
camino, y handshakes capturados sobre la marcha. Puede usar de una a tres
radios a la vez: una ataca y las demás descubren redes en paralelo. Puede
incluir deauth oportunista (para forzar un handshake) solo cuando esa opción
está explícitamente habilitada para la sesión. Detener una sesión siempre
pide confirmación en la pantalla de la Pi.

## DOOM
DOOM original, jugable desde el celular con la página de control, cuando el
dueño tiene su archivo `Doom1.WAD` en el dispositivo. Se elige desde el menú
rápido o desde la barra de la web.

## Radar de Aviones (Aircraft Radar / ADS-B)
Tráfico aéreo cercano detectado con un receptor HackRF One, mostrando
aerolínea, ruta, altitud, velocidad y distancia de cada aeronave. Con
modo demo si no hay receptor conectado.

## GPS / GNSS
Posición en vivo y satélites visibles (GPS, GLONASS, Galileo, BeiDou),
con metadata orbital enriquecida desde CelesTrak. Funciona offline-first:
si no hay conexión, sirve desde cache local.

## Chat
Conversación por voz (botón físico) o por texto (panel web, pestaña
Chat). El chat web puede consultar el estado de las secciones anteriores
y responder con enlaces directos a cada una.

## Otras secciones del panel web
Conexión wifi y punto de acceso, bocina Bluetooth, respaldos, gestión de
dispositivos USB, selección/instalación de modelos de Ollama, jukebox de
música (OST), y ajustes generales.
