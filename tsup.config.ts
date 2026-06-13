import { defineConfig } from 'tsup';

// tsup applies `format` per-config, so we ship TWO configs. The CLI and the
// Claude/Codex hook run via `node dist/*.cjs` (CJS). The pi extension is loaded
// by pi's jiti/ESM loader (`pi -e dist/pi-extension.mjs`), so it must be ESM —
// tsup bundles it self-contained (events/event-log/paths/worker-store inlined),
// with NO runtime require of the other dist bundles. Only the CJS config has
// `clean: true`; it owns wiping dist (a second clean would race-delete the
// first config's output).
export default defineConfig([
  {
    entry: {
      csd: 'src/cli.ts',
      'emit-event': 'src/hooks/emit-event.ts',
    },
    outDir: 'dist',
    target: 'node22',
    clean: true,
    splitting: false,
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    entry: {
      'pi-extension': 'src/pi-extension/index.ts',
    },
    outDir: 'dist',
    target: 'node22',
    clean: false,
    splitting: false,
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
  },
]);
