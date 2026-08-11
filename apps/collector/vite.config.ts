import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    // Every kilobyte here is airtime on a metered connection and seconds on 2G.
    // The ceiling is deliberately aggressive so a careless dependency fails the
    // build rather than quietly costing the fleet data.
    chunkSizeWarningLimit: 150,
    target: 'es2020',
    sourcemap: true,
  },
});
