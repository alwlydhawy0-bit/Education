/**
 * Seeds one WITHHELD assessment into the development database, for the live
 * HTTP check in tools/live-check/README.md.
 *
 * Reuses the test fixtures rather than restating their SQL: a second copy of
 * the seed would be one more place for a schema change to be missed, and the
 * point of this check is to exercise the real endpoints, not the seeding.
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
  seedDb,
} from '../../tests/setup/fixtures.ts';

const stamp = Date.now();
const password = process.env['LIVE_PASSWORD'];
if (!password) throw new Error('LIVE_PASSWORD must be set; no default is provided');
const passwordHash = await hashPassword(password);

const org = await createOrganization(`Live School ${stamp}`);

const learnerEmail = `live-learner-${stamp}@t.local`;
const teacherEmail = `live-teacher-${stamp}@t.local`;
const learner = (
  await createUser({ email: learnerEmail, roles: [], organizationId: org, passwordHash })
).id;
const teacher = (
  await createUser({ email: teacherEmail, roles: [], organizationId: org, passwordHash })
).id;
await grantRole(learner, 'student', 'organization', org);
await grantRole(teacher, 'teacher', 'organization', org);

const klass = await createClass(org, `Live A1 ${stamp}`);
await addClassMember(klass, learner);
await assignTeacher(teacher, klass);

const level = await createEducationLevel(`grade_live_${stamp}`);
const curriculum = await createCurriculum({
  organizationId: org,
  code: `lc${stamp}`.slice(0, 20),
  status: 'published',
});
const course = await createCourse({
  organizationId: org,
  curriculumId: curriculum,
  levelId: level,
  title: 'Live Course',
  status: 'published',
});
const unit = await createUnit({ courseId: course, title: 'Live Unit', status: 'published' });
const lesson = await createLesson({ unitId: unit, title: 'Live Lesson', status: 'published' });
await assignCourseToClass({ classId: klass, courseId: course });

const { activityId, assessmentId } = await createActivity({
  lessonId: lesson,
  title: 'Live Withheld Quiz',
  status: 'draft',
  maxAttempts: 2,
  passingPercentage: 50,
  reviewPolicy: 'on_release',
});
if (!assessmentId) throw new Error('no assessment');

const q = await createQuestion({
  assessmentId,
  questionType: 'single_choice',
  prompt: 'LIVE_PROMPT_SENTINEL',
  points: 2,
  options: ['Right', 'Wrong'],
  correctOptions: [0],
  explanation: 'LIVE_EXPLANATION_SENTINEL',
});

const db = await seedDb();
await db.query(
  `UPDATE learning_activities SET status='published', published_at=now() WHERE id=$1`,
  [activityId],
);

console.log(
  JSON.stringify({
    learnerEmail,
    teacherEmail,
    assessmentId,
    questionId: q.questionId,
    correctOptionId: q.correctOptionIds[0],
    wrongOptionId: q.optionIds.find((id) => !q.correctOptionIds.includes(id)),
  }),
);
await closeSeedDb();
