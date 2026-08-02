import { defineConfig } from 'vite';

// Bundles the pure core (reducer + schema) so it can run under plain node.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-test',
    minify: false,
    emptyOutDir: true,
    lib: {
      entry: 'test/core.test.ts',
      formats: ['es'],
      fileName: () => 'core.test.js',
    },
  },
});
