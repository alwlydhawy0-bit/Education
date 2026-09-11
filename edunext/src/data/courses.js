import { Code2, LineChart, Palette } from 'lucide-react';

/**
 * The course catalogue, defined ONCE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Three screens now show the same courses: the dashboard's "الدورات الحالية"
 * grid, the `/courses` catalogue, and `/courses/:id`. Before this file, the
 * dashboard grid held its own array — and the moment a second screen copied it,
 * a retitled course would appear under two different names depending on which
 * page you were on, with nothing to catch it.
 *
 * `getCourse(id)` returns `undefined` for an unknown id on purpose. `/courses/:id`
 * takes its id from the URL, which anyone can type, so "not found" is a real
 * state that has to be RENDERED — not an exception, and certainly not a crash
 * on `course.title`.
 *
 * ---------------------------------------------------------------------------
 * PROGRESS BELONGS TO A PERSON, NOT TO A COURSE
 * ---------------------------------------------------------------------------
 *
 * `progress` here is the DEMO learner's progress, and it is only ever shown to
 * a signed-in visitor. A guest browsing the catalogue must not see "65%
 * complete" against a course they have never opened — that is somebody else's
 * number. Every consumer reads it through `enrolledCourses(isAuthenticated)`
 * rather than off the record directly, so the guest case cannot be forgotten by
 * a screen that simply did not think about it.
 */
export const CATEGORIES = [
  { id: 'all', label: 'الكل' },
  { id: 'data', label: 'تحليل البيانات' },
  { id: 'react', label: 'React' },
  { id: 'design', label: 'UI/UX' },
];

/** Difficulty is a scale, so it is stored as one and rendered from a map. */
export const LEVELS = {
  beginner: { label: 'مبتدئ', dots: 1 },
  intermediate: { label: 'متوسط', dots: 2 },
  advanced: { label: 'متقدّم', dots: 3 },
};

