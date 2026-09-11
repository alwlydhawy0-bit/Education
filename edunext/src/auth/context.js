import { createContext } from 'react';

/**
 * The auth context object, alone in its own module.
 *
 * WHY IT IS NOT IN `AuthProvider.jsx`. React Fast Refresh can only replace a
 * module when everything it exports is a component. A file exporting both the
 * provider and this context loses fast refresh for the whole subtree — every
 * edit anywhere below it becomes a full reload, which is a slow and confusing
 * way to lose ten seconds a hundred times a day. oxlint's
 * `react/only-export-components` flags exactly this, and the fix is the split
 * rather than the suppression.
 *
 * `null` as the default is deliberate: it is not a valid auth state, so
 * `useAuth` can tell "no provider above me" from "a guest is looking", which
 * are very different bugs.
 */
export const AuthContext = createContext(null);
