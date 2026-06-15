import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Careers',
  description: 'Help build the careful bookkeeping agent Nepali businesses actually trust.',
  alternates: { canonical: 'https://hisabkitab.pro/careers' },
};

export default function CareersPage() {
  return (
    <PageShell
      eyebrow="Company"
      title="Build something Nepali businesses trust"
      lede="We're a small team in Kathmandu. We care about correctness, calm design, and getting Nepal's tax rules exactly right."
    >
      <Section title="How we work">
        <p>
          Small team, high ownership, no theater. We ship carefully because a bookkeeping product that
          gets a number wrong loses trust it can&apos;t buy back. If that constraint sounds energizing
          rather than tedious, you&apos;ll fit in.
        </p>
      </Section>

      <Section title="Open roles">
        <p>
          We don&apos;t have formal openings posted right now, but we&apos;re always glad to hear from
          engineers, accountants, and designers who know the Nepali SMB world. Especially if you&apos;ve
          done the books for a real business and felt the pain firsthand.
        </p>
        <p>
          Tell us what you&apos;d want to build:{' '}
          <a className="font-semibold text-primary underline-offset-4 hover:underline" href="mailto:careers@hisabkitab.pro">
            careers@hisabkitab.pro
          </a>
        </p>
      </Section>
    </PageShell>
  );
}
