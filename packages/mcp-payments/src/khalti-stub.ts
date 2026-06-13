/**
 * Local Khalti sandbox stub — byte-faithful to the documented KPG-2 shapes so
 * the REAL KhaltiClient code path is exercised without network or a merchant
 * key. Used by tests and `verify` until the user's sandbox secret key exists
 * (then the same suite runs against https://dev.khalti.com unchanged).
 *
 * Adversarial knobs (CLAUDE.md §8 — prove the lies are caught):
 *   - completePayment(pidx) / cancelPayment(pidx): simulate the payer.
 *   - tamperLookupAmount(pidx, paisa): lookup reports a DIFFERENT amount than
 *     initiated (a forged/buggy gateway) — verify_payment must refuse to complete.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

interface StubPayment {
  pidx: string;
  amount: number;
  purchaseOrderId: string;
  status: 'Initiated' | 'Pending' | 'Completed' | 'Refunded' | 'Expired' | 'User canceled';
  transactionId: string | null;
  fee: number;
  refunded: boolean;
  tamperedAmount?: number;
}

export interface KhaltiStub {
  server: Server;
  origin: string;
  payments: Map<string, StubPayment>;
  completePayment(pidx: string): void;
  cancelPayment(pidx: string): void;
  tamperLookupAmount(pidx: string, amountPaisa: number): void;
  close(): Promise<void>;
}

const deny = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startKhaltiStub(secretKey: string, port = 0): Promise<KhaltiStub> {
  const payments = new Map<string, StubPayment>();
  // Per-stub-instance prefix so two stubs (e.g. parallel test files sharing one
  // DB) never mint the same pidx — real Khalti pidx are globally unique too.
  const instance = randomBytes(4).toString('hex');
  let seq = 0;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      // Khalti's documented auth errors, verified live against dev.khalti.com
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Key ')) {
        return deny(res, 401, { detail: 'Authentication credentials were not provided.', status_code: 401 });
      }
      if (auth.slice(4) !== secretKey) {
        return deny(res, 401, { detail: 'Invalid token.', status_code: 401 });
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const url = req.url ?? '';

      if (req.method === 'POST' && url === '/api/v2/epayment/initiate/') {
        if (typeof body['amount'] !== 'number' || body['amount'] <= 0) {
          return deny(res, 400, { amount: ['A valid integer is required.'], error_key: 'validation_error' });
        }
        if (!body['return_url']) {
          return deny(res, 400, { return_url: ['This field may not be blank.'], error_key: 'validation_error' });
        }
        if (!body['purchase_order_id']) {
          return deny(res, 400, { purchase_order_id: ['This field may not be blank.'], error_key: 'validation_error' });
        }
        const pidx = `stubPidx${instance}${(seq += 1).toString().padStart(6, '0')}`;
        payments.set(pidx, {
          pidx,
          amount: body['amount'],
          purchaseOrderId: String(body['purchase_order_id']),
          status: 'Initiated',
          transactionId: null,
          fee: 0,
          refunded: false,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            pidx,
            payment_url: `${origin}/pay/?pidx=${pidx}`,
            expires_at: new Date(Date.now() + 1_800_000).toISOString(),
            expires_in: 1800,
          }),
        );
      }

      if (req.method === 'POST' && url === '/api/v2/epayment/lookup/') {
        const p = payments.get(String(body['pidx'] ?? ''));
        if (!p) return deny(res, 400, { detail: 'Not found.', error_key: 'validation_error' });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            pidx: p.pidx,
            total_amount: p.tamperedAmount ?? p.amount,
            status: p.status,
            transaction_id: p.transactionId,
            fee: p.fee,
            refunded: p.refunded,
          }),
        );
      }

      const refundMatch = /^\/api\/merchant-transaction\/([^/]+)\/refund\/$/.exec(url);
      if (req.method === 'POST' && refundMatch) {
        const p = [...payments.values()].find((x) => x.transactionId === decodeURIComponent(refundMatch[1] ?? ''));
        if (!p || p.status !== 'Completed') {
          return deny(res, 400, { detail: 'Transaction not found or not refundable.', error_key: 'validation_error' });
        }
        p.status = 'Refunded';
        p.refunded = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ detail: 'Transaction refunded successfully.' }));
      }

      deny(res, 404, { detail: 'Not found.' });
    });
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  const origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`;

  const mustGet = (pidx: string): StubPayment => {
    const p = payments.get(pidx);
    if (!p) throw new Error(`stub: unknown pidx ${pidx}`);
    return p;
  };

  return {
    server,
    origin,
    payments,
    completePayment(pidx) {
      const p = mustGet(pidx);
      p.status = 'Completed';
      p.transactionId = `stubTxn${pidx.slice(-6)}`;
    },
    cancelPayment(pidx) {
      mustGet(pidx).status = 'User canceled';
    },
    tamperLookupAmount(pidx, amountPaisa) {
      mustGet(pidx).tamperedAmount = amountPaisa;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun) {
  const stub = await startKhaltiStub(process.env['KHALTI_SECRET_KEY'] ?? 'stub-secret', 8851);
  console.log(`khalti stub listening at ${stub.origin} (secret: KHALTI_SECRET_KEY or 'stub-secret')`);
}
