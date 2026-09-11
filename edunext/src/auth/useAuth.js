import { useContext } from 'react';
import { AuthContext } from './context.js';

/** Who is looking at the app: `{ user, isAuthenticated, signIn, signOut }`. */
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    // Without this a component rendered outside the provider would read `null`
    // and silently treat every visitor as a guest — the failure would surface
    // as a signed-in learner being shown guest UI, which is maddening to trace
    // back to a missing wrapper several files away.
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return context;
}
