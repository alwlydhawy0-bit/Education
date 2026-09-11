import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * EduNext colours must come from theme tokens, and every token must exist in
 * both themes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * The EduNext palette is built entirely from CSS variables so that a single
 * `.dark` block can re-point every colour in the app. A hard-coded Tailwind
 * palette utility — `text-red-600`, `bg-blue-500` — opts out of that mechanism
 * silently: it renders correctly on the theme the author happened to be looking
 * at and is simply wrong on the other one, with nothing to catch it.
 *
 * That is not hypothetical. Every validation message in the app was written as
 * `text-red-600`, which measures 4.83:1 on the light canvas and 3.53:1 on the
 * dark one — below the WCAG AA floor of 4.5:1 — so dark-theme readers got
 * failing contrast on every error the app can report. The decorative dot in
 * WeeklySchedule was `bg-white/70` on `bg-primary`, which is a white dot on a
 * LIGHT violet cell once the dark theme lightens the accent.
 *
 * Both were invisible to every other check in this repository, because both are
 * perfectly valid CSS that renders without complaint.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CAN AND CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 * These are assertions about SOURCE TEXT, so they prove that the colours are
 * spelled as tokens — NOT that the resulting contrast passes. A token can hold
 * a bad value and this file stays green. The contrast itself has to be measured
 * in a browser against the built CSS, and that measurement is what found the
 * two defects described above; this file only stops them coming back.
 */

const EDUNEXT = resolve(import.meta.dirname, '../../edunext');
const SOURCE = join(EDUNEXT, 'src');

/** Tailwind's built-in palette families — the ones that do NOT flip with the theme. */
const PALETTE_FAMILIES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
].join('|');

const COLOUR_PROPERTIES =
  'bg|text|border|ring|ring-offset|from|to|via|fill|stroke|decoration|outline|divide|placeholder|caret|accent|shadow';

/** e.g. `text-red-600`, `bg-blue-500/40`, `border-s-gray-200`. */
const PALETTE_UTILITY = new RegExp(
  `(?<![\\w-])(?:${COLOUR_PROPERTIES})(?:-[a-z])?-(?:${PALETTE_FAMILIES})-\\d{2,3}(?:/\\d{1,3})?(?![\\w-])`,
  'g',
);

/**
 * `white` and `black` are absolute, so they are wrong on one theme by
 * construction wherever they carry meaning. They are permitted ONLY as a
 * scrim — a translucent black over a page, which is the same intent in both
 * themes — and that lives in the modal overlay, not in components.
 */
const ABSOLUTE_UTILITY = new RegExp(
  `(?<![\\w-])(?:${COLOUR_PROPERTIES})(?:-[a-z])?-(?:white|black)(?:/\\d{1,3})?(?![\\w-])`,
  'g',
);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(jsx?|tsx?)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('EduNext theme tokens', () => {
  const files = sourceFiles(SOURCE);

  it('has source files to check', () => {
    // A glob that silently matches nothing turns every assertion below into a
    // no-op that passes forever.
    expect(files.length).toBeGreaterThan(20);
  });

  it('uses no hard-coded Tailwind palette colours', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(PALETTE_UTILITY)) {
          offenders.push(`${relative(EDUNEXT, file)}:${index + 1}  ${match[0]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('uses no absolute white or black colours', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(ABSOLUTE_UTILITY)) {
          offenders.push(`${relative(EDUNEXT, file)}:${index + 1}  ${match[0]}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  describe('the palette', () => {
    const css = readFileSync(join(SOURCE, 'index.css'), 'utf8');

    /** The `:root { … }` and `.dark { … }` bodies, matched by brace depth. */
    const blockFor = (selector: string): string => {
      const start = css.indexOf(selector);
      expect(start, `${selector} block not found`).toBeGreaterThanOrEqual(0);
      const open = css.indexOf('{', start);
      let depth = 0;
      for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) return css.slice(open + 1, i);
        }
      }
      throw new Error(`unbalanced braces after ${selector}`);
    };

    const tokensIn = (block: string): string[] =>
      [...block.matchAll(/--color-([\w-]+)\s*:/g)].map((match) => match[1]!).sort();

    it('defines every light colour token in the dark theme too', () => {
      const light = tokensIn(blockFor(':root'));
      const dark = tokensIn(blockFor('.dark'));
      expect(light.length).toBeGreaterThan(8);
      // A token defined only in `:root` keeps its LIGHT value on a dark page,
      // which is the exact shape of the bug this suite exists to prevent.
      expect(dark).toEqual(light);
    });

    it('declares colour tokens as space-separated RGB channels', () => {
      // Tailwind composes these as `rgb(var(--token) / <alpha-value>)`. A token
      // written as `#a78bfa` or `rgb(167, 139, 250)` makes every opacity
      // modifier in the app silently produce an invalid colour.
      const offenders: string[] = [];
      for (const selector of [':root', '.dark']) {
        for (const match of blockFor(selector).matchAll(/--color-([\w-]+)\s*:\s*([^;]+);/g)) {
          if (!/^\d{1,3} \d{1,3} \d{1,3}$/.test(match[2]!.trim())) {
            offenders.push(`${selector} --color-${match[1]}: ${match[2]!.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  });
});
