/**
 * The assistant's answers — SIMULATED, and the seam where a real one attaches.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIMULATION IS LABELLED IN THE UI, NOT JUST IN THIS COMMENT
 * ---------------------------------------------------------------------------
 *
 * A chat panel that returns confident Arabic prose with a page-numbered
 * citation attached is indistinguishable, to the person reading it, from a
 * tutor that actually consulted the material. Shipping that unlabelled would
 * mean a learner could revise from text nobody wrote and a reference nobody
 * checked — and the citation is the part that makes it persuasive.
 *
 * So the panel carries a visible "وضع تجريبي" notice. That single line is the
 * difference between a UI shell and a thing that misleads, and it costs nothing
 * to keep until the real endpoint is wired.
 *
 * ---------------------------------------------------------------------------
 * THE CITATIONS POINT AT REAL LESSONS
 * ---------------------------------------------------------------------------
 *
 * They are drawn from the course's own syllabus rather than invented, so
 * "الوحدة الثانية: التنظيف — القيم الناقصة" names a lesson that genuinely
 * exists in this catalogue. Fabricating plausible titles would have been
 * easier and would make the placeholder harder to tell from the real thing —
 * exactly the wrong direction. The page numbers ARE invented, which is why they
 * are rendered as placeholders and the notice says so.
 *
 * ---------------------------------------------------------------------------
 * REPLACING THIS
 * ---------------------------------------------------------------------------
 *
 * `askAssistant` is shaped like the call it stands in for: async, cancellable,
 * resolving to `{ text, citations }`. The platform's own tutor API already
 * returns that shape with server-validated citations. Swapping it is an edit to
 * this one function, and the visible notice goes with it.
 */

/** Long enough for the typing indicator to be a real state, not a flash. */
const THINK_MS = 1400;

export const PRESETS = [
  { id: 'explain', label: 'اشرح لي هذه النقطة' },
  { id: 'example', label: 'أعطني مثالًا تطبيقيًا' },
  { id: 'summary', label: 'لخّص لي الوحدة' },
  { id: 'quiz', label: 'اختبرني بسؤال' },
];

/** Flatten a course's syllabus into citable lessons. */
function lessonsOf(course) {
  return (course?.syllabus ?? []).flatMap((unit) =>
    unit.lessons.map((lesson) => ({ unit: unit.title, lesson: lesson.title })),
  );
}

/**
 * Pick citations deterministically from the question.
 *
 * Deterministic rather than random so the same question gives the same sources
 * twice — a demo whose citations reshuffle on every ask advertises that they
 * are noise.
 */
function citationsFor(course, question) {
  const lessons = lessonsOf(course);
  if (lessons.length === 0) return [];
  let hash = 0;
  for (const character of question) hash = (hash * 31 + character.codePointAt(0)) % 100_000;
  const first = lessons[hash % lessons.length];
  const second = lessons[(hash + 3) % lessons.length];
  const chosen = second.lesson === first.lesson ? [first] : [first, second];
  return chosen.map((entry, index) => ({
    id: `${hash}-${index}`,
    unit: entry.unit,
    lesson: entry.lesson,
    // Invented, and presented as such — see the header.
    page: 30 + ((hash + index * 7) % 120),
  }));
}

const ANSWERS = {
  explain: (course) => `النقطة الأساسية في **${course.title}** تُفهم على ثلاث خطوات:

1. **ابدئي من السؤال** — ما الذي تحاولين معرفته تحديدًا؟
2. **افحصي المادة الخام** قبل أي استنتاج؛ أغلب الأخطاء تحدث هنا لا في التحليل.
3. **اعرضي النتيجة** بحيث يفهمها من لم يرَ خطواتك.

الخطوة الثانية هي التي تُختصَر عادةً، وهي التي تُكلّف أكثر ما تُكلّف لاحقًا.`,

  example: (course) => `مثال تطبيقي من **${course.title}**:

لديك جدول فيه عمود «التاريخ» بصيغ مختلطة. قبل أي تحليل، وحّدي الصيغة:

\`\`\`python
import pandas as pd

df = pd.read_csv("raw.csv")
df["date"] = pd.to_datetime(df["date"], errors="coerce")

# الصفوف التي فشل تحويلها ليست مشكلة تُحذف بصمت —
# بل إشارة إلى مصدر بيانات يحتاج مراجعة.
unparsed = df[df["date"].isna()]
print(f"تعذّر تحويل {len(unparsed)} صفًا")
\`\`\`

لاحظي أنّ \`errors="coerce"\` لا يُخفي المشكلة بل يجعلها قابلة للعدّ.`,

  summary: (course) => `خلاصة **${course.title}** في أربع نقاط:

- الهدف يُصاغ قبل فتح البيانات أو المحرّر، لا بعده.
- أغلب العمل تحضيري، وهذا ليس هدرًا بل هو العمل نفسه.
- كل قرار يُوثَّق: ما حُذف، ولماذا.
- النتيجة تُقاس بمدى وضوحها لقارئ لم يحضر العملية.

> القاعدة العملية: إن لم تستطيعي شرح خطوةٍ لزميلة في جملتين، فالخطوة لم تكتمل بعد.`,

  quiz: (course) => `سؤال من **${course.title}**:

لديك عمود يحتوي 12% قيمًا ناقصة. ما الذي تفعلينه أولًا، ولماذا؟

- (أ) تحذفين الصفوف الناقصة
- (ب) تملئينها بالمتوسط
- (ج) تسألين عن **سبب** النقص

خذي وقتك — والإجابة التي تبحث عن السبب قبل العلاج هي المقصودة.`,

  fallback: (course, question) => `سؤالك عن «${question}» يتقاطع مع **${course.title}**.

الدروس المرتبطة به مذكورة أدناه؛ ابدئي منها ثم أعيدي صياغة السؤال بما يخصّ جزءًا واحدًا، فالأسئلة الضيّقة تُجاب بدقّة أكبر.`,
};

/**
 * Ask the assistant.
 *
 * @param {object} params
 * @param {object} params.course   The course being read — the grounding context.
 * @param {string} params.question The learner's question.
 * @param {AbortSignal} [params.signal] Cancels a pending answer.
 * @returns {Promise<{ text: string, citations: Array }>}
 */
export function askAssistant({ course, question, signal }) {
  return new Promise((resolve, reject) => {
    const preset = PRESETS.find((item) => item.label === question)?.id;
    const build = ANSWERS[preset] ?? ANSWERS.fallback;

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ text: build(course, question), citations: citationsFor(course, question) });
    }, THINK_MS);

    /*
     * Cancellation is not decoration. Closing the panel mid-answer must stop the
     * pending work, or the resolve lands on an unmounted component and React
     * warns — and worse, reopening would show an answer to a question the
     * learner had already abandoned.
     */
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
