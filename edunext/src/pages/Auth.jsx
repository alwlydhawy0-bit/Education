import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { EmailStep, OtpStep } from '../components/auth/index.js';

/**
 * The authentication screen: email, then a one-time code.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH STEPS' STATE LIVES HERE
 * ---------------------------------------------------------------------------
 *
 * The email is entered in step one and displayed, edited and re-submitted from
 * step two. Owning it here is what makes "تعديل" a free operation — it changes
 * one number and the email is still there, because it never belonged to the
 * step that collected it. Holding it inside `EmailStep` would mean either
 * unmounting the value on every transition or passing it back up anyway, which
 * is this arrangement with extra steps.
 *
 * `pending` and `error` are here for the same reason: they describe the
 * REQUEST, not the form, and the request outlives whichever step started it.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSITION ANIMATES BECAUSE THE STEP IS KEYED
 * ---------------------------------------------------------------------------
 *
 * `key={step}` makes React unmount one step and mount the other rather than
 * reusing the DOM, so the entry animation actually runs on each change. It also
 * guarantees the second step starts clean — no digits left behind from a
 * previous visit, no stale focus.
 *
 * The animation moves on Y only. An X translate would have to know which way
 * "forward" is, and that answer flips with the writing direction; Y is the same
 * in every language and needs no `rtl:` variant to stay correct.
 */

/** The simulation's latency. Long enough for the pending state to be visible. */
const FAKE_LATENCY_MS = 700;

/**
 * SIMULATION ONLY — the seam where the real calls go.
 *
 * These stand in for `apiClient.post('/auth/request-code', …)` and
 * `apiClient.post('/auth/verify-code', …)`. They are deliberately shaped like
 * those calls — async, rejecting with a readable Arabic message — so replacing
 * them is an edit to these two functions and nothing else.
 *
 * `000000` is rejected so the failure path is reachable without a backend. A
 * component whose error branch has never once rendered is a component whose
 * error branch does not work.
 */
const auth = {
  requestCode: (email) =>
    new Promise((resolve) => {
      void email;
      setTimeout(resolve, FAKE_LATENCY_MS);
    }),

  verifyCode: (code) =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        if (code === '000000') {
          reject(new Error('الرمز غير صحيح. تحقّق منه أو اطلب رمزًا جديدًا.'));
          return;
        }
        resolve();
      }, FAKE_LATENCY_MS);
    }),
};

