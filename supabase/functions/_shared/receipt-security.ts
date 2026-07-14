export type ReceiptDecision = "auto_approved" | "manual_review" | "rejected";

export const DETERMINISTIC_REJECTION_FLAGS = new Set([
  "DUPLICATE_REF",
]);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer. This avoids SharedArrayBuffer/BufferSource
  // incompatibilities across Deno and Supabase Edge Runtime versions.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Utf8Hex(value: string): Promise<string> {
  return sha256BytesHex(new TextEncoder().encode(value));
}

export function isReceiptToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * Compares ASCII strings without returning at the first mismatch. Length is
 * folded into the result so differently sized values never match.
 */
export function constantTimeAsciiEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length, 1);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index++) {
    difference |= (a[index % Math.max(a.length, 1)] || 0) ^
      (b[index % Math.max(b.length, 1)] || 0);
  }
  return difference === 0;
}

export async function receiptTokenMatches(
  rawToken: string,
  persistedLowercaseHash: string,
): Promise<boolean> {
  const actual = await sha256Utf8Hex(rawToken);
  // The database contract requires canonical lowercase hexadecimal. Do not
  // normalize an invalid persisted value into one that authorizes a request.
  const expected = String(persistedLowercaseHash || "");
  return /^[0-9a-f]{64}$/.test(expected) &&
    constantTimeAsciiEqual(actual, expected);
}

export function providerLedgerKey(
  provider: string,
  normalizedReference: string,
): string {
  return `${String(provider || "").toLowerCase()}:${
    String(normalizedReference || "")
  }`;
}

export function routeReceiptDecision(
  flags: readonly string[],
): ReceiptDecision {
  if (flags.some((flag) => DETERMINISTIC_REJECTION_FLAGS.has(flag))) {
    return "rejected";
  }
  return flags.length > 0 ? "manual_review" : "auto_approved";
}
