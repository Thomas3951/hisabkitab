/**
 * Meta webhook security (PRD v1.0 §12.1):
 *  - GET handshake: echo hub.challenge only when hub.verify_token matches.
 *  - POST: X-Hub-Signature-256 = HMAC-SHA256(appSecret, RAW body bytes),
 *    compared timing-safe. Reject anything unsigned/mis-signed before parsing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let got: Buffer;
  try {
    got = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Returns the challenge to echo (status 200) or null (status 403). */
export function handleVerifyHandshake(
  query: Record<string, unknown>,
  verifyToken: string,
): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && typeof token === 'string' && typeof challenge === 'string') {
    const a = Buffer.from(token);
    const b = Buffer.from(verifyToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return challenge;
  }
  return null;
}
