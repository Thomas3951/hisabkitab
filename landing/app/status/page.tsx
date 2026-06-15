import type { Metadata } from 'next';
import { PageShell, Section } from '@/components/PageShell';

export const metadata: Metadata = {
  title: 'Status',
  description: 'Current operational status of HisabKitab services.',
  alternates: { canonical: 'https://hisabkitab.pro/status' },
};

const SERVICES = [
  { name: 'Landing site', state: 'Operational' },
  { name: 'WhatsApp agent', state: 'Pilot' },
  { name: 'Khalti payments', state: 'Coming soon' },
  { name: 'IRD VAT logic', state: 'Operational' },
];

const STATE_STYLE: Record<string, string> = {
  Operational: 'bg-green-100 text-green-700',
  Pilot: 'bg-primary/15 text-primary',
  'Coming soon': 'bg-cream text-muted',
};

export default function StatusPage() {
  return (
    <PageShell
      eyebrow="Resources"
      title="System status"
      lede="A live-by-design view of where each part of HisabKitab stands during the pilot."
    >
      <div className="mx-auto max-w-3xl">
        <div className="card divide-y divide-hairline">
          {SERVICES.map((s) => (
            <div key={s.name} className="flex items-center justify-between px-6 py-4">
              <span className="font-medium text-ink">{s.name}</span>
              <span className={`rounded-pill px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-wide ${STATE_STYLE[s.state]}`}>
                {s.state}
              </span>
            </div>
          ))}
        </div>
      </div>

      <Section>
        <p className="text-center text-sm">
          Seeing a problem we&apos;re not?{' '}
          <a className="font-semibold text-primary underline-offset-4 hover:underline" href="mailto:support@hisabkitab.pro">
            Tell us →
          </a>
        </p>
      </Section>
    </PageShell>
  );
}
