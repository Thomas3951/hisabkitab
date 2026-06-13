/**
 * Credential-scrub guard (PRD §14). The guard MUST catch credential-shaped
 * inbound text before it reaches the agent/logs, and MUST NOT block ordinary
 * bookkeeping talk (money amounts, invoice numbers, PAN/VAT).
 *
 * Each block has an adversarial probe (a credential the guard must catch) and a
 * "looks similar but is innocent" case that must pass through (CLAUDE.md §8).
 */
import { describe, expect, it } from 'vitest';
import { scanForCredentials, CREDENTIAL_REFUSAL } from '../src/security/credential-guard.js';

describe('catches credentials (blocked = true)', () => {
  const mustBlock: Array<[string, string]> = [
    ['PROBE: OTP with code', 'My OTP is 482913, please use it'],
    ['PROBE: bare verification code', 'verification code 8842'],
    ['PROBE: password stated', 'my password is Hunter2!'],
    ['PROBE: password colon form', 'password: shopkeeper@123'],
    ['PROBE: ATM PIN', 'my atm pin is 4821'],
    ['PROBE: IRD login', 'here is my IRD login and password'],
    ['PROBE: IRD portal username', 'IRD username is ram_traders'],
    ['PROBE: net banking', 'net banking pass is abcd1234'],
    ['PROBE: card number', 'card 4111 1111 1111 1111'],
    ['PROBE: Nepali OTP word', 'ओटिपी 992211 aayo'],
  ];
  for (const [name, text] of mustBlock) {
    it(name, () => {
      const r = scanForCredentials(text);
      expect(r.blocked, `expected BLOCK for: ${text}`).toBe(true);
      expect(r.kinds.length).toBeGreaterThan(0);
    });
  }

  it('PROBE: the redacted preview never contains the raw secret digits', () => {
    const r = scanForCredentials('My OTP is 482913');
    expect(r.blocked).toBe(true);
    expect(r.redactedPreview).not.toContain('482913');
    expect(r.redactedPreview).toMatch(/•/);
  });
});

describe('does NOT block ordinary bookkeeping talk (blocked = false)', () => {
  const mustPass: Array<[string, string]> = [
    ['a sale amount', 'aaja ko sales Rs 9,040 bhayo'],
    ['VAT figure', 'Rs 9040 ko bill VAT-inclusive ho, VAT kati?'],
    ['invoice number', 'invoice no 17 ko bill pathaye'],
    ['PAN on a bill', 'vendor PAN 301234567 ho, rule 17 bill'],
    ['a date', 'mile 2082-04-15 ma kineko'],
    ['plain greeting', 'Namaste, aaja ko hisab herna sakincha?'],
    ['a quantity', 'momo 4 plate becheko 480 ko'],
    ['empty', ''],
  ];
  for (const [name, text] of mustPass) {
    it(name, () => {
      expect(scanForCredentials(text).blocked, `should NOT block: ${text}`).toBe(false);
    });
  }
});

describe('refusal copy', () => {
  it('refuses without echoing any secret and states we never log in / never saved it', () => {
    expect(CREDENTIAL_REFUSAL).toMatch(/never/i);
    expect(CREDENTIAL_REFUSAL).toMatch(/did not save|not save/i);
    expect(CREDENTIAL_REFUSAL).not.toMatch(/\d{4,}/); // the refusal itself carries no codes
  });
});
