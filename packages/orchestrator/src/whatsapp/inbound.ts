/**
 * Inbound webhook payload parsing — zod on every external input (CLAUDE.md §4).
 * Normalizes Meta's envelope into flat InboundMessage records; status updates
 * (delivered/read) and unknown change fields are ignored, never errors.
 */
import { z } from 'zod';

const mediaSchema = z.object({
  id: z.string(),
  mime_type: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
});

const messageSchema = z
  .object({
    id: z.string(),
    from: z.string(), // sender phone, digits only (no '+'), e.g. 9779801234567
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaSchema.optional(),
    document: mediaSchema.optional(),
    audio: mediaSchema.optional(),
  })
  .loose();

const webhookSchema = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          changes: z.array(
            z
              .object({
                field: z.string(),
                value: z.object({ messages: z.array(messageSchema).optional() }).loose(),
              })
              .loose(),
          ),
        })
        .loose(),
    ),
  })
  .loose();

export interface InboundMedia {
  mediaId: string;
  mimeType: string;
  filename?: string;
  caption?: string;
}

export interface InboundMessage {
  waMessageId: string;
  /** E.164 with leading '+', normalized from Meta's bare digits. */
  fromE164: string;
  timestamp: string;
  kind: 'text' | 'image' | 'document' | 'audio' | 'unsupported';
  text?: string;
  media?: InboundMedia;
}

/** Throws ZodError on a malformed envelope; returns [] for status-only payloads. */
export function parseInboundWebhook(payload: unknown): InboundMessage[] {
  const parsed = webhookSchema.parse(payload);
  if (parsed.object !== 'whatsapp_business_account') return [];

  const out: InboundMessage[] = [];
  for (const entry of parsed.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      for (const m of change.value.messages ?? []) {
        const base = {
          waMessageId: m.id,
          fromE164: m.from.startsWith('+') ? m.from : `+${m.from}`,
          timestamp: m.timestamp,
        };
        if (m.type === 'text' && m.text) {
          out.push({ ...base, kind: 'text', text: m.text.body });
        } else if (m.type === 'image' && m.image) {
          out.push({
            ...base,
            kind: 'image',
            text: m.image.caption,
            media: { mediaId: m.image.id, mimeType: m.image.mime_type ?? 'image/jpeg', caption: m.image.caption },
          });
        } else if (m.type === 'document' && m.document) {
          out.push({
            ...base,
            kind: 'document',
            text: m.document.caption,
            media: {
              mediaId: m.document.id,
              mimeType: m.document.mime_type ?? 'application/pdf',
              filename: m.document.filename,
              caption: m.document.caption,
            },
          });
        } else if (m.type === 'audio' && m.audio) {
          // voice is v2.0 P12 — surfaced as "coming soon" by the router
          out.push({ ...base, kind: 'audio', media: { mediaId: m.audio.id, mimeType: m.audio.mime_type ?? 'audio/ogg' } });
        } else {
          out.push({ ...base, kind: 'unsupported' });
        }
      }
    }
  }
  return out;
}
