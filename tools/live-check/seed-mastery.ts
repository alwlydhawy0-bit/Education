/**
 * Seeds a course with objectives and two assessments into a DEVELOPMENT
 * database, for the live mastery check in tools/live-check/README.md.
 *
 * Reuses the test fixtures rather than restating their SQL, for the same reason
 * `seed.ts` does: a second copy of the seed is one more place a schema change
 * can be missed.
 */
import { hashPassword } from '../../apps/api/src/platform/security/passwords.ts';
import {
  addClassMember,
  assignCourseToClass,
  assignTeacher,
  closeSeedDb,
  createActivity,
  createClass,
  createCourse,
  createCurriculum,
  createEducationLevel,
  createLesson,
  createOrganization,
  createQuestion,
  createUnit,
  createUser,
  grantRole,
  objectivesOf,
  seedDb,
} from '../../tests/setup/fixtures.ts';

const stamp = Date.now();
const password = process.env['LIVE_PASSWORD'];
if (!password) throw new Error('LIVE_PASSWORD must be set; no default is provided');
const passwordHash = await hashPassword(password);

const org = await createOrganization(`Mastery School ${stamp}`);
const learnerEmail = `m-learner-${stamp}@t.local`;
const teacherEmail = `m-teacher-${stamp}@t.local`;
const learner = (
  await createUser({ email: learnerEmail, roles: [], organizationId: org, passwordHash })
).id;
const teacher = (
  await createUser({ email: teacherEmail, roles: [], organizationId: org, passwordHash })
).id;
await grantRole(learner, 'student', 'organization', org);
await grantRole(teacher, 'teacher', 'organization', org);

const klass = await createClass(org, `M ${stamp}`);
await addClassMember(klass, learner);
await assignTeacher(teacher, klass);

const level = await createEducationLevel(`grade_m_${stamp}`);
const curriculum = await createCurriculum({
  organizationId: org,
  code: `mc${stamp}`.slice(0, 20),
  status: 'published',
});
const course = await createCourse({
  organizationId: org,
  curriculumId: curriculum,
  levelId: level,
  title: 'Physics',
  status: 'published',
});
const unit = await createUnit({ courseId: course, title: 'Mechanics', status: 'published' });
const lesson = await createLesson({
  unitId: unit,
  title: "Newton's Laws",
  status: 'published',
  objectives: ["Explain Newton's second law", 'Apply F=ma to a trolley'],
});
await assignCourseToClass({ classId: klass, courseId: course });

const db = await seedDb();
const mkQuiz = async (title: string) => {
  const { activityId, assessmentId } = await createActivity({
    lessonId: lesson,
    title,
    status: 'draft',
    maxAttempts: 5,
    passingPercentage: 50,
  });
  const q = await createQuestion({
    assessmentId: assessmentId!,
    questionType: 'single_choice',
    prompt: `${title}?`,
    points: 2,
    options: ['Right', 'Wrong'],
    correctOptions: [0],
  });
  await db.query(
    `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
    [activityId],
  );
  return { assessmentId: assessmentId!, questionId: q.questionId, correct: q.correctOptionIds[0] };
};

console.log(
  JSON.stringify({
    learnerEmail,
    teacherEmail,
    courseId: course,
    classId: klass,
    learnerId: learner,
    lessonId: lesson,
    objectives: (await objectivesOf(lesson)).map((o) => o.id),
    quizOne: await mkQuiz('Quiz One'),
    quizTwo: await mkQuiz('Quiz Two'),
  }),
);
await closeSeedDb();
