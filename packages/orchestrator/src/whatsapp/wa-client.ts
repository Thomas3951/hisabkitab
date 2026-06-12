/**
 * WhatsApp Cloud API (Meta Graph) client. Free-form text replies ride the 24h
 * service window (every send here is inbound-triggered); proactive sends must
 * use the pre-approved Utility templates (templates.ts).
 *
 * `baseUrl` is injectable so tests/verification drive a local stub instead of
 * graph.facebook.com — the client code path stays identical.
 */
export interface WaClientOptions {
  phoneNumberId: string;
  accessToken: string;
  /** Graph API version; bump deliberately, not implicitly. */
  graphVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WaMediaMeta {
  url: string;
  mimeType: string;
  fileSizeBytes: number;
}

export class WaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WaError';
  }
}

export class WaClient {
  private readonly base: string;
  private readonly version: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: WaClientOptions) {
    this.base = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/$/, '');
    this.version = opts.graphVersion ?? 'v23.0';
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const res = await this.fetch(`${this.base}/${this.version}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.opts.accessToken}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new WaError(`graph ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
    }
    return res.json();
  }

  /** Free-form text inside the 24h service window. `to` is E.164 (with or without '+'). */
  async sendText(to: string, body: string): Promise<void> {
    await this.request(`/${this.opts.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to.replace(/^\+/, ''),
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
  }

  /** Pre-approved Utility template (the only legal proactive send). */
  async sendTemplate(to: string, templateName: string, bodyParams: string[], lang = 'en'): Promise<void> {
    await this.request(`/${this.opts.phoneNumberId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: lang },
          components: bodyParams.length
            ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
            : [],
        },
      }),
    });
  }

  /** Step 1 of media download: resolve the short-lived CDN URL. */
  async fetchMediaMeta(mediaId: string): Promise<WaMediaMeta> {
    const meta = (await this.request(`/${mediaId}`, { method: 'GET' })) as {
      url: string;
      mime_type: string;
      file_size: number;
    };
    return { url: meta.url, mimeType: meta.mime_type, fileSizeBytes: meta.file_size };
  }

  /** Step 2: download the bytes (same bearer; URL is NOT under /vXX.X). */
  async downloadMedia(meta: WaMediaMeta): Promise<Buffer> {
    const res = await this.fetch(meta.url, {
      headers: { authorization: `Bearer ${this.opts.accessToken}` },
    });
    if (!res.ok) throw new WaError(`media download → ${res.status}`, res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}
