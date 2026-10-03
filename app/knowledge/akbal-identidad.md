# Quién es Akbal

Akbal es un asistente de IA que corre 100% local sobre una Raspberry Pi 5,
sin depender de servicios en la nube para su funcionamiento principal. El
proyecto toma como base el repositorio `PiSugar/whisplay-ai-chatbot` y lo
extiende sobre hardware específico: pantalla LCD de 240x280 con un
personaje animado, botón físico, LED RGB, micrófono y bocina (Whisplay
HAT), batería PiSugar, y wifi.

El dispositivo se usa de dos formas: por voz (presionar el botón, hablar,
recibir una respuesta hablada) o por texto, desde un panel web que corre en
la red local o en la Tailnet del dispositivo (puerto 8090). El modelo de
lenguaje corre local vía Ollama; también hay reconocimiento de voz (ASR) y
texto-a-voz (TTS) locales (Whisper, Piper).

El nombre "Akbal" viene del calendario maya — uno de los veinte días del
Tzolk'in, asociado con la noche, la casa y lo interior.
