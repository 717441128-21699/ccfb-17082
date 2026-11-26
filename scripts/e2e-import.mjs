// 端到端：在页面里录制 12s 合成 WebM -> 下载到磁盘 -> 通过文件输入真实导入分析。
import { chromium } from 'playwright-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:4180/';
const OUT = 'scripts/tmp-clip.webm';

const errors = [];
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.tab');

console.log('recording clip...');
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.getByRole('button', { name: /录制 12s/ }).click(),
]);
await download.saveAs(OUT);
console.log('downloaded ->', OUT);

await page.locator('input[type=file]').setInputFiles(OUT);
console.log('file chosen, waiting analysis...');
page.on('console', (m) => {
  const t = m.text();
  if (m.type() !== 'error' && /seek|分析|解码|Audio/i.test(t)) console.log('  [browser]', t);
});
try {
  await page.waitForSelector('.done-box:not(.hidden)', { timeout: 60000 });
} catch (e) {
  console.log('TIMEOUT. progress stage:', await page.locator('.progress-stage').textContent().catch(() => '?'));
  console.log('progress width:', await page.locator('.progress-fill').evaluate((el) => el.style.width).catch(() => '?'));
  console.log('error box:', await page.locator('.error-box').textContent().catch(() => '?'));
  console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
  await browser.close();
  process.exit(3);
}
const errVisible = await page.locator('.error-box:not(.hidden)').count();
console.log('error boxes visible:', errVisible);
if (errVisible) console.log('ERROR TEXT:', await page.locator('.error-box').textContent());

await page.getByRole('button', { name: /声光事件/ }).first().click();
await page.waitForSelector('.timeline-canvas', { timeout: 10000 });
await page.waitForTimeout(800);
const rows = await page.locator('.data-table tbody tr').count();
console.log('imported-video event rows:', rows);
const firstRow = await page.locator('.data-table tbody tr').first().textContent().catch(() => '');
console.log('first row:', firstRow?.replace(/\s+/g, ' ').trim().slice(0, 160));

console.log('PAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
await browser.close();
if (errors.length || errVisible) process.exit(2);
console.log('IMPORT E2E OK');
