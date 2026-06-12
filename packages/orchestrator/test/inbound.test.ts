/** Meta envelope parsing — text/image/document/status payloads + malformed PROBE. */
import { describe, expect, it } from 'vitest';
import { parseInboundWebhook } from '../src/whatsapp/inbound.js';

const envelope = (messages: unknown[]) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba1', changes: [{ field: 'messages', value: { messages } }] }],
});

describe('parseInboundWebhook', () => {
  it('parses a text message and normalizes the sender to E.164', () => {
    const [m] = parseInboundWebhook(
      envelope([
        { id: 'wamid.1', from: '9779801234567', timestamp: '1718000000', type: 'text', text: { body: 'add catering 9000' } },
      ]),
    );
    expect(m).toMatchObject({
      waMessageId: 'wamid.1',
      fromE164: '+9779801234567',
      kind: 'text',
      text: 'add catering 9000',
    });
  });

  it('parses image and document media with captions', () => {
    const msgs = parseInboundWebhook(
      envelope([
        { id: 'wamid.2', from: '977980', timestamp: '1', type: 'image', image: { id: 'media1', mime_type: 'image/jpeg', caption: 'bill' } },
        { id: 'wamid.3', from: '977980', timestamp: '2', type: 'document', document: { id: 'media2', mime_type: 'application/pdf', filename: 'inv.pdf' } },
      ]),
    );
    expect(msgs[0]).toMatchObject({ kind: 'image', media: { mediaId: 'media1', mimeType: 'image/jpeg' }, text: 'bill' });
    expect(msgs[1]).toMatchObject({ kind: 'document', media: { mediaId: 'media2', filename: 'inv.pdf' } });
  });

  it('maps audio and unknown types for the coming-soon path', () => {
    const msgs = parseInboundWebhook(
      envelope([
        { id: 'wamid.4', from: '1', timestamp: '1', type: 'audio', audio: { id: 'media3' } },
        { id: 'wamid.5', from: '1', timestamp: '1', type: 'sticker' },
      ]),
    );
    expect(msgs.map((m) => m.kind)).toEqual(['audio', 'unsupported']);
  });

  it('returns [] for status-only deliveries (no messages array)', () => {
    expect(
      parseInboundWebhook({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] }],
      }),
    ).toEqual([]);
  });

  it('PROBE: throws on a malformed envelope instead of guessing', () => {
    expect(() => parseInboundWebhook({ entry: 'nope' })).toThrow();
    expect(() => parseInboundWebhook(null)).toThrow();
  });
});
