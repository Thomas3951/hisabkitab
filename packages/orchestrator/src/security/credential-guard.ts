/**
 * Credential-scrub guard (PRD v1.0 §14 / v1.1 §14 — "refuse credentials over chat").
 *
 * WhatsApp passes through Meta and is NOT a secure channel for secrets. The agent
 * must never receive — and we must never log/persist — a password, OTP, PIN, or
 * IRD/portal login. This guard runs in the inbound path BEFORE the message reaches
 * the agent session or any audit row, so a leaked secret never lands in:
 *   - the Managed Agents session history (server-side, not ZDR-eligible), or
 *   - our audit_log / wa_events.
 *
 * Detection is intentionally conservative-to-catch (a few false positives that ask
 * the owner to resend without the secret are cheap; a logged password is not), but
 * scoped to credential-shaped content so ordinary money talk ("Rs 9,040", invoice
 * numbers, PAN on a bill) is NOT blocked.
 *
 * On a hit we return a redacted preview (for safe ops logging) and a localized
 * refusal the router relays — we do NOT echo the secret back.
 */

export type CredentialKind = 'otp' | 'password' | 'pin' | 'portal_login' | 'card';

export interface CredentialFinding {
  blocked: boolean;
  kinds: CredentialKind[];
  /** A safe-to-log preview with the secret-looking spans masked. */
  redactedPreview: string;
}

const KEYWORDS = {
  // "otp", "one time password", "verification code", "code is 123456".
  // Latin alternates are \b-anchored; devanagari (no Latin \b) is matched bare.
  otp: /\b(?:otp|one[\s-]?time[\s-]?(?:pass(?:word)?|code|pin)|verification\s*code|auth(?:entication)?\s*code|sms\s*code)\b|कोड|ओटिपी/i,
  password: /\b(?:pass(?:word|wd)?|paasword|paswd|login\s*pass)\b|पासवर्ड/i,
  pin: /\b(?:pin\s*(?:no\.?|number|code|is|:)|m[\s-]?pin|atm\s*pin)\b|पिन/i,
  // IRD / tax-portal / bank logins the agent must never touch
  portal_login: /\b(ird\s*(login|password|portal|username|user\s*id)|taxpayer\s*portal|e[\s-]?filing\s*(login|password)|internet\s*banking\s*(login|password)|net\s*banking\s*pass|portal\s*(login|password))\b/i,
} as const;

// A 4–8 digit number explicitly framed as a code/OTP/PIN (NOT a money amount).
// Devanagari keywords (ओटिपी/कोड/पिन/पासवर्ड) have no Latin \b, so they're matched
// without word boundaries; Latin keywords keep boundaries to avoid substrings.
const CODE_NEAR_KEYWORD =
  /(?:\b(?:otp|code|pin|password)\b|ओटिपी|कोड|पिन|पासवर्ड)[^0-9]{0,20}(\d{4,8})\b|\b(\d{4,8})\b[^0-9]{0,12}(?:is\s*(?:my|the)\s*)?(?:\b(?:otp|code|pin|password)\b|ओटिपी|कोड|पिन|पासवर्ड)/i;

// 13–19 digit PAN-style card number, optionally space/dash grouped (Luhn-agnostic;
// we only need "looks like a card number sent over chat").
const CARD_NUMBER = /\b(?:\d[ -]?){13,19}\b/;

/** Mask the digits in a matched span so a redacted preview never carries the secret. */
function maskDigits(s: string): string {
  return s.replace(/\d/g, '•');
}

/**
 * Inspect inbound free text. Returns `blocked: true` with the matched kinds when
 * the message looks like it carries a credential the agent must not receive.
 */
export function scanForCredentials(text: string | undefined): CredentialFinding {
  const safe = { blocked: false, kinds: [], redactedPreview: (text ?? '').slice(0, 120) };
  if (!text || !text.trim()) return safe;

  const kinds = new Set<CredentialKind>();

  // A keyword alone (e.g. "what's my IRD password?") is enough for portal_login;
  // for otp/pin/password we want either an explicit ask OR a code-shaped number,
  // to avoid blocking innocent uses ("the bill has no code").
  if (KEYWORDS.portal_login.test(text)) kinds.add('portal_login');

  if (CODE_NEAR_KEYWORD.test(text)) {
    // classify by which keyword is present
    if (KEYWORDS.otp.test(text)) kinds.add('otp');
    if (KEYWORDS.pin.test(text)) kinds.add('pin');
    if (KEYWORDS.password.test(text)) kinds.add('password');
    if (kinds.size === 0) kinds.add('otp'); // code-shaped but unlabeled → treat as OTP
  }

  // An explicit "my password is X" / "password: X" (non-numeric secret too).
  if (/\b(pass(word|wd)?|पासवर्ड)\b\s*(is|:|=|छ)\s*\S+/i.test(text)) kinds.add('password');

  // A card number sent over chat is always a credential.
  if (CARD_NUMBER.test(text) && !/(invoice|bill|pan|vat|टोल)/i.test(text)) {
    // require 13+ contiguous-ish digits; money amounts are <13 digits in paisa
    const digits = (text.match(/\d/g) ?? []).length;
    if (digits >= 13) kinds.add('card');
  }

  if (kinds.size === 0) return safe;

  // Build a redacted preview: mask any 4+ digit run and any token after "password is".
  let redacted = text.replace(/\b\d{4,}\b/g, (m) => maskDigits(m));
  redacted = redacted.replace(/(\b(?:pass(?:word|wd)?|पासवर्ड)\b\s*(?:is|:|=|छ)\s*)(\S+)/i, (_m, p1, _p2) => `${p1}••••••`);

  return { blocked: true, kinds: [...kinds], redactedPreview: redacted.slice(0, 160) };
}

/** Localized refusal the router relays when a credential is detected. Never echoes the secret. */
export const CREDENTIAL_REFUSAL =
  '🔒 For your safety, never send passwords, OTPs, PINs, card numbers, or any login ' +
  '(IRD/bank/portal) here — WhatsApp is not a secure place for secrets, and I never ' +
  'log into any portal on your behalf. I did not save that message. You file on the ' +
  'IRD portal yourself; I only prepare your numbers. How can I help with your accounts?';
