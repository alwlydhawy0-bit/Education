/**
 * The academic profile options.
 *
 * ---------------------------------------------------------------------------
 * IDS ARE LATIN, LABELS ARE ARABIC, AND THE DISTINCTION MATTERS
 * ---------------------------------------------------------------------------
 *
 * What gets STORED is `university`, never "مرحلة جامعية". A stored Arabic label
 * is a label that can never be reworded — every saved profile would have to be
 * migrated to fix a typo — and it cannot be matched against anything without
 * exact string equality over text that has several legitimate spellings
 * (ـة vs ـه, with or without diacritics). The id is the value; the label is the
 * presentation of it.
 *
 * ---------------------------------------------------------------------------
 * EVERY LIST HAS AN HONEST ESCAPE HATCH
 * ---------------------------------------------------------------------------
 *
 * "عام / غير محدّد" and "متعلّمة مستقلّة" exist because a required dropdown with
 * no option that fits is a form that teaches people to lie to it. A learner who
 * is not in formal education, or whose major is not listed, has somewhere true
 * to put themselves — which keeps the data worth reading later.
 */
export const STAGES = [
  { id: 'unset', label: 'لم تُحدَّد بعد' },
  { id: 'postgraduate', label: 'دراسات عليا' },
  { id: 'university', label: 'مرحلة جامعية' },
  { id: 'secondary', label: 'ثانوي' },
  { id: 'intermediate', label: 'متوسط' },
  { id: 'vocational', label: 'تدريب مهني' },
  { id: 'independent', label: 'متعلّمة مستقلّة' },
];

export const MAJORS = [
  { id: 'unset', label: 'لم يُحدَّد بعد' },
  { id: 'cs', label: 'علوم حاسب' },
  { id: 'it', label: 'تقنية معلومات' },
  { id: 'se', label: 'هندسة برمجيات' },
  { id: 'data', label: 'علوم بيانات' },
  { id: 'design', label: 'تصميم وتجربة مستخدم' },
  { id: 'general', label: 'عام / غير محدّد' },
];

/** The profile a brand-new account starts with: declared, not guessed. */
export const DEFAULT_ACADEMIC = { stage: 'unset', major: 'unset' };

const labelFrom = (options, id) => options.find((option) => option.id === id)?.label ?? null;

/**
 * The one-line summary shown in the header.
 *
 * Returns `null` rather than a placeholder string when nothing is set, so the
 * caller decides what an empty profile looks like. A function that invents
 * "غير محدّد" here would put that text in the header of every new account,
 * where it reads as a defect rather than as an invitation.
 */
export function academicSummary(academic) {
  if (!academic) return null;
  const stage = academic.stage === 'unset' ? null : labelFrom(STAGES, academic.stage);
  const major = academic.major === 'unset' ? null : labelFrom(MAJORS, academic.major);
  if (stage && major) return `${stage} · ${major}`;
  return stage ?? major;
}

export { labelFrom };
