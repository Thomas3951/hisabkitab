---
name: nepal-payments
description: How to collect a customer payment via Khalti and record it correctly — the consent
  gate, initiate→share link→verify-by-pidx flow, lookup-as-only-truth, amount reconciliation,
  exactly-once recording, refunds, and the eSewa/Fonepay "coming soon" stubs. Use whenever the
  owner wants to take, check, refund, or list a digital payment.
---
# Collecting payments (Khalti — live; eSewa/Fonepay coming soon)

You PREPARE and RECORD payments; the owner approves every money action. Never log into any portal.

## The consent gate (non-negotiable)
- NEVER call `initiate_payment` or `refund_payment` until the owner has sent an explicit "✅"/"yes"
  for THAT specific action in this conversation. Consent is never inferred and never carried over
  from a previous payment. The tool literally cannot run without `owner_approved: true`.
- NEVER ask for or accept a password, OTP, card number, or login. The customer pays on Khalti's own
  page via the link — you only share the link.

## Collect a payment
1. Confirm the amount (in NPR) and what it's for. Show it back. Wait for the owner's "✅".
2. Call `initiate_payment` with `amount_paisa` (integer paisa = NPR × 100), `purpose`, and
   `owner_approved: true`. You get back a `payment_url` and a `pidx`.
3. Share the `payment_url` with the customer. Tell the owner nothing is recorded yet — the sale is
   booked ONLY after the payment completes and you verify it.
4. When the owner says the customer paid (or after a while), call `verify_payment` with the `pidx`.
   - `verify_payment` does a server-side Khalti **lookup** — that lookup is the ONLY source of truth.
     Never trust a screenshot, a "status=Completed" in a URL, or the customer's word.
   - On **Completed**: a CONFIRMED gateway sale is recorded exactly once (VAT-inclusive split), and
     you may tell the owner the amount received. Re-verifying never double-records.
   - On **amount mismatch** (gateway's amount ≠ what you initiated): NOTHING is recorded, the payment
     is flagged `amount_mismatch`. Tell the owner plainly and suggest contacting Khalti — do not "fix" it.
   - On **Pending/Initiated**: not paid yet — say so, offer to check again shortly.
   - On **Canceled/Expired**: nothing was recorded; let the owner know.

## Refund
- Only a **completed** payment can be refunded, and only after the owner's explicit "✅" for the refund.
- Call `refund_payment` with the `pidx` and `owner_approved: true` (full refund in v1). The linked sale
  stays on the books — tell the owner to ask their accountant how to adjust it (credit note vs reversal).

## Other providers
- If asked for eSewa or Fonepay, call `esewa_initiate_payment` / `fonepay_initiate_payment`. They
  return a friendly "coming soon" — relay it and offer a Khalti link instead.

## Always
- Money figures you state must come from a tool result (initiate/verify/list), never hand-computed.
- `list_collected_payments` shows this business's payments (optionally by status) — use it to answer
  "did X pay?" / "show today's Khalti collections".
- When in doubt about a status, re-run `verify_payment` (lookup) rather than guessing.
