import { defineConfig } from 'vite';

// Wallet pages, not one app: app.html (Arc), xrpl.html and xrpl-connect.html
// (XRPL). The home page is site/, built on its own (`npm run build:site`).
//
// No node: imports here on purpose — it keeps @types/node off the dependency
// list, so `tsc --noEmit` runs against the DOM lib alone and this config stays
// type-checked with everything else.
// The demo's autopilot (src/demo/), in front of the three pages it plays, only in a build made
// with VITE_DEMO=1 (npm run demo:on); any other build has no trace of it. Read the way
// deployments/index.ts reads OPAQUE_NETWORK, so this config needs no Node types.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const DEMO_PAGES: Record<string, RegExp> = { sepolia: /src\/(app|qday\/qday)\.ts/, testnet: /src\/ethereum\/devnet\.ts/ };
const demo = {
  name: 'opaque-demo',
  transformIndexHtml: {
    order: 'pre' as const,
    handler: (html: string) => env['VITE_DEMO'] === '1' && DEMO_PAGES[env['VITE_NETWORK'] ?? '']?.test(html) === true
      ? html.replace('<script type="module"', '<script type="module" src="/src/demo/boot.ts"></script>\n<script type="module"')
      : html,
  },
};

export default defineConfig({
  plugins: [demo],
  // Relative asset URLs, not root-absolute. The extension loads app.html from
  // a chrome-extension:// origin where a leading "/" means the extension root,
  // which happens to work — but only by luck, and it breaks the moment the
  // hosted build moves to a subpath. Relative is correct in both.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { app: 'app.html', xrpl: 'xrpl.html', connect: 'xrpl-connect.html', devnet: 'devnet.html', vault: 'vault.html', ethconnect: 'eth-connect.html', quantumsafe: 'quantum-safe.html', qday: 'q-day.html' },
    },
  },
  server: {
    port: 5173,
    // The wallet imports the mesh, the sealer, the pool client and the ring
    // client from their home packages rather than copying them, so the dev
    // server must be allowed to read the repo above frontend/. `vite build`
    // is unaffected — this only governs what the dev server will serve.
    fs: { allow: ['..'] },
    // The UI runs standalone; this is only live once `npm run api` is up in a
    // second terminal. Proxying rather than pointing the browser straight at
    // :8402 keeps everything same-origin, so there is no CORS to configure.
    proxy: { '/api': 'http://localhost:8402' },
  },
});
