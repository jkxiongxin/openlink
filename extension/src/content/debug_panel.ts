import { clearDebugLogs, debugLog, getDebugLogs, setDebugModeEnabled, setDebugPanelLogElement } from './debug_log';
import type { SiteAdapter, SiteConfig } from './site_adapters';
import { shortenHtml } from './text_utils';

interface DebugPanelDeps {
  sendInitPrompt: () => void | Promise<void>;
  getSiteConfig: () => SiteConfig;
  getSiteAdapter: () => SiteAdapter;
  getCurrentEditor: (editorSel: string) => HTMLElement | null;
  getEditorCandidates: (editorSel: string) => HTMLElement[];
  getVisibleTextareas: () => HTMLTextAreaElement[];
  getEditorRegion: (editor: Element | null) => Element | null;
  getLabsFxDebugState: () => { projectId: string; apiHeaderKeys: string[] };
  getAutoCaptchaFarmerStats: () => unknown;
  registerBrowserTextWorker: (trigger: string) => Promise<Record<string, unknown>>;
  markBrowserTextResponseEnded: (trigger: string) => void;
  showToast: (message: string, durationMs?: number) => void;
}

export function createDebugPanelController(deps: DebugPanelDeps) {
  function injectFloatingButton(id: string, label: string, bottom: number, background: string, onClick: () => void | Promise<void>) {
    document.getElementById(id)?.remove();
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = `position:fixed;bottom:${bottom}px;right:20px;z-index:99999;padding:8px 14px;background:${background};color:#fff;border:none;border-radius:20px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.3)`;
    btn.onclick = () => { void onClick(); };
    document.body.appendChild(btn);
  }

  function injectInitButton() {
    injectFloatingButton('openlink-init-btn', '🔗 初始化', 80, '#1677ff', deps.sendInitPrompt);
  }

  function removeDebugPanel() {
    document.getElementById('openlink-debug-panel')?.remove();
    setDebugPanelLogElement(null);
  }

  function elementSnapshot(el: Element | null) {
    if (!el) return null;
    const htmlEl = el as HTMLElement;
    const rect = htmlEl.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      className: el.className || '',
      name: el.getAttribute('name') || '',
      placeholder: el.getAttribute('placeholder') || '',
      type: el.getAttribute('type') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      readOnly: htmlEl instanceof HTMLTextAreaElement ? htmlEl.readOnly : false,
      disabled: htmlEl instanceof HTMLButtonElement || htmlEl instanceof HTMLTextAreaElement ? htmlEl.disabled : false,
      value: htmlEl instanceof HTMLTextAreaElement ? htmlEl.value : '',
      text: (htmlEl.innerText || '').slice(0, 500),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      outerHTML: shortenHtml(el.outerHTML || ''),
    };
  }

  function getNearbyButtons(editor: Element | null): Element[] {
    const region = deps.getEditorRegion(editor);
    if (!region) return [];
    return Array.from(region.querySelectorAll('button, [role="button"]')).slice(0, 12);
  }

  function collectDebugData() {
    const cfg = deps.getSiteConfig();
    const editorCandidates = deps.getEditorCandidates(cfg.editor);
    const visibleTextareas = deps.getVisibleTextareas();
    const currentEditor = deps.getCurrentEditor(cfg.editor);
    const editorRegion = deps.getEditorRegion(currentEditor);
    const sendButtons = Array.from(document.querySelectorAll(cfg.sendBtn.split(',').map(s => s.trim()).filter(Boolean).join(',')));
    const responseNodes = cfg.responseSelector ? Array.from(document.querySelectorAll(cfg.responseSelector)).slice(-3) : [];
    const toolNodes = Array.from(document.querySelectorAll('.prose, message-content, ms-chat-turn'))
      .filter((el) => (el.textContent || '').includes('<tool'))
      .slice(-3);
    const labsFxDebug = deps.getLabsFxDebugState();
    const autoCaptchaFarmerStats = deps.getAutoCaptchaFarmerStats();
    return {
      capturedAt: new Date().toISOString(),
      location: { href: location.href, hostname: location.hostname, pathname: location.pathname },
      adapterId: deps.getSiteAdapter().id,
      siteConfig: cfg,
      activeElement: elementSnapshot(document.activeElement as Element | null),
      currentEditor: elementSnapshot(currentEditor),
      editorRegion: elementSnapshot(editorRegion),
      visibleTextareaCount: visibleTextareas.length,
      editorCandidateCount: editorCandidates.length,
      visibleTextareas: visibleTextareas.map((el) => elementSnapshot(el)),
      editorCandidates: editorCandidates.map((el) => elementSnapshot(el)),
      sendButtons: sendButtons.map((el) => elementSnapshot(el)),
      nearbyButtons: getNearbyButtons(currentEditor).map((el) => elementSnapshot(el)),
      latestResponses: responseNodes.map((el) => elementSnapshot(el)),
      latestToolContainers: toolNodes.map((el) => elementSnapshot(el)),
      labsFxProjectId: labsFxDebug.projectId,
      labsFxAPIHeaderKeys: labsFxDebug.apiHeaderKeys,
      autoCaptchaFarmerStats,
      debugLogs: getDebugLogs(),
    };
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
    deps.showToast('已复制到剪贴板', 2000);
  }

  function downloadText(filename: string, text: string) {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    deps.showToast(`已下载 ${filename}`, 2000);
  }

  function injectDebugPanel() {
    if (document.getElementById('openlink-debug-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'openlink-debug-panel';
    panel.style.cssText = 'position:fixed;bottom:180px;right:20px;z-index:99999;width:320px;max-height:70vh;background:#111827;color:#f3f4f6;border:1px solid #374151;border-radius:12px;padding:10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);font-size:12px;display:flex;flex-direction:column';

    const title = document.createElement('div');
    title.textContent = 'OpenLink 调试模式';
    title.style.cssText = 'font-weight:700;margin-bottom:8px';
    panel.appendChild(title);

    const actions: Array<{ label: string; onClick: () => void | Promise<void> }> = [
      {
        label: '复制调试 JSON',
        onClick: () => copyText(JSON.stringify(collectDebugData(), null, 2)),
      },
      {
        label: '下载调试 JSON',
        onClick: () => {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          downloadText(`openlink-debug-${stamp}.json`, JSON.stringify(collectDebugData(), null, 2));
        },
      },
      {
        label: '复制当前输入框 HTML',
        onClick: () => copyText((collectDebugData().currentEditor?.outerHTML) || ''),
      },
      {
        label: '复制当前输入区 HTML',
        onClick: () => copyText((collectDebugData().editorRegion?.outerHTML) || ''),
      },
      {
        label: '复制候选发送按钮 HTML',
        onClick: () => {
          const html = collectDebugData().nearbyButtons.map((item) => item?.outerHTML || '').join('\n\n');
          void copyText(html);
        },
      },
      {
        label: '复制最近回复 HTML',
        onClick: () => {
          const latestResponses = collectDebugData().latestResponses;
          const last = latestResponses[latestResponses.length - 1];
          void copyText(last?.outerHTML || '');
        },
      },
      {
        label: '复制调试日志',
        onClick: () => copyText(getDebugLogs().join('\n')),
      },
      {
        label: '清空调试日志',
        onClick: () => {
          clearDebugLogs();
          deps.showToast('已清空调试日志', 2000);
        },
      },
      {
        label: '手动注册文本 worker',
        onClick: async () => {
          try {
            const payload = await deps.registerBrowserTextWorker('debug-panel');
            deps.showToast(`文本 worker 已注册: ${JSON.stringify(payload).slice(0, 120)}`, 3500);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            debugLog('手动注册文本 worker 失败', { error: message });
            deps.showToast(`注册失败: ${message}`, 5000);
          }
        },
      },
      {
        label: '标记 AI 响应结束',
        onClick: () => deps.markBrowserTextResponseEnded('debug-panel'),
      },
    ];

    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.style.cssText = 'display:block;width:100%;margin-top:6px;padding:7px 10px;background:#1f2937;color:#f9fafb;border:1px solid #4b5563;border-radius:8px;cursor:pointer;text-align:left';
      btn.onclick = () => { void action.onClick(); };
      panel.appendChild(btn);
    }

    const hint = document.createElement('div');
    hint.textContent = '用于抓取站点兼容信息';
    hint.style.cssText = 'margin-top:8px;color:#9ca3af;line-height:1.4';
    panel.appendChild(hint);

    const logTitle = document.createElement('div');
    logTitle.textContent = '实时日志';
    logTitle.style.cssText = 'margin-top:8px;margin-bottom:6px;font-weight:700';
    panel.appendChild(logTitle);

    const logBox = document.createElement('pre');
    logBox.style.cssText = 'margin:0;flex:1;min-height:180px;max-height:260px;overflow:auto;background:#030712;border:1px solid #374151;border-radius:8px;padding:8px;color:#d1fae5;font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word';
    panel.appendChild(logBox);
    setDebugPanelLogElement(logBox);

    document.body.appendChild(panel);
    debugLog('调试面板已挂载');
  }

  function mountDebugUi(debugMode: boolean) {
    injectInitButton();
    setDebugModeEnabled(debugMode);
    if (debugMode) injectDebugPanel();
    else removeDebugPanel();
  }

  return { mountDebugUi };
}
