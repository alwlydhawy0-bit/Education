import { BarChart3, BookOpen, FileText, Home, Layers, Settings, User } from 'lucide-react';

/**
 * The navigation, defined ONCE.
 *
 * The sidebar and the mobile bottom bar show overlapping subsets of the same
 * destinations. If each held its own list, the two would drift the first time a
 * label was reworded — and the failure is invisible on a desktop review, because
 * only one of the two is on screen at a time.
 *
 * `inBottomNav` selects the five that fit a phone bar. It is a property of the
 * item rather than a second array, so adding a destination is one edit and
 * cannot leave the two navigations disagreeing about what a page is called.
 */
export const NAV_ITEMS = [
  { id: 'dashboard', label: 'الرئيسية', Icon: Home, inBottomNav: true },
  { id: 'courses', label: 'دوراتي', Icon: Layers, inBottomNav: true },
  { id: 'library', label: 'المكتبة', Icon: BookOpen, inBottomNav: true },
  { id: 'exams', label: 'الاختبارات', Icon: FileText, inBottomNav: false },
  { id: 'reports', label: 'التقارير', Icon: BarChart3, inBottomNav: true },
  {
    id: 'profile',
    label: 'الملف الشخصي',
    // A phone bar gives each of five items about 70px. "الملف الشخصي" does not
    // fit and CSS answers that with an ellipsis — "الملف الش…" — which is a
    // label nobody wrote. `shortLabel` makes the compromise a DECISION, taken
    // once, next to the full label it replaces, instead of an accident of
    // available width.
    shortLabel: 'حسابي',
    Icon: User,
    inBottomNav: true,
  },
];

/**
 * Settings is separate on purpose.
 *
 * It sits at the foot of the sidebar, away from the six destinations, because
 * it is not a place you go to study — it is a place you go to change how the
 * product behaves. The reference design separates it the same way.
 */
export const SETTINGS_ITEM = { id: 'settings', label: 'الإعدادات', Icon: Settings };

export const BOTTOM_NAV_ITEMS = NAV_ITEMS.filter((item) => item.inBottomNav);
