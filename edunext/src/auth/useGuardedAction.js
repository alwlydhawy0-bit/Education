import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './useAuth.js';

/**
 * Wrap an action that only a signed-in learner may take.
 *
 * ```js
 * const guard = useGuardedAction();
 * <button onClick={guard(() => resume(course), 'لمتابعة الدرس')}>متابعة</button>
 * ```
 *
 * ---------------------------------------------------------------------------
 * WHY A WRAPPER AND NOT AN `if` AT EACH CALL SITE
 * ---------------------------------------------------------------------------
 *
 * Under the freemium model the check is no longer in one place. "استئناف
 * التعلّم", "متابعة", "سجّلي الآن", "تجربة التطبيق" — each is a separate button
 * on a separate screen, and each would need the same four lines: read the auth
 * state, branch, navigate with the return path, remember to pass the reason.
 * Four lines copied five times is four lines that will differ by the sixth.
 *
 * ---------------------------------------------------------------------------
 * THE RETURN PATH IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * Sending a guest to `/login` and then dropping them on the home page is how a
 * freemium funnel loses the person at the exact moment they showed intent. The
 * location they came FROM travels in router state, and `/login` sends them back
 * there. `replace: false` is deliberate too: the browser Back button should
 * return them to the page they were reading, not re-enter the login screen.
 *
 * `intent` is the short Arabic phrase shown on the login screen ("سجّلي الدخول
 * لمتابعة الدرس"), so the prompt explains itself rather than appearing as an
 * unexplained demand for credentials.
 */
export function useGuardedAction() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(
    (action, intent) => (event) => {
      if (isAuthenticated) {
        action?.(event);
        return;
      }
      event?.preventDefault?.();
      navigate('/login', { state: { from: location, intent } });
    },
    [isAuthenticated, navigate, location],
  );
}
