import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.jsx';
import AppRoutes from './routes/index.jsx';

/**
 * The application root: two providers and a route table.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTER IS HERE NOW, AND THE EARLIER ARGUMENT AGAINST IT NO LONGER HOLDS
 * ---------------------------------------------------------------------------
 *
 * This file previously gated the whole product behind a boolean, and argued the
 * case at length: authentication was a GATE rather than a destination, there was
 * one URL, and a router would have expressed a single boolean as a redirect, a
 * guard and two route definitions.
 *
 * Every premise of that has changed. There are six destinations; `/login` is a
 * real place the product links to; and a guest is meant to browse, which means
 * the catalogue and each course need URLs a person can open, share and refresh.
 * A boolean cannot express any of that. The earlier reasoning was right for the
 * product as it stood and is recorded here rather than quietly deleted, because
 * "we added a router" is a much less useful note than "here is what changed
 * that made it worth adding".
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ROUTER COSTS ON A STATIC HOST, AND WHERE THAT IS PAID
 * ---------------------------------------------------------------------------
 *
 * Real paths mean a request for `/courses` goes to the host before React ever
 * runs, and a static host answers with 404 unless it is told to serve
 * `index.html` for everything. That is the classic SPA deep-link failure: the
 * app works perfectly until someone refreshes a page or opens a shared link.
 *
 * It is paid for in `vercel.json`'s `rewrites`, with a fitness test in
 * `tests/architecture/deployment-config.test.ts` holding it there — because the
 * failure is invisible in development (Vite's dev server rewrites by default)
 * and only appears in production.
 *
 * ---------------------------------------------------------------------------
 * PROVIDER ORDER
 * ---------------------------------------------------------------------------
 *
 * `BrowserRouter` wraps `AuthProvider`, not the other way round: nothing in the
 * auth layer needs routing today, but `useGuardedAction` — which lives beside
 * it — calls `useNavigate`, and a hook cannot reach a provider that sits inside
 * it. Getting this backwards produces a runtime error far from its cause.
 *
 * The RTL direction is NOT set here. It lives on <html> in index.html so the
 * first paint is already correct, with `html { direction: rtl }` in index.css
 * as the backstop.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
