/** Keystrokes → base64 of their UTF-8 bytes (the `exec_input` format). */
export function encodeText(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** `output` data → raw bytes; xterm decodes UTF-8 itself, also across chunk boundaries. */
export function decodeBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
