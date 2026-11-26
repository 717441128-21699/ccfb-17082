// 应用入口：顶部导航 + 四个页面路由。仅在 tab 变化时重挂载页面，避免输入丢焦。

import './styles.css';
import { h, clear } from './ui/dom';
import { store, type TabId } from './ui/store';
import { renderImportPage } from './ui/pages/importPage';
import { renderEventsPage } from './ui/pages/eventsPage';
import { renderBeatsPage } from './ui/pages/beatsPage';
import { renderCorrectionPage } from './ui/pages/correctionPage';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'import', label: '录像导入', icon: '📥' },
  { id: 'events', label: '声光事件', icon: '🎆' },
  { id: 'beats', label: '节拍对照', icon: '🥁' },
  { id: 'correction', label: '点火修正', icon: '🎯' },
];

const app = document.querySelector<HTMLDivElement>('#app')!;
const pageHost = h('main', { class: 'page-host' });

function renderPage(tab: TabId): void {
  clear(pageHost);
  if (tab === 'import') renderImportPage(pageHost);
  else if (tab === 'events') renderEventsPage(pageHost);
  else if (tab === 'beats') renderBeatsPage(pageHost);
  else renderCorrectionPage(pageHost);
}

function renderChrome(): void {
  clear(app);
  const s = store.state;
  const nav = h('nav', { class: 'tabs' },
    ...TABS.map((t) => {
      const btn = h('button', {
        class: `tab ${s.tab === t.id ? 'active' : ''}`,
        type: 'button',
        'aria-current': s.tab === t.id ? 'page' : undefined,
      }, h('span', { class: 'tab-icon' }, t.icon), h('span', {}, t.label));
      btn.addEventListener('click', () => store.navigate(t.id));
      return btn;
    }),
  );

  const engineBadge = s.engine
    ? h('span', { class: `badge ${s.engine === 'audio-worklet' ? 'good' : 'warn'} engine-badge`, title: s.workletError ?? '' },
        s.engine === 'audio-worklet' ? 'AudioWorklet 检测中' : '主线程回退',
      )
    : null;

  const header = h('header', { class: 'app-header' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, '焰'),
      h('div', {},
        h('h1', {}, '焰拍核查'),
        h('div', { class: 'brand-sub' }, '音乐焰火 · 声光节拍 / 测距 / 点火修正'),
      ),
    ),
    h('div', { class: 'header-right' }, engineBadge, h('span', { class: 'badge muted' }, '本地处理 · 不上传')),
  );

  app.append(header, nav, pageHost, h('footer', { class: 'app-footer muted small' },
    '检测与节拍跟踪运行于 AudioWorklet + Web Audio API，其余 TypeScript · 运行 npm run verify 查看合成测试指标',
  ));
}

let lastTab = store.state.tab;
store.subscribe((s) => {
  if (s.tab !== lastTab) {
    lastTab = s.tab;
    // 更新 tab 高亮而不整体重建，避免不必要闪烁
    document.querySelectorAll('.tab').forEach((el, i) => {
      el.classList.toggle('active', TABS[i].id === s.tab);
    });
    renderPage(s.tab);
    window.scrollTo({ top: 0 });
  }
  // 引擎徽标异步出现时整体刷一次外壳（仅结果首次到达）
  const badgeEl = document.querySelector('.engine-badge');
  if (s.engine && !badgeEl) renderChrome();
});

renderChrome();
renderPage(store.state.tab);
