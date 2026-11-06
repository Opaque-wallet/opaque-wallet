// The front page's build (vite build site), the last step of npm run build:site. Its one setting:
// in a build made with VITE_DEMO=1 (npm run demo:on), the demo's opening (tour.js) is added to the
// ETHGlobal Mumbai page, which the main build has already copied into dist from public/. Any
// other build leaves no trace of it.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const env = globalThis.process?.env ?? {};
const DIST = new URL('../dist/', import.meta.url);

export default {
  plugins: [{
    name: 'opaque-demo',
    closeBundle() {
      if (env.VITE_DEMO !== '1') return;
      const page = new URL('ethglobal-mumbai.html', DIST);
      copyFileSync(new URL('./tour.js', import.meta.url), new URL('demo-tour.js', DIST));
      writeFileSync(page, readFileSync(page, 'utf8').replace('</body>', '<script type="module" src="/demo-tour.js"></script>\n</body>'));
    },
  }],
};