export default function Auth({ onAuthenticated }) {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  /** Timestamp of the last code sent — drives the resend countdown. */
  const [sentAt, setSentAt] = useState(0);

  const sendCode = async (address) => {
    setPending(true);
    setError(null);
    try {
      await auth.requestCode(address);
      setSentAt(Date.now());
      setStep('otp');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setPending(false);
    }
  };

  const verify = async (code) => {
    setPending(true);
    setError(null);
    try {
      await auth.verifyCode(code);
      onAuthenticated();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setPending(false);
    }
  };

  return (
    /*
      THE FULL-BLEED SHELL.

      `relative overflow-hidden` makes this the positioning context for any
      ambient background shape added later, and clips it to the viewport rather
      than letting it push the page sideways.

      TWO UNITS HERE ARE DELIBERATE AND BOTH ARE THE LESS OBVIOUS CHOICE:

      `min-h-[100dvh]`, not `min-h-screen`. `min-h-screen` is `100vh`, which on
      a mobile browser is the LARGE viewport — the height the page would have if
      the address bar were hidden. With the bar showing, `100vh` is taller than
      what the user can see, so the bottom of a centred card drifts under the
      browser chrome. `100dvh` is the height that is actually visible and
      resizes as the bar comes and goes. `AppLayout` already uses `dvh` for this
      exact reason, so this also keeps the two shells consistent. No `vh`
      fallback is paired with it: stacking `min-h-screen min-h-[100dvh]` on one
      element leaves which rule wins to Tailwind's internal sort order rather
      than to the class order written here, and `dvh` has been in every engine
      since 2022 anyway.

      `w-full`, NOT `w-screen`. Per spec, `vw` resolves against the viewport
      INCLUDING the classic scrollbar gutter, so a `100vw` element on a browser
      that reserves gutter space is wider than the space it has and the page
      gains a horizontal scrollbar nobody asked for.

      Two honest qualifications, because this is a guard rather than a fix for
      an observed bug. First, it could not be reproduced in this project's
      headless Chromium, which uses overlay scrollbars and reports a gutter of
      zero however it is launched — so the claim above rests on the spec and on
      desktop Firefox/Windows Chrome behaviour, not on a measurement taken here.
      Second, it would not bite THIS page even where it does apply: the card is
      centred in a viewport-height box, so there is never a vertical scrollbar
      and therefore never a gutter.

      `w-full` is still the right choice, just for a plainer reason than a bug
      report: a block-level element already fills its parent, so `w-full` states
      the intent and has no case where it can disagree with the viewport.
    */
    <main className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-hidden bg-surface-alt/40 p-4 sm:p-6">
      {/*
        `overflow-hidden` is what turns the arc from a square into a quarter
        disc clipped by the card's own 16px corner. Without it the decoration
        would sit outside the card and the corner radius would be lost.
      */}
      <section className="card-surface relative w-full max-w-md overflow-hidden">
        <ArcHeader />

        {/*
          `pt-36` clears the arc. The heading sits BELOW the badge rather than
          beside it, and that is a responsiveness decision rather than a
          stylistic one: at 360px there is no room for a 112px ornament and an
          Arabic heading on one line, so any side-by-side arrangement has to
          reflow — and reflowing a decorative corner is how it ends up overlapping
          the text at exactly one width nobody tested.
        */}
        <div className="px-6 pb-8 pt-36 sm:px-9 sm:pb-10 sm:pt-40">
          <div key={step} className="motion-safe:animate-step-in">
            {step === 'email' ? (
              <EmailStep
                email={email}
                onEmailChange={setEmail}
                onSubmit={sendCode}
                error={error}
                onError={setError}
                pending={pending}
              />
            ) : (
              <OtpStep
                /*
                  A new code mounts a new step. That is what clears the boxes
                  and restarts the countdown, instead of an effect that would
                  render the stale digits once before correcting them.
                */
                key={sentAt}
                email={email}
                sentAt={sentAt}
                onEdit={() => {
                  setError(null);
                  setStep('email');
                }}
                onSubmit={verify}
                onResend={() => sendCode(email)}
                error={error}
                onError={setError}
                pending={pending}
              />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

/**
 * The corner ornament: three nested quarter-discs with the book resting on top.
 *
 * ---------------------------------------------------------------------------
 * THIS ONE USES PHYSICAL `left`/`top`, ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * Everything else in this app uses logical properties (`start-`, `ps-`) so it
 * follows the writing direction. This does not, and the distinction is worth
 * stating because it looks like the exact mistake the token file warns about.
 *
 * The arc is a piece of the CARD'S GEOMETRY, not of its content: it fills one
 * physical corner and its curve is cut to that corner's radius. `rounded-br-*`
 * is likewise physical in Tailwind and does not flip. Pinning the two together
 * with `left-0 top-0` keeps them agreeing; mixing a logical `start-0` with a
 * physical `rounded-br-full` would put a square edge in the corner and the
 * curve on the outside — visibly broken, and only in one direction.
 *
 * Worth knowing for later: in RTL the reading START corner is the top RIGHT, so
 * a badge placed top-left sits where the eye finishes rather than where it
 * begins. That is a deliberate design choice here, not an oversight, and moving
 * it is a two-token change — `left-0` → `right-0`, `rounded-br-full` →
 * `rounded-bl-full` — on each of the three layers.
 *
 * The layers go palest-to-solid inward, which reads as depth rather than as
 * three flat shapes, and `aria-hidden` keeps all of it out of the accessibility
 * tree: it says nothing a screen reader needs, and the heading below already
 * names the product.
 */
function ArcHeader() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute left-0 top-0">
      <div className="absolute left-0 top-0 h-36 w-36 rounded-br-full bg-primary-light sm:h-40 sm:w-40" />
      <div className="absolute left-0 top-0 h-28 w-28 rounded-br-full bg-accent-lavender sm:h-32 sm:w-32" />
      <div className="absolute left-0 top-0 h-20 w-20 rounded-br-full bg-primary shadow-soft sm:h-24 sm:w-24" />
      {/*
        The icon is placed at a fixed inset from the corner rather than centred
        in the solid arc: the visual centre of a quarter disc is not its
        bounding box's centre, and centring it there leaves the book looking
        like it is sliding off the curve.
      */}
      <BookOpen
        className="absolute left-5 top-5 h-7 w-7 text-white sm:left-6 sm:top-6 sm:h-8 sm:w-8"
        strokeWidth={1.75}
      />
    </div>
  );
}
