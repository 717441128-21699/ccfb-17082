// 极简 hyperscript 辅助，保持 TypeScript 类型友好。

export type Child = Node | string | number | false | null | undefined;

export type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & {
  class?: string;
  dataset?: Record<string, string>;
  style?: string | Partial<CSSStyleDeclaration>;
} & Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps<K> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v as Record<string, string>)) el.dataset[dk] = dv;
      } else if (k === 'style' && typeof v === 'string') {
        el.style.cssText = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'html') {
        el.innerHTML = String(v);
      } else if (k === 'aria-current' || k.startsWith('aria-') || k.startsWith('data-')) {
        el.setAttribute(k, String(v));
      } else {
        (el as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  for (const c of children.flat()) {
    if (c === false || c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function badge(text: string, tone: 'good' | 'bad' | 'warn' | 'muted' | 'accent' = 'muted'): HTMLSpanElement {
  return h('span', { class: `badge badge-${tone}` }, text);
}

export function fmtMs(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)} ms`;
}

export function msTone(v: number | undefined): 'good' | 'bad' | 'warn' | 'muted' {
  if (v === undefined) return 'muted';
  const a = Math.abs(v);
  if (a <= 25) return 'good';
  if (a <= 80) return 'warn';
  return 'bad';
}
