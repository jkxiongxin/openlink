import { debugLog } from './debug_log';
import { sleep } from './dom_actions';
import { applyTextareaValue, insertContentEditableText, isVisibleElement, normalizeEditorPlainText, setContentEditablePlainText } from './editor_dom';
import type { SiteAdapter } from './site_adapters';

interface BrowserTextInputDeps {
  getSiteAdapter(): SiteAdapter;
  getCurrentEditor(selector: string): HTMLElement | null;
  getEditorText(editor: HTMLElement): string;
  getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null;
  setGeminiPrompt(editor: HTMLElement, text: string): Promise<void>;
  setChatGPTPrompt(editor: HTMLElement, text: string): Promise<void>;
  setQwenPrompt(editor: HTMLTextAreaElement, text: string): void;
  waitForChatGPTSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null>;
  waitForQwenSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null>;
}

export function createBrowserTextInput(deps: BrowserTextInputDeps) {
  async function waitForCurrentEditor(selector: string, timeoutMs: number): Promise<HTMLElement> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const editor = deps.getCurrentEditor(selector);
      if (editor) return editor;
      await sleep(250);
    }
    throw new Error(`editor not found: ${selector}`);
  }

  async function setBrowserTextPrompt(editor: HTMLElement, text: string): Promise<void> {
    const adapter = deps.getSiteAdapter();
    if (adapter.id === 'gemini') {
      await deps.setGeminiPrompt(editor, text);
      return;
    }
    if (adapter.id === 'chatgpt') {
      await deps.setChatGPTPrompt(editor, text);
      return;
    }
    if (adapter.id === 'kimi') {
      await setKimiPrompt(editor, text);
      return;
    }
    if (adapter.id === 'qwen' && editor instanceof HTMLTextAreaElement) {
      deps.setQwenPrompt(editor, text);
      await sleep(250);
      return;
    }
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      applyTextareaValue(editor as HTMLTextAreaElement, text);
      await sleep(250);
      return;
    }
    editor.focus();
    try {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('delete', false);
      document.execCommand('insertText', false, text);
    } catch {}
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    if (normalizeEditorPlainText(deps.getEditorText(editor)) !== normalizeEditorPlainText(text)) {
      setContentEditablePlainText(editor, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
    }
  }

  async function setKimiPrompt(editor: HTMLElement, text: string): Promise<void> {
    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      applyTextareaValue(editor as HTMLTextAreaElement, text);
      await sleep(250);
      return;
    }

    insertContentEditableText(editor, text);
    await sleep(250);
    if (normalizeEditorPlainText(deps.getEditorText(editor)) !== normalizeEditorPlainText(text)) {
      insertContentEditableText(editor, text);
      await sleep(250);
    }
    const actual = normalizeEditorPlainText(deps.getEditorText(editor));
    const expected = normalizeEditorPlainText(text);
    if (actual !== expected) {
      throw new Error(`kimi prompt write mismatch: expected_len=${expected.length} actual_len=${actual.length} actual_preview=${actual.slice(0, 120)}`);
    }
  }

  async function waitForBrowserTextSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> {
    const adapter = deps.getSiteAdapter();
    if (adapter.id === 'chatgpt') return deps.waitForChatGPTSendButton(editor, timeoutMs);
    if (adapter.id === 'qwen') return deps.waitForQwenSendButton(editor, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let lastState = '';
    while (Date.now() < deadline) {
      const sendBtn = deps.getSendButtonForEditor(editor, adapter.config.sendBtn);
      if (sendBtn && isVisibleElement(sendBtn) && !(sendBtn as HTMLButtonElement).disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
        return sendBtn;
      }
      const state = sendBtn ? {
        disabled: (sendBtn as HTMLButtonElement).disabled,
        ariaDisabled: sendBtn.getAttribute('aria-disabled') || '',
        text: (sendBtn.textContent || '').trim().slice(0, 40),
      } : { missing: true };
      const summary = JSON.stringify(state);
      if (summary !== lastState) {
        lastState = summary;
        debugLog('text job 等待发送按钮', { siteID: adapter.id, ...state });
      }
      await sleep(250);
    }
    return null;
  }

  return {
    waitForCurrentEditor,
    setBrowserTextPrompt,
    waitForBrowserTextSendButton,
  };
}
