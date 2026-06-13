/**
 * Khalti ePayment (KPG-2) client — shapes verified against docs.khalti.com
 * (Web Checkout + Refund API, checked 2026-06-12):
 *   POST {origin}/api/v2/epayment/initiate/  → { pidx, payment_url, expires_at, expires_in }
 *   POST {origin}/api/v2/epayment/lookup/    → { pidx, total_amount, status, transaction_id, fee, refunded }
 *   POST {origin}/api/merchant-transaction/{transaction_id}/refund/   (full: no body; partial: { amount })
 * Auth: `Authorization: Key <secret>`. Amounts are integer PAISA (matches our ledger).
 * Sandbox origin: https://dev.khalti.com — production: https://khalti.com.
 *
 * `origin`/`fetchImpl` are injectable so tests/verification drive a local stub;
 * the client code path stays identical (same pattern as WaClient).
 */
import { z } from 'zod';

export const KHALTI_SANDBOX_ORIGIN = 'https://dev.khalti.com';
export const KHALTI_PRODUCTION_ORIGIN = 'https://khalti.com';

/** Lookup is the ONLY source of truth for payment state — never the callback. */
export const lookupStatusSchema = z.enum([
  'Completed',
  'Pending',
  'Initiated',
  'Refunded',
  'Expired',
  'User canceled',
  'Partially Refunded',
]);
export type KhaltiLookupStatus = z.infer<typeof lookupStatusSchema>;

const initiateResponseSchema = z.object({
  pidx: z.string().min(1),
  payment_url: z.string().url(),
  expires_at: z.string(),
  expires_in: z.number().optional(),
});
export type KhaltiInitiateResponse = z.infer<typeof initiateResponseSchema>;

const lookupResponseSchema = z.object({
  pidx: z.string().min(1),
  total_amount: z.number().int(),
  status: lookupStatusSchema,
  transaction_id: z.string().nullable(),
  fee: z.number().int(),
  refunded: z.boolean(),
});
export type KhaltiLookupResponse = z.infer<typeof lookupResponseSchema>;

export class KhaltiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'KhaltiError';
  }
}

export interface KhaltiClientOptions {
  secretKey: string;
  /** https://dev.khalti.com (sandbox) | https://khalti.com (production) | local stub. */
  origin?: string;
  fetchImpl?: typeof fetch;
}

export interface InitiateArgs {
  amountPaisa: bigint;
  purchaseOrderId: string;
  purchaseOrderName: string;
  returnUrl: string;
  websiteUrl: string;
  customerInfo?: { name?: string; phone?: string };
}

export class KhaltiClient {
  private readonly origin: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: KhaltiClientOptions) {
    this.origin = (opts.origin ?? KHALTI_SANDBOX_ORIGIN).replace(/\/$/, '');
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Key ${this.opts.secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      throw new KhaltiError(`khalti ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status, parsed);
    }
    return parsed;
  }

  /** Amounts cross the wire in paisa (Khalti native unit — no conversion). */
  async initiatePayment(args: InitiateArgs): Promise<KhaltiInitiateResponse> {
    const raw = await this.post('/api/v2/epayment/initiate/', {
      return_url: args.returnUrl,
      website_url: args.websiteUrl,
      amount: Number(args.amountPaisa),
      purchase_order_id: args.purchaseOrderId,
      purchase_order_name: args.purchaseOrderName,
      ...(args.customerInfo ? { customer_info: args.customerInfo } : {}),
    });
    return initiateResponseSchema.parse(raw);
  }

  /** Server-side verification by pidx — the final word on a payment's status. */
  async lookupPayment(pidx: string): Promise<KhaltiLookupResponse> {
    return lookupResponseSchema.parse(await this.post('/api/v2/epayment/lookup/', { pidx }));
  }

  /** Full refund when amountPaisa is omitted; partial otherwise. */
  async refundPayment(transactionId: string, amountPaisa?: bigint): Promise<unknown> {
    return this.post(
      `/api/merchant-transaction/${encodeURIComponent(transactionId)}/refund/`,
      amountPaisa !== undefined ? { amount: Number(amountPaisa) } : {},
    );
  }
}