export const COURSES = [
  {
    id: 'data-analysis',
    title: 'أساسيات تحليل البيانات',
    category: 'data',
    level: 'beginner',
    Icon: LineChart,
    summary: 'من الجدول الخام إلى قرار تستطيع الدفاع عنه: تنظيف، استكشاف، وعرض.',
    description:
      'تبدأ الدورة من بيانات حقيقية غير مرتّبة — أعمدة ناقصة، تواريخ بصيغ مختلفة، قيم مكرّرة — لأن هذا هو شكل البيانات خارج الكتب. تتعلّمين كيف تنظّفينها، وكيف تسألينها سؤالًا واضحًا، وكيف تعرضين الإجابة بحيث يفهمها من لم يرَ الجدول.',
    durationHours: 18,
    lessonCount: 24,
    learners: 1840,
    rating: 4.8,
    progress: 65,
    lastLesson: 'الدرس 8: تنظيف البيانات',
    outcomes: [
      'تنظيف مجموعة بيانات غير مرتّبة وتوثيق كل قرار اتخذتِه فيها',
      'اختيار الرسم البياني الذي يخدم السؤال بدل الذي يبدو جميلًا',
      'بناء لوحة متابعة تقرأ نفسها دون شرح شفهي',
    ],
    syllabus: [
      {
        title: 'الوحدة الأولى: قبل أن تلمسي البيانات',
        lessons: [
          { title: 'ما السؤال الذي تحاولين الإجابة عنه؟', minutes: 12, free: true },
          { title: 'مصادر البيانات وحدودها', minutes: 15, free: true },
          { title: 'تمرين: صياغة سؤال قابل للقياس', minutes: 20, free: false },
        ],
      },
      {
        title: 'الوحدة الثانية: التنظيف',
        lessons: [
          { title: 'القيم الناقصة: متى تُحذف ومتى تُملأ', minutes: 18, free: false },
          { title: 'التكرارات التي ليست تكرارًا', minutes: 14, free: false },
          { title: 'توحيد صيغ التواريخ والنصوص', minutes: 16, free: false },
        ],
      },
      {
        title: 'الوحدة الثالثة: العرض',
        lessons: [
          { title: 'اختيار الرسم المناسب للسؤال', minutes: 22, free: false },
          { title: 'مشروع الختام: لوحة متابعة كاملة', minutes: 45, free: false },
        ],
      },
    ],
  },
  {
    id: 'react-apps',
    title: 'تطوير تطبيقات React',
    category: 'react',
    level: 'intermediate',
    Icon: Code2,
    summary: 'مكوّنات، حالة، وتوجيه — وبناء واجهة عربية كاملة من اليمين إلى اليسار.',
    description:
      'دورة عملية تُبنى فيها واجهة حقيقية خطوة بخطوة. تركّز على القرارات التي تُتخذ مرة وتُدفع كلفتها طويلًا: أين تعيش الحالة، متى يُقسّم المكوّن، وكيف تُبنى واجهة عربية لا تنكسر عند أول نص طويل.',
    durationHours: 26,
    lessonCount: 32,
    learners: 2310,
    rating: 4.9,
    progress: 40,
    lastLesson: 'الدرس 5: إدارة الحالة',
    outcomes: [
      'تقسيم واجهة إلى مكوّنات لكل منها مسؤولية واحدة',
      'اختيار موضع الحالة بحيث لا تتناقض شاشتان أبدًا',
      'بناء تخطيط RTL يعتمد الخصائص المنطقية لا الفيزيائية',
    ],
    syllabus: [
      {
        title: 'الوحدة الأولى: المكوّنات',
        lessons: [
          { title: 'المكوّن كوحدة مسؤولية', minutes: 14, free: true },
          { title: 'الخصائص مقابل الحالة', minutes: 18, free: true },
          { title: 'متى تُقسّم المكوّن؟', minutes: 16, free: false },
        ],
      },
      {
        title: 'الوحدة الثانية: الحالة',
        lessons: [
          { title: 'رفع الحالة إلى أقرب جدّ مشترك', minutes: 20, free: false },
          { title: 'السياق: متى يكون الأداة الصحيحة', minutes: 17, free: false },
        ],
      },
      {
        title: 'الوحدة الثالثة: التوجيه وواجهة RTL',
        lessons: [
          { title: 'المسارات والمسارات المحميّة', minutes: 21, free: false },
          { title: 'الخصائص المنطقية في Tailwind', minutes: 19, free: false },
        ],
      },
    ],
  },
  {
    id: 'ui-ux',
    title: 'تصميم واجهات المستخدم UI/UX',
    category: 'design',
    level: 'intermediate',
    Icon: Palette,
    summary: 'قرارات التصميم التي تُختبر مع مستخدم حقيقي، لا التي تُبرَّر في اجتماع.',
    description:
      'تبدأ من المستخدم وتنتهي عنده: كيف تُصاغ فرضية، وكيف تُختبر مع خمسة أشخاص، وكيف يُقرأ ما قالوه دون أن تسمعي ما تريدين سماعه. تتخلّل الدورة محاكاة تفاعلية لجلسة اختبار كاملة.',
    durationHours: 15,
    lessonCount: 20,
    learners: 1275,
    rating: 4.7,
    progress: 80,
    lastLesson: 'الدرس 12: اختبار قابلية الاستخدام',
    outcomes: [
      'صياغة فرضية تصميم قابلة للدحض',
      'إدارة جلسة اختبار قابلية استخدام مع خمسة مستخدمين',
      'ترجمة الملاحظات إلى تغييرات مرتّبة بالأولوية',
    ],
    syllabus: [
      {
        title: 'الوحدة الأولى: المستخدم أولًا',
        lessons: [
          { title: 'المقابلة التي لا توجّه الإجابة', minutes: 16, free: true },
          { title: 'من الملاحظة إلى الفرضية', minutes: 14, free: false },
        ],
      },
      {
        title: 'الوحدة الثانية: الاختبار',
        lessons: [
          { title: 'محاكاة: جلسة اختبار كاملة', minutes: 30, free: false },
          { title: 'قراءة النتائج دون انحياز', minutes: 18, free: false },
        ],
      },
    ],
  },
];

export function getCourse(id) {
  return COURSES.find((course) => course.id === id);
}

/**
 * The courses the CURRENT visitor is enrolled in.
 *
 * A guest is enrolled in nothing — not "enrolled with 0%", but nothing at all,
 * which is why this returns an empty array rather than the catalogue with the
 * progress zeroed. The difference matters on screen: an empty list can say
 * "سجّلي الدخول لمتابعة تقدّمك", while a list of zeros claims the visitor
 * started three courses and abandoned all of them.
 */
export function enrolledCourses(isAuthenticated) {
  return isAuthenticated ? COURSES : [];
}
