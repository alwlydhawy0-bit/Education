import { describe, expect, it } from 'vitest';
import {
  MODERATION_ACTIONS,
  MODERATION_STATES,
  MUST_NEVER_MATCH,
  isModerationNoop,
  nextModerationState,
  normalizeForFilter,
  screenContent,
  type ModerationAction,
  type ModerationState,
} from '../../apps/api/src/modules/community/content-filter.ts';

/**
 * The automated filter and the moderation state machine.
 *
 * Section 2E asks for two things this file provides: unit coverage of profanity
 * filtering and of moderation status transitions, and a demonstration that the
 * filter survives "payload tricks".
 *
 * TWO SUITES OF EQUAL WEIGHT. The evasion cases prove the filter catches what
 * it is aimed at. `MUST_NEVER_MATCH` proves it does not catch homework — and on
 * a platform whose users are children writing about assignments, classification
 * and analysis, that second suite is the one that keeps the moderation queue
 * worth reading. A filter that cries wolf trains teachers to clear the queue
 * without looking, which costs more safety than the filter provides.
 *
 * Invisible characters are written as escapes rather than pasted, so that a
 * reader of this file can see which character each case is about.
 */

const ZWSP = '​';
const ZWJ = '‍';
const BOM = '﻿';
const RLO = '‮';

const flagged = (text: string): boolean => screenContent(text).flagged;

