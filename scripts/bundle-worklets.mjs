// 把 AudioWorklet 的 TS 入口打包成浏览器可 addModule 的单个 IIFE 文件。
// dev / build 前通过 predev / prebuild 自动执行。
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const entry = resolve(root, 'src/worklets/show-worklet.ts');
const outfile = resolve(root, 'public/worklets/show-worklet.js');
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

console.log('[worklets] bundled ->', outfile);
