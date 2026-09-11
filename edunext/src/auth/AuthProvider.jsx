import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_ACADEMIC } from '../data/academic.js';
import { AuthContext } from './context.js';

/**
 * Who is looking at the app, and what that permits.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL CHANGED: GUEST IS NOW A FIRST-CLASS VISITOR
 * ---------------------------------------------------------------------------
 *
 * Authentication used to be a wall in front of the product — `App` rendered the
 * login screen or the dashboard, and nothing else existed. It is now a
 * PROPERTY of the visitor. Every page renders for everyone; what changes is
 * which ACTIONS are available and whose numbers are shown.
 *
 * That inverts where the check lives. A wall is checked once, at the door. A
 * property has to be checked at each action that depends on it, which is more
 * places and therefore easier to forget one — so the check is packaged as
 * `useGuardedAction` below rather than left as an `if` for each call site to
 * write correctly.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECURITY BOUNDARY, AND THE FREEMIUM MODEL MAKES THAT SHARPER
 * ---------------------------------------------------------------------------
 *
 * `isAuthenticated` decides what is RENDERED and which buttons act. It protects
 * no data, because client state is editable by whoever holds the browser.
 *
 * Under the old all-or-nothing model that was a footnote. It is not one now: a
 * catalogue that is public by design will grow paid lesson CONTENT behind these
 * same flags, and a flag flipped in a console must not hand anyone a paid
 * lesson. The rule that keeps this honest is that the client never holds
 * content the visitor has not earned — the server decides what to send, and
 * these flags only decide how to ask. `free: true` in the syllabus data marks a
 * preview the server would serve to anyone; everything else is a request the
 * server is expected to refuse for a guest.
 */
/** The signed-in demo learner. Replaced by the server's session response. */
const DEMO_USER = {
  name: 'ريهام',
  role: 'طالبة',
  email: 'reham@example.com',
  unreadCount: 1,
  avatarUrl: null,
  memberSince: 'مارس 2025',
  academic: DEFAULT_ACADEMIC,
  certificates: [
    { id: 'c1', title: 'أساسيات تحليل البيانات — الوحدة الأولى', issuedAt: 'مايو 2025' },
    { id: 'c2', title: 'مقدمة في تصميم الواجهات', issuedAt: 'يوليو 2025' },
  ],
};

/**
 * THE SESSION HAS TO SURVIVE A RELOAD, AND THAT ONLY BECAME OBVIOUS WITH ROUTES.
 *
 * While the app had a single URL there was no reason to reload it, so holding
 * the session in memory cost nothing. Real paths change that completely: a
 * refresh, a bookmark, a shared link and the browser's Back button are all
 * ordinary now, and every one of them re-mounts the tree. Without persistence a
 * signed-in learner who presses F5 is silently a guest again — which was
 * observed in the browser rather than reasoned about: navigating to `/profile`
 * as a hard load rendered the guest state while the header still said "مرحبًا،
 * ريهام" a moment earlier.
 *
 * WHAT IS STORED IS A MARKER, NOT A CREDENTIAL. It says "this browser had a
 * session"; it is not a token and grants nothing. In the real product the
 * session is an HttpOnly cookie the server sets — unreadable to JavaScript by
 * design — and on boot the app would ask the server who it is talking to, with
 * this flag deciding only whether that request is worth making. Writing an
 * actual token here would undo the entire reason the cookie is HttpOnly.
 *
 * `sessionStorage` rather than `localStorage`: a demo session that outlives the
 * tab is a session nobody asked to keep, and on a shared machine that is the
 * wrong default.
 */
const SESSION_KEY = 'edunext:session';

/**
 * THE ACADEMIC PROFILE IS STORED SEPARATELY FROM THE SESSION MARKER.
 *
 * The marker is a boolean fact about this browser. The academic profile is
 * DATA, and keeping the two apart means the shapes cannot be confused: reading
 * a corrupt profile can never be mistaken for "there is a session", and a
 * failure to parse it degrades to the defaults rather than to a signed-out
 * visitor staring at a login screen they did not ask for.
 *
 * These are preferences, not credentials, so persisting them in the clear is
 * fine — which is exactly why the session marker next to them is NOT a token.
 * On a real backend this comes from the profile endpoint and this key becomes
 * a cache of it.
 */
const ACADEMIC_KEY = 'edunext:academic';

function readStoredAcademic() {
  try {
    const raw = window.sessionStorage.getItem(ACADEMIC_KEY);
    if (!raw) return DEFAULT_ACADEMIC;
    const parsed = JSON.parse(raw);
    /*
     * Read defensively. This value survives a reload, so a build that renames
     * a field leaves the OLD shape in a returning visitor's browser — and
     * `academic.stage` coming back `undefined` would render an empty select
     * with no selected option, which looks like the page failed to load.
     * Falling back per field keeps a partial profile usable.
     */
    return {
      stage: typeof parsed?.stage === 'string' ? parsed.stage : DEFAULT_ACADEMIC.stage,
      major: typeof parsed?.major === 'string' ? parsed.major : DEFAULT_ACADEMIC.major,
    };
  } catch {
    return DEFAULT_ACADEMIC;
  }
}

function readStoredSession() {
  try {
    if (window.sessionStorage.getItem(SESSION_KEY) !== 'active') return null;
    return { ...DEMO_USER, academic: readStoredAcademic() };
  } catch {
    // Private browsing and locked-down enterprise profiles both throw on
    // access rather than returning null. A storage failure must degrade to
    // "signed out", never to a crash on the first paint.
    return null;
  }
}

export function AuthProvider({ children, initialUser = null }) {
  const [user, setUser] = useState(() => initialUser ?? readStoredSession());

  const signIn = useCallback(() => setUser({ ...DEMO_USER, academic: readStoredAcademic() }), []);
  const signOut = useCallback(() => setUser(null), []);

  /**
   * Update one or both academic fields.
   *
   * It takes a PATCH rather than the whole object so the two selects can be
   * independent controls without either having to know the other's current
   * value — `updateAcademic({ stage })` cannot accidentally blank the major,
   * which is exactly what passing a full object from a stale closure would do.
   */
  const updateAcademic = useCallback((patch) => {
    setUser((current) =>
      current === null ? current : { ...current, academic: { ...current.academic, ...patch } },
    );
  }, []);

  useEffect(() => {
    try {
      if (user) {
        window.sessionStorage.setItem(SESSION_KEY, 'active');
        window.sessionStorage.setItem(ACADEMIC_KEY, JSON.stringify(user.academic));
      } else {
        window.sessionStorage.removeItem(SESSION_KEY);
        /*
         * The profile goes with the session. It describes the person who just
         * left, and on a shared machine the next visitor must not inherit it —
         * a signed-out browser showing "دراسات عليا · علوم بيانات" tells them
         * something about someone else.
         */
        window.sessionStorage.removeItem(ACADEMIC_KEY);
      }
    } catch {
      // Persisting is a convenience; failing to persist must not break the app.
      // The session then simply lasts as long as the page does.
    }
  }, [user]);

  /*
   * Memoised so the value identity is stable between renders. Without it every
   * render of the provider hands every consumer a new object and re-renders the
   * whole tree — the standard context performance trap, and the reason this is
   * worth three lines rather than an inline literal.
   */
  const value = useMemo(
    () => ({ user, isAuthenticated: user !== null, signIn, signOut, updateAcademic }),
    [user, signIn, signOut, updateAcademic],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
