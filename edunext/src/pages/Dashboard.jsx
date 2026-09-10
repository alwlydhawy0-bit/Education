import { BookOpen, ClipboardList, Clock, Star } from 'lucide-react';
import { Button, Card } from '../components/ui/index.js';

/**
 * Dashboard — the setup verification page.
 *
 * This is NOT the dashboard from the reference design; Task 002 and Task 003
 * build that. What it does is prove, on screen, that every piece of the setup
 * actually works: the Arabic font loaded, the direction is right-to-left, each
 * design token resolves to the intended colour, the card shape and soft shadow
 * are correct, and `lucide-react` renders.
 *
 * A setup task that ends with a blank white page has verified nothing.
 */

const STATS = [
  { label: 'دورة مُسجَّلة', value: '12', Icon: BookOpen },
  { label: 'دورات قيد الإنجاز', value: '5', Icon: ClipboardList },
  { label: 'شهادات مُحقَّقة', value: '3', Icon: Star },
  { label: 'ساعة تعلّم هذا الشهر', value: '28', Icon: Clock },
];

const TOKENS = [
  { name: 'canvas', value: '#FBF9F5', swatch: 'bg-canvas' },
  { name: 'surface', value: '#FFFFFF', swatch: 'bg-surface' },
  { name: 'surface.alt', value: '#F5F0E6', swatch: 'bg-surface-alt' },
  { name: 'primary', value: '#6D28D9', swatch: 'bg-primary' },
  { name: 'primary.hover', value: '#5B21B6', swatch: 'bg-primary-hover' },
  { name: 'primary.light', value: '#F3E8FF', swatch: 'bg-primary-light' },
  { name: 'accent.lavender', value: '#DDD6FE', swatch: 'bg-accent-lavender' },
  { name: 'accent.subtle', value: '#E8E1D5', swatch: 'bg-accent-subtle' },
  { name: 'text.main', value: '#1E1B4B', swatch: 'bg-text-main' },
  { name: 'text.muted', value: '#6B7280', swatch: 'bg-text-muted' },
];

export default function Dashboard() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* الترويسة الترحيبية — نفس تدرّج البنفسجي في التصميم المرجعي */}
      <Card
        as="section"
        padded={false}
        className="overflow-hidden border-transparent bg-gradient-to-l from-primary-light to-accent-lavender"
      >
        <div className="p-8">
          <h1 className="text-2xl font-bold text-text-main">رحلتك التعليمية تبدأ هنا</h1>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-text-muted">
            اكتشف دوراتك، طوّر مهاراتك، وحقّق أهدافك بخطوات واضحة ومنتظمة.
          </p>
          <Button withArrow className="mt-6">
            ابدأ التعلّم
          </Button>
        </div>
      </Card>

      {/* بطاقات الإحصائيات */}
      <section aria-labelledby="stats-heading">
        <h2 id="stats-heading" className="mb-3 text-base font-semibold">
          إحصائياتك
        </h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {STATS.map(({ label, value, Icon }) => (
            <Card key={label} interactive className="flex items-center gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-light">
                <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                {/* tabular figures so a column of numbers stays aligned */}
                <span className="block text-2xl font-bold leading-none tabular-nums">{value}</span>
                <span className="mt-1 block truncate text-xs text-text-muted">{label}</span>
              </span>
            </Card>
          ))}
        </div>
      </section>

      {/* لوحة التحقّق من إعداد المشروع */}
      <Card as="section" aria-labelledby="tokens-heading">
        <h2 id="tokens-heading" className="text-base font-semibold">
          تم إعداد المشروع بنجاح
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          هذه الصفحة مؤقّتة، والغرض منها التأكّد من أنّ الخط العربي محمّل، وأنّ اتجاه الواجهة من
          اليمين إلى اليسار، وأنّ كل لون من ألوان النظام يُترجَم إلى قيمته الصحيحة. تُستبدل بالكامل
          في المهمة التالية.
        </p>

        <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {TOKENS.map(({ name, value, swatch }) => (
            <li
              key={name}
              className="rounded-card border border-accent-subtle bg-surface-alt/50 p-3"
            >
              <span
                className={`block h-10 w-full rounded-lg border border-accent-subtle ${swatch}`}
                aria-hidden="true"
              />
              <span className="mt-2 block text-[11px] font-medium">{name}</span>
              {/* The hex is a code identifier, so it stays LTR inside the RTL
                  paragraph — without `dir`, the browser reorders the '#'. */}
              <span dir="ltr" className="block text-[11px] text-text-muted">
                {value}
              </span>
            </li>
          ))}
        </ul>

        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-card bg-surface-alt/50 px-4 py-3">
            <dt className="text-text-muted">الخط</dt>
            <dd className="font-medium">Readex&nbsp;Pro</dd>
          </div>
          <div className="flex items-center justify-between rounded-card bg-surface-alt/50 px-4 py-3">
            <dt className="text-text-muted">اتجاه الواجهة</dt>
            <dd className="font-medium">من اليمين إلى اليسار</dd>
          </div>
          <div className="flex items-center justify-between rounded-card bg-surface-alt/50 px-4 py-3">
            <dt className="text-text-muted">استدارة البطاقات</dt>
            <dd className="font-medium tabular-nums">16 بكسل</dd>
          </div>
          <div className="flex items-center justify-between rounded-card bg-surface-alt/50 px-4 py-3">
            <dt className="text-text-muted">الأيقونات</dt>
            <dd className="font-medium">lucide-react</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
