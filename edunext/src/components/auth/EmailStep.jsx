import { Mail } from 'lucide-react';
import { Button } from '../ui/index.js';

/**
 * Step 1 of authentication: ask for the email a one-time code will be sent to.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FORM AND NOT A DIV WITH A BUTTON
 * ---------------------------------------------------------------------------
 *
 * A single text field with one action is exactly the case where a user presses
 * Enter. Without a <form> that does nothing, and the failure is silent — the
 * user types, hits Enter, and the screen sits there. `onSubmit` gets Enter and
 * the button click through one path, so the two can never diverge.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE ERROR APPEARS
 * ---------------------------------------------------------------------------
 *
 * Not on every keystroke. Validating as the user types means the field turns
 * red at "a", stays red through "ali@", and only relents at the very end — the
 * form scolds someone for not having finished typing yet. The check runs on
 * submit and on blur, and once an error IS showing, editing clears it
 * immediately rather than making the reader submit again to find out whether
 * they fixed it.
 */

/**
 * Deliberately permissive: something, an @, something, a dot, something.
 *
 * The authoritative test of an address is whether the code arrives at it, and
 * that happens on the server. A stricter client-side pattern buys nothing and
 * reliably rejects real addresses — plus-tagging, long TLDs, non-ASCII local
 * parts. Refusing a learner's valid address is a much worse failure than
 * letting a typo through to a "لم يصلك الرمز؟" that already exists.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateEmail(value) {
  const trimmed = value.trim();
  if (trimmed === '') return 'يُرجى إدخال بريدك الإلكتروني.';
  if (!EMAIL_PATTERN.test(trimmed)) {
    return 'يبدو أن هذا البريد الإلكتروني غير صحيح. تحقّق منه ثم حاول مجددًا.';
  }
  return null;
}

export default function EmailStep({ email, onEmailChange, onSubmit, error, onError, pending }) {
  const handleSubmit = (event) => {
    event.preventDefault();
    const message = validateEmail(email);
    if (message) {
      onError(message);
      return;
    }
    onSubmit(email.trim());
  };

  const describedBy = error ? 'auth-email-error' : undefined;

  return (
    <form onSubmit={handleSubmit} noValidate>
      <h1 className="text-xl font-bold leading-snug text-text-main sm:text-2xl">
        مرحبًا بك في منصة EduNext
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">
        أدخل بريدك الإلكتروني لتلقي رمز التحقق
      </p>

      <div className="mt-7">
        <label htmlFor="auth-email" className="block text-sm font-medium text-text-main">
          البريد الإلكتروني
        </label>

        {/*
          The icon is positioned with `start-4`, not `left-4`. In this RTL
          layout that resolves to the right — the side the field is read FROM —
          and the input is padded with `ps-12` to match. A physical `left-4`
          here would look correct in an LTR preview and sit on the wrong side of
          the real product.
        */}
        <div className="relative mt-2">
          <Mail
            className="pointer-events-none absolute start-4 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted"
            aria-hidden="true"
          />
          <input
            id="auth-email"
            name="email"
            type="email"
            value={email}
            onChange={(event) => {
              onEmailChange(event.target.value);
              // An error that survives the fix it was asking for is noise.
              if (error) onError(null);
            }}
            onBlur={() => {
              if (email.trim() !== '') onError(validateEmail(email));
            }}
            /*
             * `dir="ltr"` on the field itself: an email address is a
             * left-to-right string, and typing one into an RTL input puts the
             * caret and the @ in places that look broken. `text-start` then
             * aligns it to the left within its own LTR context, so the field
             * still reads naturally inside the Arabic form.
             */
            dir="ltr"
            inputMode="email"
            autoComplete="email"
            spellCheck="false"
            placeholder="name@example.com"
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={describedBy}
            disabled={pending}
            className={[
              'h-12 w-full rounded-full border bg-surface ps-12 pe-4 text-sm text-text-main',
              'placeholder:text-text-muted/70 transition-colors duration-200',
              'disabled:opacity-60',
              // The palette has no danger token yet, so this is Tailwind's
              // default red. It should become `border-danger` the moment the
              // token task lands — flagged rather than quietly invented here.
              error ? 'border-red-400' : 'border-accent-subtle focus:border-primary',
            ].join(' ')}
          />
        </div>

        {error ? (
          <p id="auth-email-error" role="alert" className="mt-2 text-xs text-red-600">
            {error}
          </p>
        ) : null}
      </div>

      <Button type="submit" withArrow disabled={pending} className="mt-6 w-full">
        {pending ? 'جارٍ الإرسال…' : 'إرسال رمز التحقق'}
      </Button>
    </form>
  );
}
