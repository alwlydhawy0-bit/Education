import {
  ArrowLeft,
  BookOpen,
  FlaskConical,
  LineChart,
  MessageSquare,
  Route,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';

/**
 * What EduNext is, for someone deciding whether to sign up.
 *
 * ---------------------------------------------------------------------------
 * WRITTEN FOR A GUEST, WITHOUT PRETENDING THE PRODUCT IS FINISHED
 * ---------------------------------------------------------------------------
 *
 * The roadmap below distinguishes what EXISTS from what is PLANNED, and says
 * which is which on the page rather than describing everything in the present
 * tense. A marketing page that promises a feature the visitor then cannot find
 * costs more trust than the feature would have earned — and this product is
 * genuinely mid-build, so the honest version is also the accurate one.
 *
 * The closing call to action changes with the visitor: there is no sense
 * showing "أنشئي حسابك" to someone who is already signed in.
 */
const FEATURES = [
  {
    Icon: Route,
    title: 'مسار تعلّم واضح',
    body: 'كل دورة مقسّمة إلى وحدات ودروس بمدّة معلومة مسبقًا، فتعرفين ما ينتظرك قبل أن تبدئي لا بعدها.',
  },
  {
    Icon: FlaskConical,
    title: 'محاكاة تفاعلية',
    body: 'بعض الدروس تُدار كتجربة لا كفيديو: تغيّرين المدخلات وترين أثرها، لأن ما تجرّبينه يبقى أطول ممّا تشاهدينه.',
  },
  {
    Icon: LineChart,
    title: 'تقدّم محفوظ',
    body: 'يُحفَظ موضعك في كل درس عبر أجهزتك، فتستأنفين من حيث توقّفتِ دون بحث.',
  },
  {
    Icon: MessageSquare,
    title: 'مساعدة مبنيّة على المحتوى',
    body: 'المساعد يجيب من دروس الدورة نفسها ويستشهد بها، فلا يخترع إجابة ولا يحيلك إلى مصدر لم تقرئيه.',
  },
  {
    Icon: ShieldCheck,
    title: 'خصوصية بالتصميم',
    body: 'بياناتك التعليمية تخصّك وحدك، والصلاحيات تُفرَض على الخادم لا في المتصفّح.',
  },
  {
    Icon: BookOpen,
    title: 'تصفّح دون حساب',
    body: 'الكتالوج والمناهج ودروس مختارة متاحة للجميع. الحساب مطلوب حين تبدئين التعلّم فعلًا.',
  },
];

const ROADMAP = [
  {
    phase: 'متاح الآن',
    state: 'done',
    items: ['كتالوج الدورات والمناهج كاملة', 'تصفّح كزائرة دون حساب', 'حساب يحفظ تقدّمك'],
  },
  {
    phase: 'قيد التطوير',
    state: 'active',
    items: [
      'مشغّل الدروس والفيديو',
      'المحاكاة التفاعلية داخل الدرس',
      'شهادات إتمام قابلة للمشاركة',
    ],
  },
  {
    phase: 'قادم',
    state: 'planned',
    items: ['مسارات مهنية متعدّدة الدورات', 'مجتمع تعلّم ومراجعة أقران', 'تطبيق للهواتف'],
  },
];

export default function About() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 py-2">
      {/* الرؤية */}
      <section className="overflow-hidden rounded-card bg-gradient-to-l from-primary-light to-accent-lavender/60 p-6 sm:p-8">
        <h1 className="max-w-2xl text-balance text-xl font-bold leading-snug text-text-main sm:text-2xl">
          منصّة تعلّم عربية تُبنى على الفهم لا على الحفظ
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-text-muted">
          EduNext منصّة تعليمية بالعربية تبدأ من سؤال عملي وتنتهي بمهارة تستطيعين إثباتها. المحتوى
          مكتوب بالعربية أصلًا — لا مترجَمًا — والواجهة مصمَّمة من اليمين إلى اليسار من أول سطر، لأن
          القراءة المريحة جزء من التعلّم لا زينة فوقه.
        </p>
      </section>

      {/* المزايا */}
      <section aria-labelledby="features-heading">
        <h2 id="features-heading" className="mb-3 text-base font-semibold text-text-main">
          ما الذي يميّز المنصّة؟
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {FEATURES.map(({ Icon, title, body }) => (
            <li key={title} className="card-surface flex flex-col gap-2.5 p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary-light">
                <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
              </span>
              <h3 className="text-sm font-semibold text-text-main">{title}</h3>
              <p className="text-xs leading-relaxed text-text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* خارطة الطريق */}
      <section aria-labelledby="roadmap-heading">
        <h2 id="roadmap-heading" className="mb-1 text-base font-semibold text-text-main">
          خارطة الطريق
        </h2>
        <p className="mb-3 text-xs text-text-muted">
          ما هو جاهز، وما نعمل عليه الآن، وما هو قادم — مفصولة بوضوح.
        </p>
        <ol className="grid gap-4 md:grid-cols-3">
          {ROADMAP.map(({ phase, state, items }) => (
            <li key={phase} className="card-surface flex flex-col gap-3 p-5">
              <span
                className={[
                  'inline-flex w-fit rounded-full px-3 py-1 text-[11px] font-medium',
                  state === 'done'
                    ? 'bg-primary text-on-primary'
                    : state === 'active'
                      ? 'bg-accent-lavender text-primary'
                      : 'bg-surface-alt text-text-muted',
                ].join(' ')}
              >
                {phase}
              </span>
              <ul className="flex flex-col gap-2">
                {items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-xs leading-relaxed">
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                    <span className="text-text-muted">{item}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      {/* الخاتمة */}
      <section className="card-surface flex flex-col items-start gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-main">
            {isAuthenticated ? 'تابعي من حيث توقّفتِ' : 'جاهزة للبدء؟'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            {isAuthenticated
              ? 'دوراتك ومسار تقدّمك في انتظارك على الصفحة الرئيسية.'
              : 'تصفّحي الكتالوج الآن دون حساب، وسجّلي حين تقرّرين البدء فعلًا.'}
          </p>
        </div>
        <Link
          to={isAuthenticated ? '/' : '/courses'}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-6 text-sm font-medium text-on-primary shadow-soft transition-colors duration-200 hover:bg-primary-hover"
        >
          <span>{isAuthenticated ? 'إلى لوحتي' : 'تصفّحي الدورات'}</span>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Link>
      </section>
    </div>
  );
}
