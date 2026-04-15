import type { SiteConfig } from './site_adapters';

type BgFetchResponse = { ok: boolean; status: number; body: string };

interface InputCompletionDeps {
  bgFetch(url: string, options?: any): Promise<BgFetchResponse>;
  getCurrentEditor(editorSel: string): HTMLElement | null;
  getNativeSetter(): ((this: HTMLTextAreaElement, value: string) => void) | undefined;
  getSiteConfig(): SiteConfig;
}

export function getEditorText(el: HTMLElement): string {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return (el as HTMLTextAreaElement).value;
  }
  return el.innerText || '';
}

function getCaretPosition(el: HTMLElement): number {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    return (el as HTMLTextAreaElement).selectionStart ?? 0;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
  return range.toString().length;
}

function showPickerPopup(
  anchorEl: HTMLElement,
  items: Array<{ label: string; sub?: string; value: string }>,
  onSelect: (value: string) => void,
  onDismiss: () => void
): () => void {
  const popup = document.createElement('div');
  popup.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:4px;min-width:240px;max-width:400px;max-height:240px;overflow-y:auto;box-shadow:0 4px 16px rgba(0,0,0,0.5)';

  let activeIdx = 0;
  const rows: HTMLElement[] = [];

  function render() {
    popup.innerHTML = '';
    rows.length = 0;
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 12px;color:#6c7086;font-size:12px';
      empty.textContent = '无匹配项';
      popup.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.style.cssText = `padding:6px 12px;border-radius:6px;cursor:pointer;display:flex;flex-direction:column;gap:2px;background:${i === activeIdx ? '#313244' : 'transparent'}`;
      const label = document.createElement('span');
      label.style.cssText = 'color:#cdd6f4;font-size:13px';
      label.textContent = item.label;
      row.appendChild(label);
      if (item.sub) {
        const sub = document.createElement('span');
        sub.style.cssText = 'color:#6c7086;font-size:11px';
        sub.textContent = item.sub;
        row.appendChild(sub);
      }
      row.onmouseenter = () => { setActive(i); };
      row.onclick = () => { onSelect(item.value); destroy(); };
      rows.push(row);
      popup.appendChild(row);
    });
  }

  function setActive(i: number) {
    if (rows[activeIdx]) rows[activeIdx].style.background = 'transparent';
    activeIdx = i;
    if (rows[activeIdx]) {
      rows[activeIdx].style.background = '#313244';
      rows[activeIdx].scrollIntoView({ block: 'nearest' });
    }
  }

  function reposition() {
    const rect = anchorEl.getBoundingClientRect();
    const popupH = Math.min(240, popup.scrollHeight || 240);
    const spaceAbove = rect.top - 6;
    const spaceBelow = window.innerHeight - rect.bottom - 6;
    if (spaceAbove >= popupH || spaceAbove >= spaceBelow) {
      popup.style.top = `${Math.max(4, rect.top - popupH - 6)}px`;
    } else {
      popup.style.top = `${rect.bottom + 6}px`;
    }
    popup.style.left = `${rect.left}px`;
    popup.style.width = `${Math.min(400, rect.width)}px`;
  }

  render();
  document.body.appendChild(popup);
  reposition();

  function onKeyDown(e: KeyboardEvent) {
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((activeIdx + 1) % items.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((activeIdx - 1 + items.length) % items.length); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onSelect(items[activeIdx].value); destroy(); }
    else if (e.key === 'Escape') { onDismiss(); destroy(); }
  }

  function onMouseDown(e: MouseEvent) {
    if (!popup.contains(e.target as Node)) { onDismiss(); destroy(); }
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  function destroy() {
    popup.remove();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  }

  return destroy;
}

