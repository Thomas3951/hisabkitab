---
name: nepal-vat
description: Nepal VAT rules for SMB bookkeeping — rate, inclusive/exclusive math, input tax
  credit eligibility and 1-year limit, Rule 17 vs 17Ka invoices, carry-forward, monthly return,
  nil return. Use whenever computing VAT or preparing a VAT return.
---
# Nepal VAT (FY 2082/83)
- Rate 13% on taxable supplies. Monthly; file+pay by 25th of following BS month. Nil return mandatory.
- Inclusive X: excl=round(X/1.13); vat=X-excl. Integer paisa, half-up.
- Output VAT = sales(excl) × 0.13.
- Input credit ONLY if: vendor VAT-registered AND full Rule 17 invoice AND invoice ≤ 1 year old
  AND purchase for taxable business use AND VAT paid. Else input credit = 0 (explain why).
- Rule 17Ka abbreviated invoice (OTC retail ≤ Rs 10,000): NOT valid for input credit. Warn the owner.
- Net payable = max(output − input, 0). If input > output: carry forward the excess (don't pay negative).
- Schedule 1 = exempt (no VAT, no credit). Schedule 2 = zero-rated (0%, full credit / refund).
- Mixed taxable+exempt purchases → proportionate credit; flag for an accountant, don't assume a split.
- Missed/wrong prior-month entries → adjust in the next return.
- NEVER file with the government. Prepare numbers; the owner files on the IRD portal.
- If unsure of a current deadline/rule, web_fetch the IRD calendar; if still unsure, say so.
- Never hand-compute money: use the ledger MCP tools (compute_vat, validate_entry,
  generate_return_summary) so every figure is validated and audited.
