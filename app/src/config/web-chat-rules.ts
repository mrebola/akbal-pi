// Added to the web chat's system prompt. The small local model otherwise
// answers live-data questions from nothing: it once invented WiFi counts for
// a question about aircraft instead of calling the ADS-B tool.
export const WEB_CHAT_TOOL_RULE =
  "Si la pregunta es sobre datos en vivo (aviones, radar, redes WiFi, GNSS, wardrive, " +
  "capturas o estado del sistema), usa la herramienta que corresponda antes de responder. " +
  "Nunca inventes cifras, nombres de redes ni aviones: si la herramienta no devuelve datos, dilo.";
