import { defineConfig } from 'vite';

// Bundles the prompt mixer so its ramp behaviour can run under plain node.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-test',
    minify: false,
    emptyOutDir: false,
    lib: {
      entry: 'test/mixer.test.ts',
      formats: ['es'],
      fileName: () => 'mixer.test.js',
    },
  },
});
