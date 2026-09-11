import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from '../components/layout/AppLayout.jsx';
import About from '../pages/About.jsx';
import Auth from '../pages/Auth.jsx';
import CourseDetails from '../pages/CourseDetails.jsx';
import Courses from '../pages/Courses.jsx';
import Dashboard from '../pages/Dashboard.jsx';
import Profile from '../pages/Profile.jsx';

/**
 * Every destination in the product, in one readable table.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PUBLIC, AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * There is NO route guard here, and its absence is the feature. Under the
 * freemium model a visitor may read every page in this table without an
 * account: browse the dashboard, open the catalogue, read a course's syllabus,
 * read about the platform. What a guest cannot do is ACT — enrol, resume a
 * lesson, run a simulation — and those are guarded at the button that performs
 * them (`useGuardedAction`), not at the door to the page that contains them.
 *
 * Putting the check on the route instead would be the older, easier design and
 * it would defeat the model: a guest bounced off `/courses/react-apps` never
 * sees the syllabus that was supposed to persuade them to sign up.
 *
 * `/profile` is public for the same reason and renders its own guest state —
 * "you are browsing as a guest, here is what an account gives you" — which is a
 * more useful page than a redirect.
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT IS A ROUTE, AND `/login` SITS OUTSIDE IT
 * ---------------------------------------------------------------------------
 *
 * Everything inside `AppLayout` gets the sidebar, header and bottom bar.
 * `/login` deliberately does not: it is a full-bleed screen with a single card
 * and no navigation, because navigation at that moment is a way to lose the
 * person who was about to sign in.
 *
 * ---------------------------------------------------------------------------
 * THE CATCH-ALL
 * ---------------------------------------------------------------------------
 *
 * An unknown path redirects home rather than rendering nothing. `replace` keeps
 * the bad URL out of history, so Back does not walk the visitor into the same
 * dead end they just left.
 */
export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Auth />} />

      <Route element={<AppLayout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/courses" element={<Courses />} />
        <Route path="/courses/:courseId" element={<CourseDetails />} />
        <Route path="/about" element={<About />} />
        <Route path="/profile" element={<Profile />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
