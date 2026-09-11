/**
 * Enforces the RTL commitment from the plan.
 *
 * The plan promised an ESLint rule banning physical direction properties. The
 * storefront uses plain CSS rather than Tailwind, so the equivalent guard is
 * this: a physical property that sneaks into the stylesheet silently breaks
 * Arabic, and nobody notices until someone opens the site in `ar`. Failing the
 * build is cheaper than that.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS_PATH = fileURLToPath(new URL('../../src/app/globals.css', import.meta.url));

/**
 * Physical properties with a logical counterpart. `left`/`right` as *values*
 * (e.g. `float: left`) are equally wrong but are caught by the same patterns
 * since they are matched as declarations.
 */
const BANNED = [
  /(^|[\s;{])padding-(left|right)\s*:/,
  /(^|[\s;{])margin-(left|right)\s*:/,
  /(^|[\s;{])border-(left|right)(-[a-z]+)?\s*:/,
  /(^|[\s;{])(left|right)\s*:/,
  /(^|[\s;{])text-align\s*:\s*(left|right)/,
  /(^|[\s;{])float\s*:\s*(left|right)/,
  /(^|[\s;{])inset-(left|right)\s*:/,
];

describe('RTL safety', () => {
  const css = readFileSync(CSS_PATH, 'utf8');

  // Strip comments so prose about `left`/`right` does not trip the guard.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = withoutComments.split('\n');

  it('uses no physical direction properties', () => {
    const offenders: string[] = [];

    lines.forEach((line, index) => {
      for (const pattern of BANNED) {
        if (pattern.test(line)) {
          offenders.push(`globals.css:${index + 1}  ${line.trim()}`);
          break;
        }
      }
    });

    expect(offenders).toEqual([]);
  });

  it('actually detects a physical property when one is present', () => {
    // Guards the guard: a regex that matches nothing would pass the test above
    // forever while catching no real regression.
    const sample = '.x { padding-left: 1rem; }';
    expect(BANNED.some((pattern) => pattern.test(sample))).toBe(true);
  });

  it('does not flag the logical equivalents', () => {
    const sample = `
      .x { padding-inline-start: 1rem; margin-inline: auto; inset-inline-start: 0; }
      .y { text-align: start; padding-inline: 1rem 2rem; }
    `;
    for (const line of sample.split('\n')) {
      expect(BANNED.some((pattern) => pattern.test(line))).toBe(false);
    }
  });
});
