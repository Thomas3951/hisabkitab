/** Pure unit tests for plan feature-gating (PRD v2.0 §1). */
import { describe, expect, it } from 'vitest';
import { planAllows, planSeats, minPlanFor } from '../src/index.js';

describe('planAllows', () => {
  it('starter has logging + reminders but NOT arap/reports', () => {
    expect(planAllows('starter', 'logging')).toBe(true);
    expect(planAllows('starter', 'vat_reminders')).toBe(true);
    expect(planAllows('starter', 'arap')).toBe(false);
    expect(planAllows('starter', 'reports')).toBe(false);
  });

  it('pro adds arap but not reports/accountant seat', () => {
    expect(planAllows('pro', 'arap')).toBe(true);
    expect(planAllows('pro', 'reports')).toBe(false);
    expect(planAllows('pro', 'accountant_seat')).toBe(false);
  });

  it('business unlocks everything', () => {
    for (const f of ['logging', 'vat_reminders', 'arap', 'reports', 'accountant_seat'] as const) {
      expect(planAllows('business', f)).toBe(true);
    }
  });

  it('PROBE: an unknown plan denies by default', () => {
    expect(planAllows('enterprise', 'logging')).toBe(false);
    expect(planAllows('', 'reports')).toBe(false);
  });
});

describe('planSeats + minPlanFor', () => {
  it('seat allowances scale with tier', () => {
    expect(planSeats('starter')).toBe(1);
    expect(planSeats('pro')).toBe(3);
    expect(planSeats('business')).toBe(10);
    expect(planSeats('nope')).toBe(0);
  });

  it('points an upgrade prompt at the cheapest unlocking plan', () => {
    expect(minPlanFor('logging')).toBe('starter');
    expect(minPlanFor('arap')).toBe('pro');
    expect(minPlanFor('reports')).toBe('business');
  });
});
