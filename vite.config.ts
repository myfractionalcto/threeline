import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import { builtinModules } from 'node:module';
import path from 'node:path';

// Set THREELANE_WEB_ONLY=1 to run the renderer in a plain browser (no Electron).
// Useful for iterating on the recorder/editor UI before packaging.
// (SNAPSCREEN_WEB_ONLY is still honoured for a grace period so existing
// shells/scripts don't break after the rename.)
const webOnly =
  process.env.THREELANE_WEB_ONLY === '1' || process.env.SNAPSCREEN_WEB_ONLY === '1';

// Anything in node_modules should be loaded by Node at runtime — never
// bundled into main.js. This avoids rollup tripping on optional native
// deps like ws's `bufferutil` / `utf-8-validate`.
const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];
function isNodeModule(id: string): boolean {
  // '.' + '/' = relative/absolute. Everything else is a bare import → external.
  return !id.startsWith('.') && !path.isAbsolute(id);
}
const electronExternal = (id: string): boolean =>
  id === 'electron' || nodeBuiltins.includes(id) || isNodeModule(id);

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  plugins: [
    react(),
    ...(webOnly
      ? []
      : [
          electron({
            main: {
              entry: 'electron/main.ts',
              vite: {
                build: {
                  outDir: 'dist-electron',
                  rollupOptions: { external: electronExternal },
                },
              },
            },
            preload: {
              input: path.join(__dirname, 'electron/preload.ts'),
              vite: {
                build: {
                  outDir: 'dist-electron',
                  rollupOptions: { external: electronExternal },
                },
              },
            },
            renderer: {},
          }),
        ]),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
