/**
 * Media → Files: WhatsApp media id → Graph CDN download → Anthropic Files API →
 * mounted into the tenant's session container. The agent is then pointed at the
 * mount path (bill-extraction skill takes it from there).
 */
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import type { WaClient } from './wa-client.js';
import type { InboundMedia } from './inbound.js';

/** Bills are photos/PDFs — refuse anything huge before downloading. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function mountPathFor(media: InboundMedia, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15); // 20260612T103000
  const safeName = media.filename?.replace(/[^\w.-]/g, '_');
  const ext = EXT[media.mimeType] ?? 'bin';
  return `/workspace/inbox/${stamp}-${safeName ?? `bill.${ext}`}`;
}

/**
 * Returns the container path the agent can read, or throws (caller apologizes
 * to the owner — never silently drops a bill).
 */
export async function attachInboundMedia(
  anthropic: Anthropic,
  wa: WaClient,
  sessionId: string,
  media: InboundMedia,
): Promise<string> {
  const meta = await wa.fetchMediaMeta(media.mediaId);
  if (meta.fileSizeBytes > MAX_MEDIA_BYTES) {
    throw new Error(`media too large: ${meta.fileSizeBytes} bytes`);
  }
  const bytes = await wa.downloadMedia(meta);

  const mountPath = mountPathFor({ ...media, mimeType: media.mimeType || meta.mimeType });
  const filename = mountPath.split('/').at(-1) as string;
  const uploaded = await anthropic.beta.files.upload({
    file: await toFile(bytes, filename, { type: media.mimeType || meta.mimeType }),
  });
  await anthropic.beta.sessions.resources.add(sessionId, {
    type: 'file',
    file_id: uploaded.id,
    mount_path: mountPath,
  });
  return mountPath;
}
