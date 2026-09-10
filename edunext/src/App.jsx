import { AppLayout } from './components/layout/index.js';
import Dashboard from './pages/Dashboard.jsx';

/**
 * The application root.
 *
 * Deliberately thin. No router yet — a single screen does not need one, and
 * adding `react-router` before there is a second route is a dependency chosen
 * on speculation. When Task 002 introduces navigation, the router goes here and
 * `AppLayout` becomes its shell; nothing below has to change.
 *
 * The RTL direction is NOT set here. It lives on <html> in index.html so the
 * first paint is already correct, with `html { direction: rtl }` in index.css
 * as the backstop. Setting it a third time on a React root would be one more
 * place to forget.
 */
export default function App() {
  return (
    <AppLayout>
      <Dashboard />
    </AppLayout>
  );
}
