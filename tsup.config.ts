import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    csd: 'src/cli.ts',
    'emit-event': 'src/hooks/emit-event.ts',
    'pi-extension': 'src/pi-extension/index.ts',
  },
  outDir: 'dist',
  target: 'node22',
  clean: true,
  splitting: false,
  // CLI + hook run via `node dist/*.cjs`; pi extension is ESM for pi's loader.
  format: ['cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.mjs' }),
});