describe('the filter catches the direct case', () => {
  it.each([
    'you are an idiot',
    'this is shit',
    'shut up',
    'kill yourself',
    'انت غبي',
    'كلب',
  ])('flags %s', (text) => {
    expect(flagged(text)).toBe(true);
  });

  it('names the term it matched, for the moderation record', () => {
    const verdict = screenContent('you are an idiot');
    expect(verdict.findings.map((f) => f.term)).toContain('idiot');
    expect(verdict.reason).toContain('idiot');
  });

  it('leaves ordinary posts alone', () => {
    const verdict = screenContent('Has anyone finished the pendulum assignment?');
    expect(verdict.flagged).toBe(false);
    expect(verdict.findings).toEqual([]);
    expect(verdict.reason).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Section 2E: "Bypassing profanity filter using payload tricks"
// ---------------------------------------------------------------------------

describe('payload tricks', () => {
  it.each([
    ['i d i o t', 'single spaces between letters'],
    ['i  d  i  o  t', 'multiple spaces — the case that beat the first normalizer'],
    ['i.d.i.o.t', 'full stops'],
    ['i-d-i-o-t', 'hyphens'],
    ['i_d_i_o_t', 'underscores'],
    ['i*d*i*o*t', 'asterisks'],
    ['i/d/i/o/t', 'slashes'],
    ['i\nd\ni\no\nt', 'newlines'],
    ['1d10t', 'leetspeak digits'],
    ['!d!ot', 'exclamation marks as i'],
    ['IDIOT', 'uppercase'],
    ['IdIoT', 'alternating case'],
    ['idiiiiot', 'a stretched vowel'],
    ['iiidddiiiooottt', 'every letter stretched'],
    ['ídiót', 'accents'],
    ['ｉｄｉｏｔ', 'fullwidth forms'],
    ['іdiоt', 'Cyrillic homoglyphs'],
  ])('catches %s (%s)', (text) => {
    expect(flagged(`you are an ${text}`)).toBe(true);
  });

  it.each([
    [ZWSP, 'zero-width space'],
    [ZWJ, 'zero-width joiner'],
    [BOM, 'byte-order mark'],
    [RLO, 'right-to-left override'],
  ])('catches an invisible %s inserted mid-word (%s)', (ch) => {
    expect(flagged(`you are an id${ch}iot`)).toBe(true);
  });

  it.each([
    ['sh1t', 'digit for i'],
    ['$hit', 'dollar for s'],
    ['f u c k', 'spaced'],
    ['fuuuuck', 'stretched'],
    ['y0u $tup1d', 'several substitutions at once'],
  ])('catches %s (%s)', (text) => {
    expect(flagged(text)).toBe(true);
  });

  it('is total: no input throws, however hostile', () => {
    const hostile = [
      '',
      ' ',
      'a'.repeat(20_000),
      ZWSP.repeat(5_000),
      '\u{1f480}'.repeat(1_000),
      '\\\\\\',
      '(((((((',
      String.fromCharCode(0xd800), // a lone surrogate
    ];
    for (const text of hostile) {
      expect(() => screenContent(text)).not.toThrow();
    }
  });

  it('an empty or whitespace-only post is not flagged', () => {
    expect(flagged('')).toBe(false);
    expect(flagged('   \n\t ')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The half that keeps the queue readable
// ---------------------------------------------------------------------------

describe('the Scunthorpe problem', () => {
  it.each(MUST_NEVER_MATCH)('never flags %s', (word) => {
    expect(flagged(`I am writing about ${word} for my homework.`)).toBe(false);
  });

  it('never flags them as a bare word either', () => {
    for (const word of MUST_NEVER_MATCH) {
      expect(flagged(word), word).toBe(false);
    }
  });

  it('never flags them under the aggressive second reading', () => {
    // `screenContent` matches against both the conservative normalization and
    // one that squashes every repeated letter. `bass` becomes `bas` there and
    // `assignment` becomes `asignment`. This asserts neither collides with a
    // listed term — the risk that second reading introduces.
    for (const word of MUST_NEVER_MATCH) {
      expect(flagged(`${word} ${word} ${word}`), word).toBe(false);
    }
  });

  it('leaves hyphenated and abbreviated words intact when normalizing', () => {
    // The normalizer collapses letter-by-letter runs. These have a single
    // letter-separator pair and must survive — Task 012 learned this the hard
    // way when an over-eager normalizer deleted every word boundary.
    expect(normalizeForFilter('co-operate')).toBe('co-operate');
    expect(normalizeForFilter('e-mail')).toBe('e-mail');
    expect(normalizeForFilter('well-known')).toBe('well-known');
  });

  it('does not flag a whole realistic homework post', () => {
    const post = [
      '# Pendulum assignment',
      '',
      'I did the classic experiment for my analysis. The class notes say to',
      'assess the period against length. My results are in the document I',
      'attached. Does anyone know if we should assume no air resistance?',
      '',
      'Also — is the deadline Friday? The titles on the assessment confused me.',
    ].join('\n');
    expect(flagged(post)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 2E: moderation status transitions
// ---------------------------------------------------------------------------

describe('the moderation state machine', () => {
  it('is total — every state and action pair has an answer', () => {
    for (const state of MODERATION_STATES) {
      for (const action of MODERATION_ACTIONS) {
        const next = nextModerationState(state, action);
        expect(MODERATION_STATES, `${state} + ${action}`).toContain(next);
      }
    }
  });

  it.each([
    ['approved', 'approve', 'approved'],
    ['approved', 'hide', 'hidden'],
    ['approved', 'flag', 'flagged'],
    ['flagged', 'approve', 'approved'],
    ['flagged', 'hide', 'hidden'],
    ['flagged', 'flag', 'flagged'],
    ['hidden', 'approve', 'approved'],
    ['hidden', 'hide', 'hidden'],
    ['hidden', 'flag', 'hidden'],
  ] as ReadonlyArray<readonly [ModerationState, ModerationAction, ModerationState]>)(
    '%s + %s = %s',
    (state, action, expected) => {
      expect(nextModerationState(state, action)).toBe(expected);
    },
  );

  it('a hidden post cannot be re-queued as flagged', () => {
    // Once a human has looked, the post is fit to read or it is not.
    // "Hidden, then back in the queue for somebody else" would let a decision
    // be laundered into the backlog.
    expect(nextModerationState('hidden', 'flag')).toBe('hidden');
  });

  it('repeating an action is a no-op rather than an error', () => {
    // Two teachers clearing the same queue at once is normal. Making the second
    // one fail teaches staff to expect errors from the moderation tool.
    expect(isModerationNoop('approved', 'approve')).toBe(true);
    expect(isModerationNoop('hidden', 'hide')).toBe(true);
    expect(isModerationNoop('flagged', 'flag')).toBe(true);
    expect(isModerationNoop('flagged', 'approve')).toBe(false);
  });

  it('is idempotent — applying an action twice equals applying it once', () => {
    for (const state of MODERATION_STATES) {
      for (const action of MODERATION_ACTIONS) {
        const once = nextModerationState(state, action);
        expect(nextModerationState(once, action)).toBe(once);
      }
    }
  });
});
