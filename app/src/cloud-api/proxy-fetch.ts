import {
  type Dispatcher,
  fetch as UndiciFetch,
  install,
  ProxyAgent,
  Socks5ProxyAgent,
} from "undici";
import dotenv from "dotenv";

dotenv.config();

function getProxyUrl(): string | undefined {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const allProxy = process.env.ALL_PROXY || process.env.all_proxy;

  return httpsProxy || httpProxy || allProxy;
}

export function createProxyDispatcher(proxyUrl: string): Dispatcher {
  let protocol: string;

  try {
    protocol = new URL(proxyUrl).protocol;
  } catch {
    throw new Error(
      "Invalid proxy URL. Expected http://, https://, socks://, or socks5://."
    );
  }

  switch (protocol) {
    case "socks:":
    case "socks5:":
      return new Socks5ProxyAgent(proxyUrl);
    case "http:":
    case "https:":
      return new ProxyAgent(proxyUrl);
    default:
      throw new Error(
        `Unsupported proxy protocol "${protocol}". Expected http://, https://, socks://, or socks5://.`
      );
  }
}

/**
 * Uses Node.js native fetch (available in Node 18+), with an undici
 * dispatcher selected for the configured proxy protocol.
 */
function createProxyFetch() {
  const proxy = getProxyUrl();

  if (proxy) {
    // OpenAI file uploads build multipart bodies with global FormData. Keep
    // fetch/FormData from the same undici implementation when a custom fetch
    // is used, otherwise the SDK rejects ASR uploads before sending them.
    install();
    const dispatcher = createProxyDispatcher(proxy);
    return async function proxyFetch(
      url: string | URL | Request,
      options: RequestInit = {}
    ): Promise<Response> {
      return fetch(url, { dispatcher, ...options } as any);
    };
  }

  // No proxy - use native fetch
  return async function proxyFetch(
    url: string | URL | Request,
    options: RequestInit = {}
  ): Promise<Response> {
    return fetch(url, options);
  };
}

export const proxyFetch = createProxyFetch();

function createUndiciProxyFetch() {
  const proxyUrl = getProxyUrl();

  let dispatcher: Dispatcher | undefined;

  if (proxyUrl) {
    dispatcher = createProxyDispatcher(proxyUrl);
    const displayUrl = new URL(proxyUrl);
    if (displayUrl.username || displayUrl.password) {
      displayUrl.username = "***";
      displayUrl.password = "***";
    }
    console.log("[undici] Using proxy:", displayUrl.toString());
  } else {
    console.log("[undici] No proxy configured");
  }

  return async function undiciProxyFetch(
    url: string,
    options: RequestInit = {}
  ) {
    // @ts-ignore
    return UndiciFetch(url, { dispatcher, ...options });
  };
}

export const undiciProxyFetch = createUndiciProxyFetch();
