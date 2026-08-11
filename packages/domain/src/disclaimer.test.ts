import { describe, it, expect } from 'vitest';
import {
  NON_CADASTRAL_DISCLAIMER,
  NON_CADASTRAL_DISCLAIMER_SW,
} from './disclaimer.js';

/**
 * These assertions pin legally-required wording character for character.
 *
 * They are not coverage padding. The disclaimer is a compliance requirement, and the
 * realistic way it gets damaged is not deletion — it is a well-meaning tidy-up that
 * rewrites it into something shorter or friendlier. A failing test here means
 * someone has changed text that requires legal review, not a developer's judgement.
 */
describe('non-cadastral disclaimer', () => {
  it('matches the required English wording exactly', () => {
    expect(NON_CADASTRAL_DISCLAIMER).toBe(
      'Descriptive geospatial information. Not a cadastral survey. Does not ' +
        'determine or evidence any boundary, right, or interest in land.', // gt-vocab-allow: pins the compliance text
    );
  });

  it('carries a Swahili rendering, because Swahili is the default locale', () => {
    expect(NON_CADASTRAL_DISCLAIMER_SW).toBe(
      'Taarifa za kijiografia za maelezo. Si upimaji wa ardhi. Haiamui wala ' +
        'haithibitishi mpaka, haki, au maslahi yoyote katika ardhi.',
    );
  });

  it('makes the three required denials in both locales', () => {
    // English: not a survey, no determination, no interest in land.
    expect(NON_CADASTRAL_DISCLAIMER).toContain('Not a cadastral survey');
    expect(NON_CADASTRAL_DISCLAIMER).toContain('Does not determine');
    expect(NON_CADASTRAL_DISCLAIMER).toContain('interest in land');

    // Swahili: si upimaji (not a survey), haiamui (does not determine),
    // maslahi ... katika ardhi (interest in land).
    expect(NON_CADASTRAL_DISCLAIMER_SW).toContain('Si upimaji wa ardhi');
    expect(NON_CADASTRAL_DISCLAIMER_SW).toContain('Haiamui');
    expect(NON_CADASTRAL_DISCLAIMER_SW).toContain('katika ardhi');
  });

  it('is non-empty and single-line in both locales', () => {
    // Embedded newlines break CSV and Shapefile sidecar footers.
    for (const text of [NON_CADASTRAL_DISCLAIMER, NON_CADASTRAL_DISCLAIMER_SW]) {
      expect(text.length).toBeGreaterThan(50);
      expect(text).not.toMatch(/[\r\n]/);
      expect(text.trim()).toBe(text);
    }
  });
});
