/** Media→Files: naming, upload + resource mount wiring, oversize PROBE. */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { attachInboundMedia, mountPathFor, MAX_MEDIA_BYTES } from '../src/whatsapp/media.js';
import type { WaClient } from '../src/whatsapp/wa-client.js';

const media = { mediaId: 'm1', mimeType: 'image/jpeg' };

function fakeWa(fileSizeBytes: number): WaClient {
  return {
    fetchMediaMeta: vi.fn().mockResolvedValue({ url: 'https://cdn/x', mimeType: 'image/jpeg', fileSizeBytes }),
    downloadMedia: vi.fn().mockResolvedValue(Buffer.from('jpegbytes')),
  } as unknown as WaClient;
}

function fakeAnthropic() {
  const add = vi.fn().mockResolvedValue({});
  const upload = vi.fn().mockResolvedValue({ id: 'file_123' });
  const client = {
    beta: { files: { upload }, sessions: { resources: { add } } },
  } as unknown as Anthropic;
  return { client, add, upload };
}

describe('mountPathFor', () => {
  it('stamps and sanitizes into /workspace/inbox', () => {
    const p = mountPathFor(
      { mediaId: 'x', mimeType: 'application/pdf', filename: 'my bill (1).pdf' },
      new Date('2026-06-12T10:30:00Z'),
    );
    expect(p).toBe('/workspace/inbox/20260612T103000-my_bill__1_.pdf');
  });

  it('falls back to bill.<ext> when unnamed', () => {
    expect(mountPathFor(media, new Date('2026-06-12T10:30:00Z'))).toBe(
      '/workspace/inbox/20260612T103000-bill.jpg',
    );
  });
});

describe('attachInboundMedia', () => {
  it('downloads, uploads and mounts; returns the container path', async () => {
    const { client, add, upload } = fakeAnthropic();
    const path = await attachInboundMedia(client, fakeWa(1000), 'sesn_1', media);
    expect(path).toMatch(/^\/workspace\/inbox\/\d{8}T\d{6}-bill\.jpg$/);
    expect(upload).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith('sesn_1', {
      type: 'file',
      file_id: 'file_123',
      mount_path: path,
    });
  });

  it('PROBE: refuses an oversized file before downloading', async () => {
    const { client, upload } = fakeAnthropic();
    const wa = fakeWa(MAX_MEDIA_BYTES + 1);
    await expect(attachInboundMedia(client, wa, 'sesn_1', media)).rejects.toThrow(/too large/);
    expect(wa.downloadMedia).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
});
