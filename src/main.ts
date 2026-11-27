import './styles.css';
import { store } from './app/store.js';
import { renderImportPage } from './app/pages/import-page.js';
import { renderEventsPage } from './app/pages/events-page.js';
import { renderBeatPage } from './app/pages/beat-page.js';
import { renderIgnitionPage } from './app/pages/ignition-page.js';

type TabId = 'import' | 'events' | 'beat' | 'ignition';

const TABS: { id: TabId; label: string }[] = [
  { id: 'import', label: '录像导入' },
  { id: 'events', label: '声光事件' },
  { id: 'beat', label: '节拍对照' },
  { id: 'ignition', label: '点火修正' },
];

const app = document.querySelector<HTMLDivElement>('#app')!;
let currentTab: TabId = 'import';

function render(): void {
  const s = store.getState();
  app.innerHTML = `
    <header class="app-header">
      <h1>焰火声光核查台</h1>
      <p>用观众席单部手机录像核查礼花是否卡在音乐重拍上，并反推点火修正量</p>
    </header>
    <nav class="tabs">
      ${TABS.map((t) => `<button data-tab="${t.id}" class="${t.id === currentTab ? 'active' : ''}">${t.label}</button>`).join('')}
    </nav>
    <main id="pageRoot"></main>
    <footer style="margin-top:30px;color:var(--muted);font-size:12px;border-top:1px solid var(--border);padding-top:14px">
      ${s.source === 'synthetic' ? '当前数据：合成测试录像（含真实值）' : s.videoName ? `当前数据：${s.videoName}` : '尚未加载数据'}
      ${s.analyzing ? ' · 分析中…' : ''}
    </footer>
  `;

  app.querySelectorAll<HTMLButtonElement>('nav.tabs button').forEach((btn) => {
    btn.onclick = () => {
      currentTab = btn.dataset.tab as TabId;
      render();
    };
  });

  const root = document.querySelector<HTMLElement>('#pageRoot')!;
  if (currentTab === 'import') renderImportPage(root);
  else if (currentTab === 'events') renderEventsPage(root);
  else if (currentTab === 'beat') renderBeatPage(root);
  else renderIgnitionPage(root);
}

store.subscribe(() => {
  // 分析状态变化时仅在非导入页重渲染，避免打断导入页的文件选择交互
  if (currentTab !== 'import') render();
});

render();
