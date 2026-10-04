import QRCode from "qrcode";

// The control URL the phone opens: the DOOM page with the token in ?t=. The
// token only travels in this URL and in the QR made from it.
export function withControlToken(url: string, token: string): string {
  const u = new URL(url);
  u.searchParams.set("t", token);
  return u.toString();
}

export type ControlQrResult =
  | { status: 200; body: { url: string; qr: string } }
  | { status: 409; body: { error: string } };

// The desktop QR for the control. Data URL, not a file: the token must not be
// written anywhere but the answer. Without a running game there is no token.
export async function controlQrFor(input: {
  token: string | null;
  baseUrl: string;
  toDataUrl?: (url: string) => Promise<string>;
}): Promise<ControlQrResult> {
  if (!input.token) return { status: 409, body: { error: "No hay juego corriendo" } };
  const url = withControlToken(input.baseUrl, input.token);
  const toDataUrl = input.toDataUrl ?? ((u: string) => QRCode.toDataURL(u, { type: "image/png", width: 240, margin: 1 }));
  return { status: 200, body: { url, qr: await toDataUrl(url) } };
}
