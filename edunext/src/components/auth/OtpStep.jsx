import { useEffect, useRef, useState } from 'react';
import { Pencil, RotateCw } from 'lucide-react';
import { Button } from '../ui/index.js';

/**
 * Step 2 of authentication: enter the six-digit code.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BOXES ARE `dir="ltr"` INSIDE AN RTL PAGE
 * ---------------------------------------------------------------------------
 *
 * A one-time code is a NUMBER, and numbers are written left-to-right in Arabic
 * typography exactly as they are in English — "123456" reads 1-2-3-4-5-6 in
 * both. Six separate inputs in an RTL container would be laid out right-to-
 * left, so the box the user fills first would be the rightmost one while the
 * code they are copying starts at the left. They would type the code in
 * reversed and have no way to tell.
 *
 * So the strip of boxes gets its own `dir="ltr"` context. Everything around it
 * — the heading, the email, the resend link — stays RTL. This is the case the
 * design tokens' RTL note calls "a value that must genuinely differ".
 *
 * It also settles the arrow keys for free: inside an LTR context ArrowLeft
 * means "the previous box", which is what the user's eyes expect.
 *
 * ---------------------------------------------------------------------------
 * THE COUNTDOWN IS ANCHORED TO A DEADLINE, NOT COUNTED DOWN
 * ---------------------------------------------------------------------------
 *
 * `setInterval` decrementing a counter drifts, and worse, browsers throttle
 * timers in a backgrounded tab — so a user who switches away for the full
 * minute comes back to a timer that still reads 40 seconds and a resend button
 * that is still disabled, for a code that expired long ago.
 *
 * Storing the DEADLINE and deriving the remaining seconds from the clock makes
 * the wrong answer impossible: whenever the tab is painted, the number shown is
 * the truth, however long the tab was asleep.
 */

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

/** Keeps only digits, and never more than the code is long. */
function digitsOnly(value) {
  return value.replace(/\D/g, '').slice(0, OTP_LENGTH);
}

/** Seconds until resend unlocks, read from the clock rather than counted down. */
function remainingSeconds(sentAt) {
  return Math.max(0, Math.ceil((sentAt + RESEND_SECONDS * 1000 - Date.now()) / 1000));
}

