import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Compass,
  Home,
  LogIn,
  LogOut,
  NotebookPen,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { useAuth } from '../../auth/useAuth.js';

/**
 * The navigation drawer behind the header's menu button.
 *
 * ---------------------------------------------------------------------------
 * THE TWO TOOL ROWS ARE THE WHOLE DESIGN PROBLEM
 * ---------------------------------------------------------------------------
 *
 * "المساعد الذكي" and "دفتر الملاحظات" are not destinations, and they are not
 * global. Both are scoped to ONE course: the notebook writes to
 * `edunext:notes:<courseId>`, the annotator to `edunext:doc:<courseId>`, and
 * every answer the assistant gives is grounded in the course it was opened
 * from. This drawer, however, opens from a header that is on every page.
 *
 * The tempting shortcut is to open them anyway against some default course.
 * That produces a notebook whose notes land under a course the learner never
 * opened, and an assistant citing lessons from material they are not reading —
 * both of which look like working features and are worse than a missing one.
 *
 * So the rows are HONEST about needing a subject:
 *
 *   - On a course page, the row opens THAT course's tool, by putting
 *     `?tool=assistant` (or `notes`) on the URL. The course page owns the
 *     modal and reads the parameter, so the drawer never has to reach across
 *     the tree into a component it does not own — and the resulting URL is
 *     shareable and survives a reload.
 *
 *   - Anywhere else the row says "اختاري دورة أولًا" and goes to the
 *     catalogue. It stays visible rather than disappearing, because a tool the
 *     learner has used before should not silently vanish from the menu; what
 *     it must not do is pretend.
 *
 * ---------------------------------------------------------------------------
 * PORTALLED, FOR THE REASON THE ASSISTANT PANEL WAS
 * ---------------------------------------------------------------------------
 *
 * The header sits inside the layout's flex column. Any ancestor that ever gains
 * a `transform`, a `filter` or its own z-index would trap a `fixed` overlay
 * rendered from here — which is exactly how the assistant panel ended up
 * underneath the mobile bottom bar, invisible to every test that did not check
 * `elementFromPoint`. Rendering into `document.body` removes the whole class of
 * bug rather than the current instance of it.
 */
export default function MobileMenuDrawer({ open, onClose }) {
  const { isAuthenticated, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const panelRef = useRef(null);
  const closeRef = useRef(null);

  /*
   * A course id, or null. `useParams` is unavailable here — this component
   * renders from the layout, outside the matched route — so the path is read
   * directly. The shape is fixed by `routes/index.jsx`.
   */
  const courseId = location.pathname.match(/^\/courses\/([^/]+)/)?.[1] ?? null;

  /* Escape, focus trap, focus restore — the three things a dialog owes. */
  useEffect(() => {
    if (!open) return undefined;

    const panel = panelRef.current;
    const returnTo = document.activeElement;
    closeRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = panel?.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);

      /*
       * RESTORE FOCUS WHEN IT WAS RELEASED, NOT ONLY WHEN IT IS STILL INSIDE.
       *
       * The obvious guard — "is `activeElement` still within the panel?" — is
       * false by the time this runs: the focused row has already been removed
       * from the document, and the browser has fallen back to `<body>`. So the
       * check never fired and the drawer closed with focus dumped at the top of
       * the page, which for a keyboard user means tabbing through the whole
       * header again. Measured, not reasoned about: the probe read `BODY`.
       *
       * Treating body/null as "released" restores correctly, while still
       * leaving focus alone when a row deliberately moved it by navigating.
       */
      const active = document.activeElement;
      const released = active === null || active === document.body;
      if (returnTo instanceof HTMLElement && (released || panel?.contains(active))) {
        returnTo.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  const go = (to) => {
    onClose();
    navigate(to);
  };

  const openTool = (tool) => {
    if (courseId) go(`/courses/${courseId}?tool=${tool}`);
    else go('/courses');
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex" role="presentation">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-text-main/30 backdrop-blur-[2px] motion-safe:animate-step-in"
      />

      {/* `me-auto` pins the drawer to the inline START — the right, in RTL. */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        className="relative me-auto flex h-full w-[19rem] max-w-[85vw] flex-col border-s border-accent-subtle bg-surface shadow-lift motion-safe:animate-step-in"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-accent-subtle px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary">
              <BookOpen className="h-4 w-4 text-on-primary" aria-hidden="true" />
            </span>
            <p id="drawer-title" className="text-sm font-semibold text-text-main">
              القائمة
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="إغلاق القائمة"
            className="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors duration-200 hover:bg-surface-alt hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <Section title="التنقّل">
            <RowLink to="/" Icon={Home} label="الرئيسية" onNavigate={onClose} />
            <RowLink to="/courses" Icon={Compass} label="كتالوج الدورات" onNavigate={onClose} />
            <RowLink to="/about" Icon={BookOpen} label="عن المنصة" onNavigate={onClose} />
          </Section>

          <Section title="الأدوات التفاعلية">
            <RowButton
              Icon={Sparkles}
              label="المساعد الذكي"
              hint={courseId ? null : 'اختاري دورة أولًا'}
              onClick={() => openTool('assistant')}
            />
            <RowButton
              Icon={NotebookPen}
              label="دفتر الملاحظات والرسومات"
              hint={courseId ? null : 'اختاري دورة أولًا'}
              onClick={() => openTool('notes')}
            />
          </Section>

          <Section title="الحساب والبيانات">
            <RowLink
              to="/profile"
              Icon={User}
              label="الملف الشخصي والمرحلة الدراسية"
              onNavigate={onClose}
            />
            {isAuthenticated ? (
              <RowButton
                Icon={LogOut}
                label="تسجيل الخروج"
                tone="danger"
                onClick={() => {
                  signOut();
                  onClose();
                  navigate('/');
                }}
              />
            ) : (
              <RowButton
                Icon={LogIn}
                label="تسجيل الدخول"
                tone="primary"
                onClick={() => {
                  onClose();
                  navigate('/login', { state: { from: location } });
                }}
              />
            )}
          </Section>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function Section({ title, children }) {
  return (
    <section className="mb-4 last:mb-0">
      <h2 className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </h2>
      <ul className="flex flex-col gap-0.5">{children}</ul>
    </section>
  );
}

const ROW =
  'flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-start text-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';

function RowLink({ to, Icon, label, onNavigate }) {
  const { pathname } = useLocation();
  // `end` semantics by hand: "/" would otherwise match every path.
  const active = to === '/' ? pathname === '/' : pathname.startsWith(to);

  return (
    <li>
      <Link
        to={to}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={`${ROW} ${
          active
            ? 'bg-primary-light font-medium text-primary'
            : 'text-text-main hover:bg-surface-alt'
        }`}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Link>
    </li>
  );
}

function RowButton({ Icon, label, hint, onClick, tone = 'plain' }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`${ROW} ${
          tone === 'danger'
            ? 'text-danger hover:bg-surface-alt'
            : tone === 'primary'
              ? 'font-medium text-primary hover:bg-primary-light'
              : 'text-text-main hover:bg-surface-alt'
        }`}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {/*
            The hint is part of the accessible name by being inside the button,
            so a screen reader hears "المساعد الذكي، اختاري دورة أولًا" rather
            than a bare label that promises more than the row delivers.
          */}
          {hint ? <span className="mt-0.5 block text-[11px] text-text-muted">{hint}</span> : null}
        </span>
      </button>
    </li>
  );
}
