import { defineConfig } from 'vite';

// The adapter is imported from the wallet's source, as a dapp would import the
// published package, so the dev server may read above this folder.
export default defineConfig({ server: { fs: { allow: ['../..'] } } });
