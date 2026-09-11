import { useState } from 'react';
import { AppLayout } from './components/layout/index.js';
import Auth from './pages/Auth.jsx';
import Dashboard from './pages/Dashboard.jsx';

/**
 * The application root.
 *
 * ---------------------------------------------------------------------------
 * STILL NO ROUTER, AND THAT IS A DECISION RATHER THAN AN OMISSION
 * ---------------------------------------------------------------------------
 *
 * This file used to say that a router would arrive with the second screen. The
 * second screen has arrived, so the claim is worth re-examining rather than
 * simply acted on.
 *
 * Authentication is a GATE, not a destination. There is exactly one URL — `/` —
 * and what it shows depends on whether the visitor is signed in. That is the
 * whole rule, and a router would express it as a redirect, a guard component
 * and two route definitions: more moving parts describing the same single
 * boolean.
 *
 * It would also cost something concrete on this deployment. A router puts real
 * paths in the address bar, and a static host answers a request for `/auth`
 * with a 404 unless it is told to rewrite every path to `index.html`. Adding
 * routes without adding that rewrite produces an app that works perfectly until
 * someone refreshes the page or opens a link — the classic SPA deep-link 404.
 *
 * So the gate stays a boolean. The seam is here: when a third screen needs its
 * own URL, the router goes in this file, `Auth` and `Dashboard` become routes,
 * and neither of them has to change — they already take the one prop each that
 * a route would give them.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A SECURITY BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * `authenticated` decides what is RENDERED, and nothing else. Client state is
 * editable by whoever holds the browser, so it protects no data: the dashboard
 * is safe only because every request behind it is authorised by the server,
 * which is where the real boundary is and the only place it can be. Treating a
 * React state variable as an access control is how a frontend ends up shipping
 * data it then tries to hide.
 *
 * The RTL direction is NOT set here. It lives on <html> in index.html so the
 * first paint is already correct, with `html { direction: rtl }` in index.css
 * as the backstop.
 */
export default function App() {
  const [authenticated, setAuthenticated] = useState(false);

  if (!authenticated) {
    return <Auth onAuthenticated={() => setAuthenticated(true)} />;
  }

  return (
    <AppLayout>
      <Dashboard />
    </AppLayout>
  );
}
