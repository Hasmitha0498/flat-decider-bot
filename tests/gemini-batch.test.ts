import { describe, expect, it, vi } from 'vitest';

// Fake Gemini answer for a two-listing batch: L1 borrows a quote that only exists in listing 2, and L2 is missing.
vi.mock('../src/gemini/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/gemini/client')>();
  return {
    ...actual,
    generateJson: vi.fn(async () => ({
      listings: [
        {
          listing_id: 'L1',
          is_apartment_listing: true,
          title: null, rent_total: 50000, location: 'Baner', city: null, bhk: 3, bathrooms: 2,
          lift: true, parking: null, pets_allowed: null, food_restriction: 'unknown', furnishing: 'unknown',
          balcony: null, gated_community: null, metro_nearby: null,
          evidence: { rent_total: '₹50,000', location: 'Baner', bhk: '3BHK', bathrooms: '2 bathrooms', lift: 'lift in the building' },
          custom_checks: [],
        },
      ],
    })),
  };
});

import { extractListingFacts } from '../src/gemini/extractListing';
import { suggestedRetryMs } from '../src/gemini/client';

describe('batched extraction', () => {
  it('checks each listing against its OWN text and treats missing answers as unreadable', async () => {
    const results = await extractListingFacts(
      [
        { id: 'first', text: '3BHK in Baner, ₹50,000 per month, 2 bathrooms.' },
        { id: 'second', text: 'Aundh flat with a lift in the building.' },
      ],
      [],
    );
    const first = results.get('first')!;
    if (!first.ok) throw new Error('expected first listing to be readable');
    expect(first.facts.rent_total).toBe(50000);
    expect(first.facts.lift).toBeNull(); // the quote exists only in the OTHER listing
    expect(results.get('second')).toEqual({ ok: false, reason: 'not enough listing details could be read' });
  });
});

describe('rate limits', () => {
  it("reads Gemini's suggested retry delay and caps it", () => {
    expect(suggestedRetryMs(new Error('Quota exceeded. Please retry in 17.7s.'))).toBe(18200);
    expect(suggestedRetryMs(new Error('Please retry in 120s'))).toBe(35000);
    expect(suggestedRetryMs(new Error('503 high demand'))).toBeNull();
  });
});
