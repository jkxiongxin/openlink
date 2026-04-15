import { bgFetch } from './runtime_bridge';
import { parseXmlToolCall, tryParseToolJSON } from './tool_parsers';

interface ToolObserverDeps {
  hashStr: (text: string) => number;
  getConversationId: () => string;
  getSourceKey: (sourceEl?: Element) => string;
  getToolCardMount: (sourceEl: Element) => { anchor: Element; before: Element | null } | null;
  isAssistantResponse: (el: Element | null) => boolean;
  shouldRenderToolText: (text: string, sourceEl?: Element) => boolean;
  fillAndSend: (result: string, autoSend?: boolean) => void | Promise<void>;
}

const EXECUTED_TTL = 7 * 24 * 60 * 60 * 1000;

function isExecuted(key: string): boolean {
  try {
    const store: Record<string, number> = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    return !!store[key];
  } catch { return false; }
}

function markExecuted(key: string): void {
  try {
    const store: Record<string, number> = JSON.parse(localStorage.getItem('openlink_executed') || '{}');
    const now = Date.now();
    for (const k of Object.keys(store)) {
      if (now - store[k] > EXECUTED_TTL) delete store[k];
    }
    store[key] = now;
    localStorage.setItem('openlink_executed', JSON.stringify(store));
  } catch {}
}

async function executeToolCallRaw(toolCall: any): Promise<string> {
  const { authToken, apiUrl } = await chrome.storage.local.get(['authToken', 'apiUrl']);
  if (!apiUrl) return '请先在插件中配置 API 地址';
  const headers: any = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const response = await bgFetch(`${apiUrl}/exec`, { method: 'POST', headers, body: JSON.stringify(toolCall) });
  if (response.status === 401) return '认证失败，请在插件中重新输入 Token';
  if (!response.ok) return `[OpenLink 错误] HTTP ${response.status}`;
  const result = JSON.parse(response.body);
  return result.output || result.error || '[OpenLink] 空响应';
}

