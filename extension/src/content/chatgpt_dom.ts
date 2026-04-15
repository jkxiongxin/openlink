import { debugLog } from './debug_log';
import { isVisibleElement } from './editor_dom';
import { getElementPathKey } from './site_adapters';
import { clickElementLikeUser, sleep } from './dom_actions';

interface ChatGptDomDeps {
  referenceImageJobToFile(item: any, index: number, apiUrl?: string, authToken?: string): Promise<File>;
  setFileInputFiles(input: HTMLInputElement, files: File[]): void;
  getEditorText(el: HTMLElement): string;
  getSendButtonForEditor(editor: HTMLElement, sendBtnSel: string): HTMLElement | null;
  getSendButtonSelector(): string;
}

export function createChatGptDom(deps: ChatGptDomDeps) {
  async function clearChatGPTComposerAttachments(editor: HTMLElement): Promise<void> {
    for (let pass = 0; pass < 5; pass++) {
      const buttons = getChatGPTComposerRemoveButtons(editor);
      if (buttons.length === 0) return;
      debugLog('chatgpt 清理参考图', { pass: pass + 1, count: buttons.length });
      for (const btn of buttons) {
        await clickElementLikeUser(btn);
        await sleep(150);
      }
      await sleep(500);
    }
    const remaining = getChatGPTComposerAttachmentCount(editor);
    if (remaining > 0) debugLog('chatgpt 参考图未完全清理', { remaining });
  }

  async function setChatGPTPrompt(editor: HTMLElement, text: string) {
    editor.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    try { document.execCommand('delete', false); } catch {}
    await sleep(80);
    editor.focus();
    try { document.execCommand('insertText', false, text); } catch {}
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    if (!deps.getEditorText(editor).includes(text.trim())) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function waitForChatGPTSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement | null> {
    const deadline = Date.now() + timeoutMs;
    let lastState = '';
    while (Date.now() < deadline) {
      const sendBtn = deps.getSendButtonForEditor(editor, deps.getSendButtonSelector())
        ?? getChatGPTComposerRegion(editor).querySelector<HTMLElement>('button#composer-submit-button, button[data-testid="send-button"], button[aria-label="发送提示"], button[aria-label*="Send"]');
      if (sendBtn && isVisibleElement(sendBtn) && !(sendBtn as HTMLButtonElement).disabled) return sendBtn;

      const state = getChatGPTComposerButtonState(editor);
      const summary = JSON.stringify(state);
      if (summary !== lastState) {
        lastState = summary;
        debugLog('chatgpt 等待发送按钮', state);
      }
      await sleep(250);
    }
    debugLog('chatgpt 发送按钮等待超时', getChatGPTComposerButtonState(editor));
    return null;
  }

  async function attachChatGPTReferenceImages(editor: HTMLElement, items: any[], apiUrl: string, authToken: string): Promise<void> {
    const files = await Promise.all(items.map((item, index) => deps.referenceImageJobToFile(item, index, apiUrl, authToken)));
    const beforeCount = getChatGPTComposerAttachmentCount(editor);
    debugLog('chatgpt 开始附加参考图', {
      count: files.length,
      beforeCount,
      files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
    });

    const input = document.querySelector<HTMLInputElement>('input#upload-photos[type="file"], input#upload-files[type="file"], input[type="file"][accept*="image"]');
    if (!input) throw new Error('chatgpt file input not found');
    deps.setFileInputFiles(input, files);
    debugLog('chatgpt 已触发文件输入 change', { count: files.length });

    const expectedCount = beforeCount + files.length;
    const ready = await waitForChatGPTAttachmentReady(editor, expectedCount, 90000);
    debugLog('chatgpt 参考图附加完成', { expectedCount, ready, count: getChatGPTComposerAttachmentCount(editor) });
    if (!ready) throw new Error('chatgpt reference image did not stabilize before prompt');
  }

  function getChatGPTComposerRegion(editor: HTMLElement): Element {
    return editor.closest('form') ?? editor.closest('[data-testid*="composer"]') ?? editor.parentElement ?? document.body;
  }

  function getChatGPTComposerRemoveButtons(editor: HTMLElement): HTMLElement[] {
    const region = getChatGPTComposerRegion(editor);
    return Array.from(region.querySelectorAll<HTMLElement>('button[aria-label^="移除文件"], button[aria-label^="Remove file"], button[aria-label*="移除文件"], button[aria-label*="Remove file"]'))
      .filter((btn) => isVisibleElement(btn));
  }

  function getChatGPTComposerAttachmentCount(editor: HTMLElement): number {
    const region = getChatGPTComposerRegion(editor);
    const removeButtons = getChatGPTComposerRemoveButtons(editor);
    if (removeButtons.length > 0) return removeButtons.length;
    const images = Array.from(region.querySelectorAll<HTMLImageElement>('img')).filter((img) => {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src || !src.includes('/backend-api/estuary/content')) return false;
      if (!isVisibleElement(img)) return false;
      const rect = img.getBoundingClientRect();
      return rect.width > 16 && rect.height > 16;
    });
    return new Set(images.map((img) => img.currentSrc || img.getAttribute('src') || getElementPathKey(img))).size;
  }

  function getChatGPTComposerButtonState(editor: HTMLElement): Array<Record<string, unknown>> {
    const region = getChatGPTComposerRegion(editor);
    return Array.from(region.querySelectorAll<HTMLElement>('button'))
      .filter((btn) => isVisibleElement(btn))
      .map((btn) => ({
        ariaLabel: btn.getAttribute('aria-label') || '',
        testId: btn.getAttribute('data-testid') || '',
        id: btn.id || '',
        disabled: (btn as HTMLButtonElement).disabled,
        text: (btn.textContent || '').trim().slice(0, 40),
      }))
      .slice(-10);
  }

  async function waitForChatGPTAttachmentReady(editor: HTMLElement, expectedCount: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    let readySince = 0;
    while (Date.now() < deadline) {
      const count = getChatGPTComposerAttachmentCount(editor);
      if (count !== lastCount) {
        lastCount = count;
        readySince = 0;
        debugLog('chatgpt 等待参考图稳定', { expectedCount, count, timeoutMs });
      }
      if (count >= expectedCount) {
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 2500) return true;
      } else {
        readySince = 0;
      }
      await sleep(500);
    }
    return false;
  }

  function getChatGPTGeneratedImageElements(): HTMLImageElement[] {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('img[src*="/backend-api/estuary/content"], img[src*="chatgpt.com/backend-api/estuary/content"]'));
    const generatedSrcs = new Set(images
      .filter((img) => {
        if (isChatGPTComposerImage(img) || isChatGPTUserUploadedImage(img)) return false;
        const alt = (img.getAttribute('alt') || '').toLowerCase();
        return alt.includes('已生成') || alt.includes('generated');
      })
      .map((img) => img.currentSrc || img.getAttribute('src') || '')
      .filter(Boolean));
    return images.filter((img) => {
      if (isChatGPTComposerImage(img)) return false;
      if (isChatGPTUserUploadedImage(img)) return false;
      if (!isVisibleElement(img)) return false;
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src) return false;
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      if (alt.includes('已上传') || alt.includes('uploaded')) return false;
      if (generatedSrcs.has(src)) return true;
      const bigEnough = img.naturalWidth >= 256 || img.getBoundingClientRect().width >= 180;
      return bigEnough && (alt.includes('已生成') || alt.includes('generated'));
    });
  }

  function isChatGPTComposerImage(img: HTMLImageElement): boolean {
    const composerForm = img.closest('form');
    if (composerForm?.querySelector('#prompt-textarea')) return true;
    const composerRegion = img.closest('[data-testid*="composer"], .group\\/composer');
    return !!composerRegion;
  }

  function isChatGPTUserUploadedImage(img: HTMLImageElement): boolean {
    const message = img.closest('[data-message-author-role]');
    if (message?.getAttribute('data-message-author-role') === 'user') return true;
    const alt = (img.getAttribute('alt') || '').toLowerCase();
    return alt.includes('已上传') || alt.includes('uploaded');
  }

  function getChatGPTImageKeys(): string[] {
    return Array.from(new Set(getChatGPTGeneratedImageElements()
      .map((img) => img.currentSrc || img.getAttribute('src') || '')
      .filter(Boolean)));
  }

  async function waitForNewChatGPTImage(previousKeysInput: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement> {
    const deadline = Date.now() + timeoutMs;
    const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
    debugLog('chatgpt 等待新图片', { previousKeys: Array.from(previousKeys), timeoutMs });
    let lastSeenKeys = '';
    while (Date.now() < deadline) {
      const currentKeys = getChatGPTImageKeys();
      const currentKeySummary = currentKeys.join(',');
      if (currentKeySummary !== lastSeenKeys) {
        lastSeenKeys = currentKeySummary;
        debugLog('chatgpt 当前图片 key', currentKeys);
      }
      const images = getChatGPTGeneratedImageElements();
      for (let i = images.length - 1; i >= 0; i--) {
        const img = images[i];
        const key = img.currentSrc || img.getAttribute('src') || '';
        if (!key || previousKeys.has(key)) continue;
        if (img.complete && (img.naturalWidth > 0 || img.getBoundingClientRect().width >= 180)) {
          debugLog('chatgpt 新图片已就绪', { key, width: img.naturalWidth, height: img.naturalHeight, alt: img.getAttribute('alt') || '' });
          return img;
        }
      }
      await sleep(1000);
    }
    debugLog('chatgpt 等待新图片超时', { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getChatGPTImageKeys() });
    throw new Error('wait for chatgpt generated image timed out');
  }

  return {
    clearChatGPTComposerAttachments,
    getChatGPTComposerAttachmentCount,
    attachChatGPTReferenceImages,
    setChatGPTPrompt,
    waitForChatGPTSendButton,
    getChatGPTImageKeys,
    waitForNewChatGPTImage,
  };
}
