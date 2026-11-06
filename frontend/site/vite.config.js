// The front page's build (vite build site). Its one setting: in a build made with VITE_DEMO=1
// (npm run demo:on), the demo's opening (tour.js) is added to the page; any other build has
// no trace of it.
const env = globalThis.process?.env ?? {};

export default {
  plugins: [{
    name: 'opaque-demo',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => (env.VITE_DEMO === '1' ? html.replace('</body>', '<script type="module" src="./tour.js"></script>\n</body>') : html),
    },
  }],
};
