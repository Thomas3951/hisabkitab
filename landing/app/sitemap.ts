import type { MetadataRoute } from 'next';

export const dynamic = 'force-static'; // required with output: 'export'

const BASE = 'https://hisabkitab.pro';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const page = (path: string, priority: number) => ({
    url: `${BASE}${path}`,
    lastModified: now,
    changeFrequency: 'monthly' as const,
    priority,
  });
  return [
    { url: `${BASE}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    page('/platform/', 0.8),
    page('/vat-guide/', 0.8),
    page('/how-it-works/', 0.7),
    page('/about/', 0.6),
    page('/pilot/', 0.7),
    page('/security/', 0.6),
    page('/status/', 0.4),
    page('/careers/', 0.4),
    page('/press/', 0.4),
    page('/privacy/', 0.3),
    page('/terms/', 0.3),
    page('/data-deletion/', 0.3),
    page('/pay/', 0.5),
  ];
}
