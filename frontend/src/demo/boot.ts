// The demo's way into a page: only a build made with VITE_DEMO=1 (npm run demo:on) has this, in
// front of the Sepolia wallet's, the devnet page's and the Q-Day page's own script (vite.config.ts).
// A run starts at /sepolia/app?demo and keeps its place in this tab (sessionStorage), so each
// page it reaches loads the autopilot again. While it shows the way out without Opaque, the
// page's requests to Opaque's servers fail, as they would with every server down: that has to
// be in place before the page's own code runs, so it is here and not in the autopilot.

const KEY = 'opaque-demo';
let state: { block?: string } | null = null;
try { state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { /* no run */ }

if (state?.block !== undefined) {
  const host = state.block;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    return url.host === host ? Promise.reject(new TypeError('Failed to fetch')) : real(input, init);
  };
}
if (state !== null || new URLSearchParams(location.search).has('demo')) void import('./autopilot.ts');