function replaceTokenInEditor(
  el: HTMLElement,
  token: string,
  replacement: string,
  fillMethod: string,
  getNativeSetter: InputCompletionDeps['getNativeSetter']
) {
  if (fillMethod === 'value') {
    const ta = el as HTMLTextAreaElement;
    const val = ta.value;
    const pos = ta.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const after = val.slice(pos);
    const tokenStart = before.lastIndexOf(token);
    if (tokenStart === -1) return;
    const newVal = val.slice(0, tokenStart) + replacement + after;
    const nativeSetter = getNativeSetter();
    if (nativeSetter) nativeSetter.call(ta, newVal);
    else ta.value = newVal;
    const newCaret = tokenStart + replacement.length;
    ta.setSelectionRange(newCaret, newCaret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (fillMethod === 'execCommand' || fillMethod === 'prosemirror') {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const text = getEditorText(el);
    const pos = getCaretPosition(el);
    const before = text.slice(0, pos);
    const tokenStart = before.lastIndexOf(token);
    if (tokenStart === -1) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode: Text | null = null, startOffset = 0;
    let endNode: Text | null = null, endOffset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const len = node.textContent?.length ?? 0;
      if (!startNode && charCount + len > tokenStart) {
        startNode = node;
        startOffset = tokenStart - charCount;
      }
      if (startNode && !endNode && charCount + len >= tokenStart + token.length) {
        endNode = node;
        endOffset = tokenStart + token.length - charCount;
        break;
      }
      charCount += len;
    }
    if (startNode && endNode) {
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, replacement);
    }
  } else {
    const ta = el as HTMLTextAreaElement;
    const val = ta.tagName === 'TEXTAREA' ? ta.value : el.innerText;
    const tokenStart = val.lastIndexOf(token);
    if (tokenStart !== -1 && ta.tagName === 'TEXTAREA') {
      const newVal = val.slice(0, tokenStart) + val.slice(tokenStart + token.length);
      const nativeSetter = getNativeSetter();
      if (nativeSetter) nativeSetter.call(ta, newVal);
      else ta.value = newVal;
      ta.setSelectionRange(tokenStart, tokenStart);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', replacement);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
  }
}

export function createInputCompletion(deps: InputCompletionDeps): { mountInputListener(): void } {
  let skillsCache: Array<{ name: string; description: string }> | null = null;
  let skillsCacheTime = 0;
  const filesCache = new Map<string, { ts: number; files: string[] }>();
  const filesTTL = 5000;

  async function fetchSkills(): Promise<Array<{ name: string; description: string }>> {
    if (skillsCache && Date.now() - skillsCacheTime < 30000) return skillsCache;
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    if (!apiUrl) return [];
    const headers: any = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await deps.bgFetch(`${apiUrl}/skills`, { headers });
      if (!resp.ok) return [];
      const data = JSON.parse(resp.body);
      skillsCache = data.skills || [];
      skillsCacheTime = Date.now();
      return skillsCache!;
    } catch { return []; }
  }

  async function fetchFiles(q: string): Promise<string[]> {
    const cached = filesCache.get(q);
    if (cached && Date.now() - cached.ts < filesTTL) return cached.files;
    const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
    if (!apiUrl) return [];
    const headers: any = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await deps.bgFetch(`${apiUrl}/files?q=${encodeURIComponent(q)}`, { headers });
      if (!resp.ok) return [];
      const data = JSON.parse(resp.body);
      const files = data.files || [];
      filesCache.set(q, { ts: Date.now(), files });
      return files;
    } catch { return []; }
  }

  function attachInputListener(editorEl: HTMLElement) {
    if ((editorEl as any).__openlinkInputBound) return;
    (editorEl as any).__openlinkInputBound = true;
    const { fillMethod } = deps.getSiteConfig();
    let destroyPicker: (() => void) | null = null;
    let inputVersion = 0;

    function dismiss() {
      if (destroyPicker) { destroyPicker(); destroyPicker = null; }
    }

    editorEl.addEventListener('input', async () => {
      const currentVersion = ++inputVersion;
      const text = getEditorText(editorEl);
      const pos = getCaretPosition(editorEl);
      const before = text.slice(0, pos);

      const slashMatch = before.match(/(?:^|[\s\n\u00a0])(\/([\w-]*))$/);
      if (slashMatch) {
        const token = slashMatch[1];
        const query = slashMatch[2].toLowerCase();
        const skills = await fetchSkills();
        if (currentVersion !== inputVersion) return;
        const filtered = query
          ? skills.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
          : skills;
        dismiss();
        if (filtered.length === 0) return;
        destroyPicker = showPickerPopup(
          editorEl,
          filtered.map(s => ({
            label: s.name,
            sub: s.description,
            value: `<tool name="skill">\n  <parameter name="skill">${s.name}</parameter>\n</tool>`,
          })),
          (xml) => { replaceTokenInEditor(editorEl, token, xml, fillMethod, deps.getNativeSetter); dismiss(); },
          dismiss
        );
        return;
      }

      const atMatch = before.match(/@([^\s]*)$/);
      if (atMatch) {
        const token = atMatch[0];
        const query = atMatch[1];
        const files = await fetchFiles(query);
        if (currentVersion !== inputVersion) return;
        dismiss();
        if (files.length === 0) return;
        destroyPicker = showPickerPopup(
          editorEl,
          files.map(f => ({ label: f, value: f })),
          (path) => { replaceTokenInEditor(editorEl, token, path, fillMethod, deps.getNativeSetter); dismiss(); },
          dismiss
        );
        return;
      }

      dismiss();
    });
  }

  function mountInputListener() {
    const { editor: editorSel } = deps.getSiteConfig();

    const attachCurrent = () => {
      const editorEl = deps.getCurrentEditor(editorSel);
      if (editorEl) attachInputListener(editorEl);
    };

    attachCurrent();

    const obs = new MutationObserver(() => attachCurrent());
    obs.observe(document.body, { childList: true, subtree: true });
  }

  return { mountInputListener };
}
