import { describe, expect, it } from 'vitest';
import {
  allow,
  deny,
  Guarded,
  AuthorizationNotEvaluatedError,
  type NoteResource,
} from '@edu/authz';

/**
 * `Guarded<T>` is the structural half of the IDOR defence: a protected payload
 * that refuses to be read without an allow-decision naming that exact object
 * and that exact action.
 *
 * The mismatch cases below are the interesting ones. They describe the shape of
 * a real IDOR bug — a handler that authorizes ONE object and then returns
 * ANOTHER — and prove the wrapper catches it at runtime rather than serving the
 * wrong user's data.
 */

const NOTE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOTE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const resourceFor = (id: string): NoteResource => ({
  kind: 'note',
  id,
  ownerId: 'owner',
  organizationId: null,
  visibility: 'private',
  state: 'active',
});

const payload = { secret: 'the note body' };

describe('Guarded', () => {
  it('releases the payload for a matching allow-decision', () => {
    const guarded = Guarded.of(payload, resourceFor(NOTE_A));
    const decision = allow('note:read', NOTE_A, 'note.owner');
    expect(guarded.unwrap(decision, 'note:read')).toEqual(payload);
  });

  it('refuses to release the payload on a deny', () => {
    const guarded = Guarded.of(payload, resourceFor(NOTE_A));
    const decision = deny('note:read', NOTE_A, 'note.no_matching_grant');
    expect(() => guarded.unwrap(decision, 'note:read')).toThrow(AuthorizationNotEvaluatedError);
  });

  it('refuses when the decision was made about a DIFFERENT object (the IDOR shape)', () => {
    // The attacker's note is authorized; the victim's note is returned.
    const victimsNote = Guarded.of(payload, resourceFor(NOTE_B));
    const decisionAboutAttackersOwnNote = allow('note:read', NOTE_A, 'note.owner');

    expect(() => victimsNote.unwrap(decisionAboutAttackersOwnNote, 'note:read')).toThrow(
      /Decision\/resource mismatch/,
    );
  });

  it('refuses when the decision authorized a different action', () => {
    // A read grant must not be reusable as a delete grant.
    const guarded = Guarded.of(payload, resourceFor(NOTE_A));
    const readDecision = allow('note:read', NOTE_A, 'note.owner');
    expect(() => guarded.unwrap(readDecision, 'note:delete')).toThrow(/Decision\/action mismatch/);
  });

  it('exposes authorization attributes without a decision, but never the payload', () => {
    const guarded = Guarded.of(payload, resourceFor(NOTE_A));
    // The policy engine needs these as input, so they must be readable.
    expect(guarded.resource.id).toBe(NOTE_A);
    // The payload is genuinely unreachable — not merely conventionally private.
    expect(Object.values(guarded)).not.toContainEqual(payload);
    expect(JSON.stringify(guarded)).not.toContain('the note body');
  });

  it('keeps the guarantee across map()', () => {
    const guarded = Guarded.of(payload, resourceFor(NOTE_A)).map((v) => ({ ...v, extra: 1 }));
    const wrongDecision = allow('note:read', NOTE_B, 'note.owner');
    expect(() => guarded.unwrap(wrongDecision, 'note:read')).toThrow(/mismatch/);
  });
});
