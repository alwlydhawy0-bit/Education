import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts every rendered tree between tests.
 *
 * Without it a component left mounted keeps its timers, its `aria-live` region
 * and its pending promises alive into the next test, and a query like
 * `getByTestId` starts matching the PREVIOUS test's DOM — which fails in the
 * most confusing possible way: intermittently, and only when the file order
 * changes.
 */
afterEach(() => {
  cleanup();
});
