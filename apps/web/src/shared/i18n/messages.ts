import type { Locale } from './locale.ts';

/**
 * Message catalogues.
 *
 * The Arabic catalogue is the source of truth: `MessageKey` is derived from it,
 * so adding an Arabic string without an English one is a type error (and vice
 * versa). A real translation pipeline replaces this later; the important part
 * for the foundation is that lookups are typed and that no component contains a
 * hard-coded user-visible string.
 */
const ar = {
  'app.title': 'منصة التعلم',
  'app.tagline': 'تعلّم، استقصِ، جرّب، وطبّق',
  'health.checking': 'جارٍ التحقق من حالة الخدمة…',
  'health.ok': 'الخدمة تعمل',
  'health.unavailable': 'تعذّر الوصول إلى الخدمة',
  'language.switch': 'English',
  'attempt.loading': 'جارٍ التحميل…',
  'attempt.unavailable': 'تعذّر عرض هذه المحاولة',
  'attempt.inProgress': 'المحاولة قيد التنفيذ',
  'attempt.resultWithheld': 'لم تُعلَن النتيجة بعد. سيعلنها معلّمك.',
  'attempt.passed': 'ناجح',
  'attempt.failed': 'لم تجتز',
  'review.notReleased': 'ستظهر الإجابات الصحيحة بعد إعلان النتيجة.',
  'review.correct': 'إجابة صحيحة',
  'review.incorrect': 'إجابة غير صحيحة',
  'release.action': 'إعلان النتيجة',
  'release.comment': 'ملاحظة للطالب (اختياري)',
  'release.pending': 'جارٍ الإعلان…',
  'release.done': 'أُعلنت النتيجة',
  'release.failed': 'تعذّر إعلان النتيجة',
  'mastery.loading': 'جارٍ تحميل التقدّم…',
  'mastery.unavailable': 'تعذّر عرض التقدّم',
  'mastery.heading': 'الأهداف التعليمية',
  'mastery.objectivesDemonstrated': 'أهداف مُثبَتة',
  'mastery.lessonsCompleted': 'دروس مكتملة',
  'mastery.evidenceCount': 'عدد الأدلة',
  'mastery.state.no_evidence': 'لا توجد أدلة بعد',
  'mastery.state.attempted': 'بدأ التعلّم',
  'mastery.state.developing': 'قيد التطوّر',
  'mastery.state.demonstrated': 'مُثبَت',
  'mastery.state.mastered': 'مُتقَن',
  'mastery.lesson.not_started': 'لم يبدأ',
  'mastery.lesson.in_progress': 'قيد التقدّم',
  'mastery.lesson.completed': 'مكتمل',
} as const;

export type MessageKey = keyof typeof ar;

const en: Record<MessageKey, string> = {
  'app.title': 'Learning Platform',
  'app.tagline': 'Learn, investigate, experiment, and apply',
  'health.checking': 'Checking service status…',
  'health.ok': 'Service is running',
  'health.unavailable': 'Service is unreachable',
  'language.switch': 'العربية',
  'attempt.loading': 'Loading…',
  'attempt.unavailable': 'This attempt cannot be shown',
  'attempt.inProgress': 'Attempt in progress',
  'attempt.resultWithheld': 'Your result has not been released yet. Your teacher will release it.',
  'attempt.passed': 'Passed',
  'attempt.failed': 'Not passed',
  'review.notReleased': 'The correct answers appear once your result is released.',
  'review.correct': 'Correct',
  'review.incorrect': 'Incorrect',
  'release.action': 'Release result',
  'release.comment': 'Note for the learner (optional)',
  'release.pending': 'Releasing…',
  'release.done': 'Result released',
  'release.failed': 'The result could not be released',
  'mastery.loading': 'Loading progress…',
  'mastery.unavailable': 'Progress cannot be shown',
  'mastery.heading': 'Learning objectives',
  'mastery.objectivesDemonstrated': 'objectives demonstrated',
  'mastery.lessonsCompleted': 'lessons completed',
  'mastery.evidenceCount': 'pieces of evidence',
  'mastery.state.no_evidence': 'No evidence yet',
  'mastery.state.attempted': 'Started',
  'mastery.state.developing': 'Developing',
  'mastery.state.demonstrated': 'Demonstrated',
  'mastery.state.mastered': 'Mastered',
  'mastery.lesson.not_started': 'Not started',
  'mastery.lesson.in_progress': 'In progress',
  'mastery.lesson.completed': 'Completed',
};

const CATALOGUES: Record<Locale, Record<MessageKey, string>> = { ar, en };

export function translate(locale: Locale, key: MessageKey): string {
  // Falls back to Arabic rather than to the key itself: showing a raw
  // identifier to a student is worse than showing the default language.
  return CATALOGUES[locale][key] ?? CATALOGUES.ar[key];
}
