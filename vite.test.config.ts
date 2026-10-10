import { defineConfig } from 'vite';

// Bundles the pure core (reducer + schema) and perception so they can run under plain node.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-test',
    minify: false,
    emptyOutDir: true,
    lib: {
      entry: { core: 'test/core.test.ts', perception: 'test/perception.test.ts' },
      formats: ['es'],
    },
    rollupOptions: { output: { entryFileNames: '[name].test.js' } },
  },
});
