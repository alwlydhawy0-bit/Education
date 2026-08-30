import type { Plugin } from 'vite';

/**
 * Source files use NodeNext module resolution, so relative imports carry a
 * `.js` extension even though the file on disk is `.ts` — that is what lets the
 * same source run under `node --experimental-strip-types` with no build step.
 *
 * Vite does not perform that mapping, so this plugin does: for a relative
 * specifier ending in `.js`, try the `.ts` file first. Without it every
 * workspace package would fail to load under Vitest.
 */
export function resolveJsToTs(): Plugin {
  return {
    name: 'edu:resolve-js-to-ts',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
      const resolved = await this.resolve(source.replace(/\.js$/, '.ts'), importer, {
        ...options,
        skipSelf: true,
      });
      return resolved ?? null;
    },
  };
}