export default function OtpStep({
  email,
  onEdit,
  onSubmit,
  onResend,
  error,
  onError,
  pending,
  /** Changes each time a code is sent; restarts the countdown. */
  sentAt,
}) {
  /*
   * THE RESET ON RESEND IS A REMOUNT, NOT AN EFFECT.
   *
   * A new code means new boxes: the old digits are wrong and the caret belongs
   * back at box one. The obvious implementation is an effect on `sentAt` that
   * calls `setDigits`, and it works — but it renders the stale digits first and
   * then immediately renders again to clear them, which is a cascading render
   * for a value that was never valid.
   *
   * `Auth` keys this component on `sentAt` instead, so a new code mounts a new
   * component. The state below then starts correct rather than being corrected,
   * and both initialisers can simply read the props.
   */
  const [digits, setDigits] = useState(() => Array(OTP_LENGTH).fill(''));
  const [secondsLeft, setSecondsLeft] = useState(() => remainingSeconds(sentAt));
  const inputsRef = useRef([]);

  /*
   * Focus the first box on mount — which, given the key above, also covers the
   * resend. Without it the user arrives at a screen whose entire purpose is one
   * input and has to go find it; on a phone that is a tap they should never
   * have had to make.
   */
  useEffect(() => {
    inputsRef.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (remainingSeconds(sentAt) === 0) return undefined;

    // 250ms rather than 1000ms so the displayed second changes close to when it
    // actually turns over, instead of up to a full second late. Every update
    // happens inside the callback, never synchronously during the effect.
    const id = setInterval(() => {
      const remaining = remainingSeconds(sentAt);
      setSecondsLeft(remaining);
      if (remaining === 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [sentAt]);

  const code = digits.join('');
  const canResend = secondsLeft === 0 && !pending;

  const focusBox = (index) => {
    const target = inputsRef.current[Math.min(Math.max(index, 0), OTP_LENGTH - 1)];
    target?.focus();
    target?.select();
  };

  /** Writes `value` across the boxes starting at `from`, and returns the next empty index. */
  const fill = (from, value) => {
    const incoming = digitsOnly(value);
    if (incoming === '') return from;

    setDigits((current) => {
      const next = [...current];
      for (let i = 0; i < incoming.length && from + i < OTP_LENGTH; i += 1) {
        next[from + i] = incoming[i];
      }
      return next;
    });
    if (error) onError(null);
    return Math.min(from + incoming.length, OTP_LENGTH - 1);
  };

  const handleChange = (index, rawValue) => {
    if (rawValue === '') {
      setDigits((current) => {
        const next = [...current];
        next[index] = '';
        return next;
      });
      return;
    }

    /*
     * A change event can carry more than one character for two very different
     * reasons, and they need opposite handling.
     *
     * APPENDED — the box already held a digit and the user typed another into
     * it. This happens in the LAST box, the one place focus has nowhere to
     * advance to, so the selection from `onFocus` is long gone. The browser
     * reports "12" when the user meant "2". Taking the whole string would
     * write the OLD digit back and silently discard the new one.
     *
     * DELIVERED — an Android soft keyboard or a password manager handed over
     * the whole code at once, with nothing there before. Here the whole string
     * is exactly what is wanted, spread across the boxes.
     *
     * The two are told apart by whether the box already had something in it.
     */
    const previous = digits[index];
    const value =
      previous !== '' && rawValue.length > 1 && rawValue.startsWith(previous)
        ? rawValue.slice(previous.length)
        : rawValue;

    // `fill` returns the box the user should be in next: the one after a single
    // digit, or the end of a code that arrived all at once.
    focusBox(fill(index, value));
  };

  const handleKeyDown = (index, event) => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (digits[index] !== '') {
        // There is something here — clear it and stay put. Jumping back as well
        // would silently eat two digits for one keypress.
        setDigits((current) => {
          const next = [...current];
          next[index] = '';
          return next;
        });
        if (error) onError(null);
        return;
      }
      // Empty box: step back and clear what is there, which is what a single
      // continuous field would have done.
      if (index > 0) {
        setDigits((current) => {
          const next = [...current];
          next[index - 1] = '';
          return next;
        });
        focusBox(index - 1);
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusBox(index + 1);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      setDigits((current) => {
        const next = [...current];
        next[index] = '';
        return next;
      });
    }
  };

  const handlePaste = (index, event) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData('text');
    focusBox(fill(index, pasted));
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (code.length < OTP_LENGTH) {
      onError(`أدخل الرمز المكوّن من ${OTP_LENGTH} أرقام.`);
      focusBox(digits.findIndex((d) => d === ''));
      return;
    }
    onSubmit(code);
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h1 className="text-xl font-bold leading-snug text-text-main sm:text-2xl">أدخل رمز التحقق</h1>

      <p className="mt-2 text-sm leading-relaxed text-text-muted">
        أرسلنا رمزًا مكوّنًا من {OTP_LENGTH} أرقام إلى
      </p>

      {/*
        The address and its edit action sit on one line, because "is that the
        right address?" and "let me change it" are the same thought. `dir="ltr"`
        on the address alone keeps it readable; `break-all` stops a long address
        widening the card on a 360px screen.
      */}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span dir="ltr" className="break-all text-sm font-medium text-text-main">
          {email}
        </span>
        <button
          type="button"
          onClick={onEdit}
          disabled={pending}
          className="inline-flex items-center gap-1 rounded-full text-xs font-medium text-primary transition-colors duration-200 hover:text-primary-hover disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          <span>تعديل</span>
        </button>
      </div>

      {/*
        `dir="ltr"` — see the header. `role="group"` with a label gives a screen
        reader one name for the whole strip, so it announces "رمز التحقق" once
        rather than treating six inputs as six unrelated fields.
      */}
      <div
        dir="ltr"
        role="group"
        aria-label="رمز التحقق"
        aria-describedby={error ? 'auth-otp-error' : undefined}
        className="mt-7 flex justify-center gap-1.5 sm:gap-3"
      >
        {digits.map((digit, index) => (
          <input
            // The index is the correct key here, unusually: this is a
            // fixed-length positional strip, so box 3 is box 3 for the life of
            // the component. There is no reordering for a key to protect.
            key={index}
            ref={(element) => {
              inputsRef.current[index] = element;
            }}
            type="text"
            /*
             * `inputMode="numeric"` opens the digit keypad on a phone without
             * the spinner, scroll-to-change and locale quirks that come with
             * `type="number"`. `autoComplete="one-time-code"` on the first box
             * is what lets iOS offer the code straight from the notification.
             */
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={OTP_LENGTH}
            value={digit}
            onChange={(event) => handleChange(index, event.target.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            onPaste={(event) => handlePaste(index, event)}
            onFocus={(event) => event.target.select()}
            disabled={pending}
            aria-label={`الرقم ${index + 1} من ${OTP_LENGTH}`}
            aria-invalid={error ? 'true' : undefined}
            className={[
              /*
                THE BOXES FLEX; THEY DO NOT HAVE A FIXED WIDTH.

                Six 44px boxes with gaps between them need 304px, and the card
                offers 278px at a 360px viewport — so a fixed width overflowed,
                and because the card is `overflow-hidden` the strip silently ran
                edge to edge with the outer box clipped. Measured: content 304px
                into a 278px container.

                Patching the two widths that were measured is what produces a
                component that breaks at the third. `flex-1` with `min-w-0` lets
                each box take an equal share of whatever space there is, so the
                strip fits by construction at every width. `max-w-[3rem]` is the
                other end of it: without a cap, six boxes would stretch across
                the full card on desktop and stop reading as digit cells.
              */
              'h-12 min-w-0 flex-1 rounded-2xl border text-center text-lg font-semibold',
              'max-w-[3rem] text-text-main',
              'tabular-nums transition-colors duration-200 disabled:opacity-60',
              'sm:h-14 sm:text-xl',
              error
                ? 'border-red-400 bg-surface'
                : digit
                  ? 'border-primary bg-primary-light'
                  : 'border-accent-subtle bg-surface focus:border-primary',
            ].join(' ')}
          />
        ))}
      </div>

      {error ? (
        <p id="auth-otp-error" role="alert" className="mt-3 text-center text-xs text-red-600">
          {error}
        </p>
      ) : null}

      <Button type="submit" loading={pending} className="mt-6 w-full">
        {pending ? 'جارٍ التحقق…' : 'تأكيد الدخول'}
      </Button>

      {/*
        The countdown is NOT in an aria-live region. Announcing a number that
        changes every second would talk over everything else a screen-reader
        user is trying to hear. The button's own disabled state carries the same
        information, and it becomes available the moment the wait is over.
      */}
      <div className="mt-5 text-center text-xs text-text-muted">
        {canResend ? (
          <button
            type="button"
            onClick={onResend}
            className="inline-flex items-center gap-1.5 rounded-full font-medium text-primary transition-colors duration-200 hover:text-primary-hover"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>إعادة إرسال الرمز</span>
          </button>
        ) : (
          <span>
            يمكنك طلب رمز جديد بعد{' '}
            <span className="font-medium text-text-main tabular-nums">{secondsLeft}</span> ثانية
          </span>
        )}
      </div>
    </form>
  );
}
