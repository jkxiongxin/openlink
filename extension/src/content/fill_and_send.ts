import { debugLog } from './debug_log';
import {
  applyTextareaValue,
  getEditorCandidates,
  getVisibleTextareas,
  querySelectorFirst,
} from './editor_dom';
import type { SiteAdapter, SiteConfig } from './site_adapters';
import { showCountdownToast, showToast } from './ui_feedback';

interface FillAndSendDeps {
  getSiteAdapter(): SiteAdapter;
  getSiteConfig(): SiteConfig;
  getEditorText(editor: HTMLElement): string;
}

export function createFillAndSend(deps: FillAndSendDeps) {
  function clickStopButton(): void {
    const stopSel = deps.getSiteConfig().stopBtn;
    if (!stopSel) return;
    const btn = document.querySelector(stopSel) as HTMLElement | null;
    if (btn) btn.click();
  }

  function scoreEditorCandidate(el: HTMLElement): number {
    const rect = el.getBoundingClientRect();
    const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
    const nearBottom = Math.max(0, Math.min(window.innerHeight, rect.bottom));
    const area = Math.min(rect.width * rect.height, 200000);
    const submitBtn = getSendButtonForEditor(el, deps.getSiteConfig().sendBtn);
    const submitScore = submitBtn && !(submitBtn as HTMLButtonElement).disabled ? 2_000_000 : submitBtn ? 1_000_000 : 0;
    return submitScore + (inViewport ? 500_000 : 0) + nearBottom * 100 + area;
  }

  function getCurrentEditor(editorSel: string): HTMLElement | null {
    const selectors = editorSel.split(',').map((s) => s.trim()).filter(Boolean);
    const active = document.activeElement as HTMLElement | null;
    if (active && selectors.some((sel) => {
      try { return active.matches(sel); } catch { return false; }
    })) return active;

    const ranked = getEditorCandidates(editorSel).sort((a, b) => scoreEditorCandidate(b) - scoreEditorCandidate(a));
    if (ranked[0]) return ranked[0];
    return querySelectorFirst(editorSel);
  }

  function getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null {
    return deps.getSiteAdapter().getSendButton(editor, sendBtnSel);
  }

  async function fillArenaTextarea(result: string, editorSel: string, sendBtnSel: string): Promise<HTMLTextAreaElement | null> {
    const candidates = getEditorCandidates(editorSel)
      .filter((el): el is HTMLTextAreaElement => el instanceof HTMLTextAreaElement)
      .sort((a, b) => scoreEditorCandidate(b) - scoreEditorCandidate(a));

    for (const ta of candidates) {
      ta.focus();
      const current = ta.value;
      const next = current ? `${current}\n${result}` : result;
      applyTextareaValue(ta, next);
      await Promise.resolve();
      const submitBtn = getSendButtonForEditor(ta, sendBtnSel) as HTMLButtonElement | null;
      if (ta.value === next || (submitBtn && !submitBtn.disabled)) return ta;
    }

    const visibleTextareas = getVisibleTextareas();
    if (visibleTextareas.length === 1) {
      const ta = visibleTextareas[0];
      ta.focus();
      const current = ta.value;
      const next = current ? `${current}\n${result}` : result;
      applyTextareaValue(ta, next);
      await Promise.resolve();
      return ta;
    }

    showToast(`未命中活动输入框，候选数: ${candidates.length}`, 4000);
    return null;
  }

  async function fillAndSend(result: string, autoSend = false): Promise<void> {
    const adapter = deps.getSiteAdapter();
    const { editor: editorSel, sendBtn: sendBtnSel, fillMethod } = adapter.config;
    const editor = getCurrentEditor(editorSel);
    if (!editor) {
      const visibleTextareas = getVisibleTextareas().length;
      showToast(`未找到输入框，可见 textarea: ${visibleTextareas}`, 4000);
      return;
    }

    editor.focus();
    debugLog('开始填充输入框', { adapter: adapter.id, fillMethod, autoSend, resultPreview: result.slice(0, 120) });

    if (fillMethod === 'paste') {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', result);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
    } else if (fillMethod === 'execCommand') {
      document.execCommand('insertText', false, result);
    } else if (fillMethod === 'value') {
      if (adapter.fillValue) {
        const ok = await adapter.fillValue(editor, result, editorSel, sendBtnSel);
        if (!ok) return;
      } else {
        const ta = editor as HTMLTextAreaElement;
        const current = ta.value;
        const next = current ? `${current}\n${result}` : result;
        applyTextareaValue(ta, next);
      }
    } else if (fillMethod === 'prosemirror') {
      const current = deps.getEditorText(editor).trim();
      const textToInsert = current ? `\n${result}` : result;
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      try { document.execCommand('insertText', false, textToInsert); } catch {}
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textToInsert }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      if (!deps.getEditorText(editor).includes(result.trim())) {
        editor.textContent = current ? `${current}\n${result}` : result;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: result }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    if (!autoSend) return;

    const cfg = await chrome.storage.local.get(['autoSend', 'delayMin', 'delayMax']);
    if (cfg.autoSend === false) return;

    const min = (cfg.delayMin ?? 1) * 1000;
    const max = (cfg.delayMax ?? 4) * 1000;
    const delay = Math.random() * (max - min) + min;

    showCountdownToast(delay, () => {
      debugLog('自动发送倒计时结束', { adapter: adapter.id, delayMs: Math.round(delay) });
      const checkAndClick = (attempts = 0) => {
        if (attempts > 50) {
          const currentEditor = getCurrentEditor(editorSel);
          debugLog('未命中发送按钮，回退 Enter 提交', { adapter: adapter.id });
          if (currentEditor) {
            currentEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          }
          return;
        }
        const currentEditor = getCurrentEditor(editorSel);
        const sendBtn = currentEditor ? getSendButtonForEditor(currentEditor, sendBtnSel) : querySelectorFirst(sendBtnSel);
        if (sendBtn) {
          debugLog('命中发送按钮并点击', { adapter: adapter.id, attempts, text: (sendBtn.textContent || '').trim().slice(0, 60) });
          sendBtn.click();
        } else {
          if (attempts === 0 || attempts % 10 === 0) debugLog('等待发送按钮出现', { adapter: adapter.id, attempts });
          setTimeout(() => checkAndClick(attempts + 1), 100);
        }
      };
      checkAndClick();
    });
  }

  return {
    clickStopButton,
    fillAndSend,
    fillArenaTextarea,
    getCurrentEditor,
    getSendButtonForEditor,
  };
}
