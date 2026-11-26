// 端到端冒烟：驱动系统 Chrome 打开 preview，运行合成核查并遍历四个页签。
// 用法：node scripts/e2e-smoke.mjs
import { chromium } from 'playwright-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.SMOKE_URL || 'http://127.0.0.1:4173/';

const errors = [];
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function waitServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(URL);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('preview server not reachable');
}
await waitServer();
await page.goto(URL, { waitUntil: 'networkidle' });

// 1) 外壳渲染
await page.waitForSelector('.tab', { timeout: 10000 });
const tabCount = await page.locator('.tab').count();
console.log('tabs:', tabCount);
if (tabCount !== 4) throw new Error('expected 4 tabs');
const title = await page.locator('h1').first().textContent();
console.log('title:', title);

// benchmark banner loads
await page.waitForSelector('.metric-chip', { timeout: 8000 }).catch(() => {});
const chips = await page.locator('.metric-chip').count();
console.log('benchmark chips:', chips);

// 2) 运行合成核查（默认 80s 峡谷）
console.log('clicking synth analyze...');
await page.getByRole('button', { name: /合成场景并核查/ }).click();
await page.waitForSelector('.done-box:not(.hidden)', { timeout: 90000 });
const engine = (await page.locator('.engine-note').textContent().catch(() => 'n/a')) || 'n/a';
console.log('engine badge:', engine);
const synthStatus = await page.locator('.synth-status').textContent();
console.log('status:', synthStatus);

// 3) 声光事件页
await page.getByRole('button', { name: /声光事件/ }).first().click();
await page.waitForSelector('.timeline-canvas', { timeout: 10000 });
await page.waitForTimeout(600); // 等 canvas 绘制
const eventRows = await page.locator('.data-table tbody tr').count();
const statCards = await page.locator('.stat-card').count();
console.log('events rows:', eventRows, 'stat cards:', statCards);
if (eventRows < 10) throw new Error('too few event rows');

// 4) 节拍对照页
await page.getByRole('button', { name: /节拍对照/ }).first().click();
await page.waitForSelector('.offset-row', { timeout: 10000 });
const offsetRows = await page.locator('.offset-row').count();
const beatText = await page.locator('.stat-card').nth(0).textContent();
console.log('offset rows:', offsetRows, 'bpm card:', beatText);
if (offsetRows < 10) throw new Error('too few offset rows');

// “按平均偏差整体移动”按钮存在
await page.getByRole('button', { name: /前往点火修正/ }).click();

// 5) 点火修正页
await page.waitForSelector('.correction-table tbody tr', { timeout: 10000 });
const corrRows = await page.locator('.correction-table tbody tr').count();
console.log('correction rows:', corrRows);
if (corrRows < 10) throw new Error('too few correction rows');
// 编辑第一行计划点火时刻，确认不崩
const firstIgn = page.locator('.correction-table tbody tr input[type=number]').nth(2);
await firstIgn.fill('12.345');
await firstIgn.dispatchEvent('change');
await page.waitForTimeout(100);
const newIgnCell = await page.locator('.correction-table tbody tr .c-newign').first().textContent();
console.log('after edit suggested ignition:', newIgnCell);

// 导出按钮存在性
const csvBtn = await page.getByRole('button', { name: /导出核查 CSV/ }).count();
console.log('csv button:', csvBtn);

// 6) 回到导入页拖动气温滑块，确认距离重算不崩
await page.getByRole('button', { name: /录像导入/ }).first().click();
await page.waitForSelector('input[type=range]', { timeout: 5000 });
const range = page.locator('input[type=range]');
await range.fill('-10');
await range.dispatchEvent('input');
await page.waitForTimeout(100);
const tempNote = await page.locator('.temp-note').textContent();
console.log('temp note:', tempNote);

console.log('\nPAGE ERRORS:', errors.length ? '\n' + errors.join('\n') : 'none');
await browser.close();
if (errors.length) process.exit(2);
console.log('SMOKE OK');
