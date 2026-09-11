import { useEffect, useState } from 'react';
import { Bell, LogIn, Moon, Search, Settings, Sun } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/useAuth.js';

/**
 * The top bar: who you are, what you are looking for, and what you can change.
 *
 * LAYOUT, IN RTL TERMS. Three regions in source order — greeting, search,
 * actions — which RTL lays out right, centre, left. That is the arrangement the
 * brief specifies, and it needs no positioning: `justify-between` with a
 * centre child that grows does all of it.
 *
 * The search field is `flex-1` with a `max-w-xl` ceiling rather than a fixed
 * width, so it fills a wide monitor without becoming a 900px input on one.
 */
export default function Header() {
  const { user, isAuthenticated } = useAuth();

  return (
    <header className="flex h-auto shrink-0 flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap sm:gap-4 sm:px-6">
      {/* الهوية: حساب أو زائرة */}
      {isAuthenticated ? <MemberIdentity user={user} /> : <GuestIdentity />}

      {/* البحث */}
      <SearchField />

      {/* الإجراءات */}
      <div className="flex items-center gap-1 sm:gap-2">
        {/*
          THE BELL AND THE SETTINGS DOOR ARE MEMBERS-ONLY, and not because a
          guest must be kept out of them — a guest simply has no notifications
          and no account to configure. Rendering them anyway would be two
          controls that do nothing, which reads as a broken product rather than
          as a locked one. The single "تسجيل الدخول" button in their place is
          the one thing a guest might actually want from this corner.
        */}
        {isAuthenticated ? (
          <>
            <NotificationBell count={user.unreadCount} />
            <ThemeToggle />
            <Link
              to="/profile"
              aria-label="الإعدادات"
              title="الإعدادات"
              className="flex h-10 w-10 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-primary-light hover:text-primary"
            >
              <Settings className="h-[18px] w-[18px]" aria-hidden="true" />
            </Link>
          </>
        ) : (
          <>
            <ThemeToggle />
            <SignInButton />
          </>
        )}
      </div>
    </header>
  );
}

/** The signed-in learner: avatar, name, role. */
function MemberIdentity({ user }) {
  return (
    <Link to="/profile" className="flex min-w-0 items-center gap-3 rounded-full">
      <Avatar name={user.name} src={user.avatarUrl} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold leading-tight text-text-main">
          مرحبًا، {user.name}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted">
          {/* The dot is decorative; the word "طالبة" already carries the status,
              so marking it aria-hidden avoids a second announcement of nothing. */}
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          {user.role}
        </span>
      </span>
    </Link>
  );
}

/**
 * The guest's greeting.
 *
 * It names the mode rather than leaving the corner empty. "تتصفّحين كزائرة"
 * tells a visitor why their progress is missing from the dashboard, which is
 * the question the page would otherwise raise and not answer.
 */
function GuestIdentity() {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-alt text-sm font-semibold text-text-muted"
        aria-hidden="true"
      >
        ز
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold leading-tight text-text-main">
          أهلًا بك في EduNext
        </span>
        <span className="mt-0.5 block truncate text-xs text-text-muted">تتصفّحين كزائرة</span>
      </span>
    </div>
  );
}

/**
 * The guest's call to action.
 *
 * It carries the CURRENT location in router state, exactly as
 * `useGuardedAction` does, so signing in from the header returns the visitor to
 * the page they were reading instead of dropping them on the home screen.
 */
function SignInButton() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <button
      type="button"
      onClick={() => navigate('/login', { state: { from: location } })}
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-white shadow-soft transition-colors duration-200 hover:bg-primary-hover"
    >
      <span>تسجيل الدخول</span>
      <LogIn className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

/**
 * The search input.
 *
 * `ps-10` — padding-inline-START — is what reserves room for the icon, and the
 * icon is placed with `start-3`. Both flip with the direction, so the icon sits
 * on the right in Arabic and would sit on the left in an English build with no
 * second rule. `pl-10` + `left-3` would look correct here and be wrong the
 * moment anything renders LTR.
 */
