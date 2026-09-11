import { BookOpen, Compass, Home, User } from 'lucide-react';

/**
 * The navigation, defined ONCE.
 *
 * The sidebar and the mobile bottom bar show overlapping subsets of the same
 * destinations. If each held its own list, the two would drift the first time a
 * label was reworded — and the failure is invisible on a desktop review,
 * because only one of the two is on screen at a time.
 *
 * ---------------------------------------------------------------------------
 * EVERY ITEM NOW CARRIES A REAL PATH
 * ---------------------------------------------------------------------------
 *
 * These used to be opaque ids fed to a `useState`. They are URLs now, and that
 * changes what a mistake costs: an id that matched nothing merely failed to
 * highlight a row, while a path that matches no route renders a blank page.
 *
 * THE LIST IS SHORTER THAN IT WAS, DELIBERATELY. "المكتبة", "الاختبارات" and
 * "التقارير" were in this file before there were routes, back when tapping one
 * only moved a highlight. There is no page behind any of them, and a navigation
 * item that leads nowhere is worse than an absent one — the visitor blames the
 * app, not the roadmap. They come back the moment they have somewhere to go.
 *
 * ---------------------------------------------------------------------------
 * `requiresAuth` DESCRIBES THE DESTINATION, NOT THE VISITOR
 * ---------------------------------------------------------------------------
 *
 * Under the freemium model almost everything is public. Marking the exception
 * here — rather than filtering the array in each navigation — means the sidebar
 * and the bottom bar cannot disagree about whether a guest may see a row, and
 * the answer sits next to the label it belongs to.
 */
export const NAV_ITEMS = [
  { id: 'home', label: 'الرئيسية', path: '/', Icon: Home, inBottomNav: true },
  { id: 'courses', label: 'الدورات', path: '/courses', Icon: Compass, inBottomNav: true },
  { id: 'about', label: 'عن المنصة', path: '/about', Icon: BookOpen, inBottomNav: true },
  {
    id: 'profile',
    label: 'الملف الشخصي',
    path: '/profile',
    // A phone bar gives each item about 70px. "الملف الشخصي" does not fit and
    // CSS answers that with an ellipsis — "الملف الش…" — a label nobody wrote.
    // `shortLabel` makes the compromise a DECISION, taken once, next to the
    // full label it replaces, instead of an accident of available width.
    shortLabel: 'حسابي',
    Icon: User,
    inBottomNav: true,
    // Shown to everyone: a guest who taps it gets the page's own "you are
    // browsing as a guest" state, which is a better answer than a row that
    // vanishes and leaves them wondering where their account went.
    requiresAuth: false,
  },
];

export const BOTTOM_NAV_ITEMS = NAV_ITEMS.filter((item) => item.inBottomNav);