export function createToolObserver(deps: ToolObserverDeps) {
  function renderToolCard(data: any, _full: string, sourceEl: Element, key: string, processed: Set<string>) {
    const mount = deps.getToolCardMount(sourceEl);
    if (!mount) return;
    const { anchor, before } = mount;

    if (anchor.querySelector(`[data-openlink-key="${key}"]`)) return;

    const args = data.args || {};
    const card = document.createElement('div');
    card.setAttribute('data-openlink-key', key);
    card.style.cssText = 'border:1px solid #444;border-radius:8px;padding:12px;margin:8px 0;background:#1e1e2e;color:#cdd6f4;font-size:13px';

    const header = document.createElement('div');
    header.style.cssText = 'font-weight:bold;margin-bottom:8px';
    header.innerHTML = `🔧 ${data.name} <span style="color:#888;font-size:11px">#${data.callId || ''}</span>`;
    card.appendChild(header);

    const argsBox = document.createElement('div');
    argsBox.style.cssText = 'margin:8px 0;background:#181825;border-radius:6px;padding:8px';
    for (const [k, v] of Object.entries(args)) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:4px';
      row.innerHTML = `<span style="color:#89b4fa;font-size:11px">${k}</span>`;
      const val = document.createElement('div');
      val.style.cssText = 'color:#cdd6f4;font-size:12px;font-family:monospace;white-space:pre-wrap;max-height:80px;overflow-y:auto';
      val.textContent = typeof v === 'string' ? v : JSON.stringify(v);
      row.appendChild(val);
      argsBox.appendChild(row);
    }
    card.appendChild(argsBox);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px';
    const execBtn = document.createElement('button');
    execBtn.textContent = '执行';
    execBtn.style.cssText = 'padding:4px 12px;background:#1677ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px';
    const skipBtn = document.createElement('button');
    skipBtn.textContent = '忽略';
    skipBtn.style.cssText = 'padding:4px 12px;background:#313244;color:#cdd6f4;border:1px solid #45475a;border-radius:6px;cursor:pointer;font-size:12px';
    btnRow.appendChild(execBtn);
    btnRow.appendChild(skipBtn);
    card.appendChild(btnRow);

    execBtn.onclick = async () => {
      execBtn.disabled = true;
      execBtn.textContent = '执行中...';
      markExecuted(key);
      try {
        const text = await executeToolCallRaw(data);
        const resultBox = document.createElement('div');
        resultBox.style.cssText = 'margin-top:10px;background:#181825;border-radius:6px;padding:8px;max-height:200px;overflow-y:auto;font-family:monospace;font-size:12px;color:#cdd6f4;white-space:pre-wrap';
        resultBox.textContent = text;
        const insertBtn = document.createElement('button');
        insertBtn.type = 'button';
        insertBtn.textContent = '插入到对话';
        insertBtn.style.cssText = 'margin-top:6px;padding:4px 12px;background:#313244;color:#89b4fa;border:1px solid #89b4fa;border-radius:6px;cursor:pointer;font-size:12px';
        insertBtn.onclick = () => { void deps.fillAndSend(text, true); };
        card.appendChild(resultBox);
        card.appendChild(insertBtn);
        execBtn.textContent = '✅ 已执行';
      } catch {
        execBtn.textContent = '❌ 执行失败';
        execBtn.disabled = false;
      }
    };

    skipBtn.onclick = () => { card.remove(); processed.delete(key); };

    if (before) anchor.insertBefore(card, before);
    else anchor.appendChild(card);
  }

  function startDOMObserver(responseSelector: string) {
    const processed = new Set<string>();
    const TOOL_RE = /<tool(?:\s[^>]*)?>[\s\S]*?<\/tool>/g;
    const responseSelectors = responseSelector.split(',').map(s => s.trim()).filter(Boolean);
    let autoExecute = false;
    chrome.storage.local.get(['autoExecute']).then(r => { autoExecute = !!r.autoExecute; });
    chrome.storage.onChanged.addListener((changes) => {
      if ('autoExecute' in changes) autoExecute = !!changes.autoExecute.newValue;
    });

    function scanText(text: string, sourceEl?: Element) {
      if (!text.includes('<tool')) return;
      if (sourceEl && !deps.isAssistantResponse(sourceEl)) return;
      if (!deps.shouldRenderToolText(text, sourceEl)) return;
      TOOL_RE.lastIndex = 0;
      let match;
      while ((match = TOOL_RE.exec(text)) !== null) {
        const full = match[0];
        const inner = full.replace(/^<tool[^>]*>|<\/tool>$/g, '').trim();
        const data = parseXmlToolCall(full) || tryParseToolJSON(inner);
        if (!data) { console.warn('[OpenLink] 工具调用解析失败:', full); continue; }
        const convId = deps.getConversationId();
        const sourceKey = deps.getSourceKey(sourceEl);
        const key = data.callId ? `${convId}:${data.name}:${data.callId}` : `${convId}:${sourceKey}:${deps.hashStr(full)}`;
        if (processed.has(key)) continue;
        console.log('[OpenLink] 提取到工具调用:', data);

        if (sourceEl) {
          processed.add(key);
          renderToolCard(data, full, sourceEl, key, processed);
          if (autoExecute && !isExecuted(key)) {
            markExecuted(key);
            window.postMessage({ type: 'TOOL_CALL', data }, '*');
          }
        } else {
          if (isExecuted(key)) continue;
          processed.add(key);
          markExecuted(key);
          window.postMessage({ type: 'TOOL_CALL', data }, '*');
        }
      }
    }

    function scanNode(node: Node) {
      let el: Element | null;
      if (node.nodeType === Node.TEXT_NODE) {
        el = (node as Text).parentElement;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        el = node as Element;
      } else {
        return;
      }
      if (!el) return;
      const mc = findResponseContainer(el);
      if (mc) scheduleScan(mc);
    }

    function findResponseContainer(el: Element | null): Element | null {
      while (el) {
        if (responseSelectors.some(sel => {
          try { return el!.matches(sel); } catch { return false; }
        }) && deps.isAssistantResponse(el)) return el;
        el = el.parentElement;
      }
      return null;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingContainers = new Set<Element>();

    const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const SKIP_TAGS = new Set(['MS-THOUGHT-CHUNK', 'MAT-ICON', 'SCRIPT', 'STYLE', 'BUTTON', 'MAT-EXPANSION-PANEL-HEADER']);

    function extractText(node: Node, buf: string[]): void {
      if (node.nodeType === Node.TEXT_NODE) {
        buf.push(node.textContent || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (BLOCK_TAGS.has(el.tagName)) buf.push('\n');
      for (const child of el.childNodes) {
        extractText(child, buf);
      }
    }

    function getCleanText(el: Element): string {
      const buf: string[] = [];
      extractText(el, buf);
      return buf.join('');
    }

    function scheduleScan(container: Element) {
      pendingContainers.add(container);
      if (!maxWaitTimer) {
        maxWaitTimer = setTimeout(() => {
          maxWaitTimer = null;
          if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
          const els = [...pendingContainers];
          pendingContainers.clear();
          requestAnimationFrame(() => {
            for (const el of els) scanText(getCleanText(el), el);
          });
        }, 3000);
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
        const els = [...pendingContainers];
        pendingContainers.clear();
        requestAnimationFrame(() => {
          for (const el of els) scanText(getCleanText(el), el);
        });
      }, 800);
    }

    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const container = findResponseContainer((mutation.target as Text).parentElement);
          if (container) scheduleScan(container);
        } else {
          mutation.addedNodes.forEach(scanNode);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });

    requestAnimationFrame(() => {
      document.querySelectorAll(responseSelector).forEach(el => {
        if (!deps.isAssistantResponse(el)) return;
        scanText(getCleanText(el), el);
      });
    });
  }

  return { startDOMObserver };
}