function SearchField() {
  const navigate = useNavigate();

  /*
   * THIS INPUT USED TO DO NOTHING, AND THE CATALOGUE PAGE MADE THAT VISIBLE.
   *
   * It was decorative while there was one screen. Now `/courses` has its own,
   * working search field — so on that page two identical-looking boxes sat one
   * above the other and only the lower one responded. Observed in the browser:
   * two `input[type=search]` elements on `/courses`, one in the header and one
   * in the page. A control that looks like the real thing and silently ignores
   * you is worse than no control.
   *
   * Submitting now navigates to the catalogue with the query in the URL, which
   * is also what makes a filtered view shareable and restorable by Back — the
   * limitation the catalogue page previously had to document as accepted.
   *
   * It is a <form> so the Enter key works. A bare input with an onKeyDown
   * handler would need to special-case Enter, IME composition and the mobile
   * "go" key by hand; the platform already does all three.
   */
  const submit = (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get('q')?.toString().trim() ?? '';
    navigate(query === '' ? '/courses' : `/courses?q=${encodeURIComponent(query)}`);
  };

  return (
    <form
      role="search"
      onSubmit={submit}
      className="relative order-last w-full sm:order-none sm:mx-auto sm:max-w-xl sm:flex-1"
    >
      <Search
        className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
        aria-hidden="true"
      />
      <input
        type="search"
        name="q"
        // `search` inputs get a browser-drawn clear button that ignores the
        // design; the label stays invisible-but-present for assistive tech.
        aria-label="ابحث عن الدورات أو الدروس"
        placeholder="ابحث عن الدورات أو الدروس..."
        className="h-11 w-full rounded-full border border-accent-subtle bg-surface ps-10 pe-4 text-sm text-text-main placeholder:text-text-muted focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
    </form>
  );
}

/**
 * The bell, and the number nobody reads aloud.
 *
 * The dot is positioned with `end-*` so it sits on the badge's trailing corner
 * in either direction. The count is in the accessible name rather than in the
 * dot, because a screen reader announcing "circle" helps no one.
 */
function NotificationBell({ count = 0 }) {
  const hasUnread = count > 0;
  return (
    <IconButton
      label={hasUnread ? `الإشعارات، ${count} غير مقروءة` : 'الإشعارات'}
      className="relative"
    >
      <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
      {hasUnread ? (
        <span
          className="absolute end-2 top-2 h-2 w-2 rounded-full bg-primary ring-2 ring-canvas"
          aria-hidden="true"
        />
      ) : null}
    </IconButton>
  );
}

/**
 * Theme toggle.
 *
 * The mechanism is real: it flips `dark` on <html>, honours the operating
 * system preference on first load, and remembers a deliberate choice. Tailwind
 * is configured with `darkMode: 'class'` so `dark:` variants resolve from it.
 *
 * WHAT IT DOES NOT DO YET, said plainly: the dark palette is not part of this
 * task. No `dark:` token exists, so today the visible effect is the icon
 * changing. That is the honest half-step — the alternative is a button that is
 * wired to nothing at all, which is harder to finish later because there is no
 * seam to finish.
 */
function ThemeToggle() {
  const [isDark, setIsDark] = useState(() => {
    if (typeof window === 'undefined') return false;
    const stored = window.localStorage.getItem('edunext:theme');
    if (stored) return stored === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    window.localStorage.setItem('edunext:theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  return (
    <IconButton
      label={isDark ? 'التبديل إلى الوضع الفاتح' : 'التبديل إلى الوضع الداكن'}
      aria-pressed={isDark}
      onClick={() => setIsDark((value) => !value)}
    >
      {isDark ? (
        <Sun className="h-[18px] w-[18px]" aria-hidden="true" />
      ) : (
        <Moon className="h-[18px] w-[18px]" aria-hidden="true" />
      )}
    </IconButton>
  );
}

/**
 * An icon-only control.
 *
 * `aria-label` is not optional here: an icon button with no text has no
 * accessible name, and a row of four of them reads as four unlabelled buttons.
 * Making the label a required-in-practice prop is what stops that being
 * forgotten in the next component that copies this one.
 */
function IconButton({ label, className = '', children, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[
        'flex h-10 w-10 items-center justify-center rounded-full text-text-muted',
        'transition-colors duration-200 hover:bg-primary-light hover:text-primary',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The avatar, with a real fallback.
 *
 * An <img> whose src fails renders as a broken-image glyph — in a circle, at
 * the top of every page. The initial is what shows instead, and it is derived
 * from the name rather than stored, so it cannot go stale.
 */
function Avatar({ name, src }) {
  const [failed, setFailed] = useState(false);
  const initial = name?.trim()?.[0] ?? '؟';

  if (!src || failed) {
    return (
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-light text-sm font-semibold text-primary"
        aria-hidden="true"
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      onError={() => setFailed(true)}
      className="h-10 w-10 shrink-0 rounded-full border border-accent-subtle object-cover"
    />
  );
}
