import { debugLog } from './debug_log';
import { clickElementLikeUser, sleep } from './dom_actions';
import { isVisibleElement } from './editor_dom';
import { blobToBase64 } from './media_utils';
import { defaultEditorRegion } from './site_adapters';

interface GeminiDomDeps {
  referenceImageJobToFile(item: any, index: number, apiUrl?: string, authToken?: string): Promise<File>;
  setFileInputFiles(input: HTMLInputElement, files: File[]): void;
  getEditorText(editor: HTMLElement): string;
  getSendButtonSelector(): string;
}

export function createGeminiDom(deps: GeminiDomDeps) {
  let latestMediaURLs: string[] = [];
  let mediaSeq = 0;
  let referenceAttachSeq = 0;

  function resetGeminiMediaCapture(): void {
    latestMediaURLs = [];
  }

  function recordGeminiMediaCapture(urls: string[]): { seq: number; urls: string[] } {
    latestMediaURLs = urls;
    mediaSeq += 1;
    return { seq: mediaSeq, urls: latestMediaURLs };
  }

  function getGeminiMediaSeq(): number {
    return mediaSeq;
  }

  async function setGeminiPrompt(editor: HTMLElement, text: string) {
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
    try {
      document.execCommand('insertText', false, text);
    } catch {}
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    if (!deps.getEditorText(editor).includes(text.trim())) {
      editor.textContent = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function findGeminiComposerRegion(editor: Element | null): Element | null {
    if (!editor) return null;
    const selectors = [
      'input-area-v2',
      'fieldset',
      'input-container',
      '.text-input-field',
      'form',
      'message-composer',
      '[role="group"]',
      '[data-test-id*="composer"]',
      '[data-testid*="composer"]',
    ];
    const candidates: Element[] = [];
    for (const selector of selectors) {
      const candidate = editor.closest(selector);
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    }
    for (let node: Element | null = editor; node && node !== document.body; node = node.parentElement) {
      if (!candidates.includes(node)) candidates.push(node);
    }

    const composerChromeSelector = [
      deps.getSendButtonSelector(),
      'button[aria-controls="upload-file-menu"]',
      'input[type="file"]',
      '.file-preview-container',
      '.attachment-preview-wrapper',
      'uploader-file-preview-container',
      'uploader-file-preview',
      '[data-test-id*="attachment"]',
      '[data-testid*="attachment"]',
    ].join(',');

    for (const candidate of candidates) {
      if (
        candidate.matches('.text-input-field, input-area-v2, input-container')
        || candidate.querySelector(composerChromeSelector)
      ) {
        return candidate;
      }
    }

    return candidates[0] ?? null;
  }

  function getGeminiComposerRegion(editor: HTMLElement): Element | null {
    return findGeminiComposerRegion(editor) ?? defaultEditorRegion(editor);
  }

  function isGeminiImageModeSelected(): boolean {
    return Array.from(document.querySelectorAll<HTMLElement>('button')).some((button) => {
      if (!isVisibleElement(button)) return false;
      const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
      return /取消选择.*制作图片/.test(label);
    });
  }

  function getGeminiMakeImageButton(): HTMLElement | null {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button')).filter(isVisibleElement);
    return buttons.find((button) => {
      const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
      if (!label.includes('制作图片')) return false;
      if (/取消选择/.test(label)) return false;
      return true;
    }) ?? null;
  }

  function getGeminiToolboxButton(): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>('button')).find((button) => {
      if (!isVisibleElement(button)) return false;
      const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`.trim();
      return label === '工具' || label.includes('工具');
    }) ?? null;
  }

  async function ensureGeminiImageMode(editor: HTMLElement): Promise<boolean> {
    if (isGeminiImageModeSelected()) return true;

    let makeImageButton = getGeminiMakeImageButton();
    if (!makeImageButton) {
      const toolboxButton = getGeminiToolboxButton();
      if (toolboxButton) {
        debugLog('gemini 尝试打开工具菜单以选择制作图片');
        await clickElementLikeUser(toolboxButton);
        await sleep(300);
        makeImageButton = getGeminiMakeImageButton();
      }
    }

    if (!makeImageButton) {
      debugLog('gemini 未找到制作图片入口', {
        region: getGeminiAttachmentState(editor),
      });
      return false;
    }

    debugLog('gemini 选择制作图片模式', {
      text: (makeImageButton.textContent || '').trim().slice(0, 80),
      aria: makeImageButton.getAttribute('aria-label') || '',
    });
    await clickElementLikeUser(makeImageButton);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (isGeminiImageModeSelected()) return true;
      await sleep(250);
    }
    return isGeminiImageModeSelected();
  }

  function getGeminiUploadMenuButton(editor: HTMLElement): HTMLElement | null {
    const region = getGeminiComposerRegion(editor);
    const scopes = [region, document].filter(Boolean) as ParentNode[];
    const selectors = [
      'button[aria-controls="upload-file-menu"]',
      'button[aria-haspopup="menu"][data-test-id*="upload"]',
      'button[aria-label*="上传"]',
      'button[aria-label*="Upload"]',
      'button[aria-label*="附件"]',
      'button[aria-label*="Attach"]',
      'button[title*="上传"]',
      'button[title*="Upload"]',
      'button[title*="附件"]',
      'button[title*="Attach"]',
    ];
    for (const scope of scopes) {
      for (const selector of selectors) {
        const button = Array.from(scope.querySelectorAll<HTMLElement>(selector)).find((el) => {
          if (!isVisibleElement(el)) return false;
          return !el.matches(deps.getSendButtonSelector());
        });
        if (button) return button;
      }
      const button = Array.from(scope.querySelectorAll<HTMLElement>('button, div[role="button"], mat-icon')).find((el) => {
        if (!isVisibleElement(el)) return false;
        const host = el;
        if (!host || host.matches(deps.getSendButtonSelector())) return false;
        const label = `${host.getAttribute('aria-label') || ''} ${host.getAttribute('title') || ''} ${host.textContent || ''}`.toLowerCase();
        if (label.includes('upload') || label.includes('上传') || label.includes('附件') || label.includes('attach')) {
          return true;
        }
        const iconText = (host.querySelector('mat-icon, .google-symbols')?.textContent || '').trim().toLowerCase();
        return iconText === 'upload' || iconText === 'file_upload' || iconText === 'attach_file' || iconText === 'add_2';
      });
      if (button) return button;
    }
    return null;
  }

  function findGeminiFileInput(editor?: HTMLElement): HTMLInputElement | null {
    const region = editor ? getGeminiComposerRegion(editor) : null;
    const scopes = [region, document].filter(Boolean) as ParentNode[];
    for (const scope of scopes) {
      const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter((input) => input.isConnected && !input.disabled);
      const imageInput = inputs.find((input) => {
        const accept = (input.accept || '').toLowerCase();
        return input.multiple || accept.includes('image/') || accept.includes('image');
      });
      if (imageInput) return imageInput;
      if (inputs[0]) return inputs[0];
    }
    return null;
  }

  async function ensureGeminiFileInput(editor: HTMLElement): Promise<HTMLInputElement | null> {
    const existing = findGeminiFileInput(editor);
    if (existing) return existing;

    const uploadBtn = getGeminiUploadMenuButton(editor);
    if (uploadBtn) {
      debugLog('gemini 尝试打开上传菜单');
      await clickElementLikeUser(uploadBtn);
      await sleep(250);
    }

    let input = findGeminiFileInput(editor);
    if (input) return input;

    return null;
  }

  function dispatchGeminiPasteFile(target: HTMLElement, file: File) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    try {
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true }));
    } catch {}
  }

  function dispatchGeminiDropFile(target: HTMLElement, file: File) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const eventInit = { bubbles: true, cancelable: true, dataTransfer } as DragEventInit;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      try {
        target.dispatchEvent(new DragEvent(type, eventInit));
      } catch {}
    }
  }

  async function attachGeminiReferenceImageViaInjected(file: File): Promise<{ attached: boolean; count: number; mode: string; error?: string }> {
    const requestId = `gemini-ref-${++referenceAttachSeq}-${Date.now()}`;
    const dataBase64 = await blobToBase64(file);
    return await new Promise<{ attached: boolean; count: number; mode: string; error?: string }>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('gemini injected reference attach timeout'));
      }, 15000);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== window) return;
        const data = event.data || {};
        if (data.type !== 'OPENLINK_GEMINI_ATTACH_REFERENCE_RESULT' || data.data?.requestId !== requestId) return;
        cleanup();
        if (data.data?.attached) {
          resolve({
            attached: true,
            count: Number(data.data?.count || 0),
            mode: String(data.data?.mode || ''),
          });
          return;
        }
        reject(new Error(String(data.data?.error || 'gemini injected reference attach failed')));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
      };
      window.addEventListener('message', onMessage);
      window.postMessage({
        type: 'OPENLINK_GEMINI_ATTACH_REFERENCE',
        data: {
          requestId,
          fileName: file.name,
          mimeType: file.type || 'image/png',
          dataBase64,
        },
      }, '*');
    });
  }

  function getGeminiAttachmentCount(editor: HTMLElement, input?: HTMLInputElement | null): number {
    const region = getGeminiComposerRegion(editor);
    const domCount = region ? getGeminiAttachmentRemoveButtons(editor).length : 0;
    const fileCount = input?.files?.length || findGeminiFileInput(editor)?.files?.length || 0;
    return Math.max(domCount, fileCount);
  }

  function getGeminiAttachmentRemoveButtons(editor: HTMLElement): HTMLElement[] {
    const region = getGeminiComposerRegion(editor);
    if (!region) return [];
    const selectors = [
      'button[data-test-id="cancel-button"]',
      'button.cancel-button',
      'button[aria-label*="移除附件"]',
      'button[aria-label*="删除附件"]',
      'button[aria-label*="Remove attachment"]',
      'button[aria-label*="Delete attachment"]',
      'button[aria-label*="移除图片"]',
      'button[aria-label*="Remove image"]',
      'button[aria-label*="移除文件"]',
      'button[aria-label*="Remove file"]',
      '.attachment-preview-wrapper button[data-test-id="cancel-button"]',
      'uploader-file-preview button[data-test-id="cancel-button"]',
      '.file-preview-chip button[data-test-id="cancel-button"]',
    ];
    const seen = new Set<HTMLElement>();
    const buttons: HTMLElement[] = [];
    for (const selector of selectors) {
      for (const button of Array.from(region.querySelectorAll<HTMLElement>(selector))) {
        if (seen.has(button) || !isVisibleElement(button)) continue;
        const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.textContent || ''}`.toLowerCase();
        if (!label && !button.closest('.attachment-preview-wrapper, uploader-file-preview, .file-preview-chip')) continue;
        seen.add(button);
        buttons.push(button);
      }
    }
    return buttons;
  }

  function isGeminiUploadMenuOpen(): boolean {
    const menu = document.querySelector('#upload-file-menu');
    if (menu instanceof HTMLElement && isVisibleElement(menu)) return true;
    return Array.from(document.querySelectorAll<HTMLElement>('button[aria-controls="upload-file-menu"]')).some((button) => button.getAttribute('aria-expanded') === 'true');
  }

  function getGeminiVisiblePreviewImages(editor: HTMLElement): HTMLImageElement[] {
    const region = getGeminiComposerRegion(editor);
    if (!region) return [];
    return Array.from(region.querySelectorAll<HTMLImageElement>('img[data-test-id="image-preview"], .file-preview-container img, uploader-file-preview img'))
      .filter((img) => {
        const src = img.getAttribute('src') || '';
        return !!src && isVisibleElement(img);
      });
  }

  function getGeminiAttachmentState(editor: HTMLElement, input?: HTMLInputElement | null) {
    const region = getGeminiComposerRegion(editor);
    const previewImages = getGeminiVisiblePreviewImages(editor);
    return {
      regionTag: region?.tagName?.toLowerCase() || '',
      regionClass: region instanceof HTMLElement ? String(region.className || '').slice(0, 160) : '',
      count: getGeminiAttachmentCount(editor, input),
      removeButtons: getGeminiAttachmentRemoveButtons(editor).length,
      menuOpen: isGeminiUploadMenuOpen(),
      previewImages: previewImages.map((img) => ({
        src: (img.getAttribute('src') || '').slice(0, 80),
        complete: img.complete,
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
      })),
    };
  }

  async function waitForGeminiAttachmentCount(editor: HTMLElement, expectedCount: number, timeoutMs: number, input?: HTMLInputElement | null): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (getGeminiAttachmentCount(editor, input) >= expectedCount) return true;
      await sleep(200);
    }
    return false;
  }

  async function waitForGeminiAttachmentReady(editor: HTMLElement, expectedCount: number, timeoutMs: number, input?: HTMLInputElement | null): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let stableSince = 0;
    let lastLogAt = 0;
    while (Date.now() < deadline) {
      const state = getGeminiAttachmentState(editor, input);
      const hasLoadedPreview = state.previewImages.length >= expectedCount && state.previewImages.every((img) => {
        return !!img.src && (img.src.startsWith('blob:') || img.src.startsWith('data:') || img.complete);
      });
      const ready = state.count >= expectedCount && state.removeButtons >= expectedCount && hasLoadedPreview && !state.menuOpen;
      if (Date.now() - lastLogAt >= 1000) {
        lastLogAt = Date.now();
        debugLog('gemini 等待参考图稳定', {
          expectedCount,
          ready,
          ...state,
        });
      }
      if (ready) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 1200) return true;
      } else {
        stableSince = 0;
      }
      await sleep(200);
    }
    return false;
  }

  async function clearGeminiReferenceImages(editor: HTMLElement) {
    const input = findGeminiFileInput(editor);
    if (input && input.files?.length) {
      deps.setFileInputFiles(input, []);
      await sleep(100);
    }

    for (let pass = 0; pass < 4; pass++) {
      const buttons = getGeminiAttachmentRemoveButtons(editor);
      if (buttons.length === 0) break;
      for (const button of buttons) {
        await clickElementLikeUser(button);
        await sleep(120);
      }
      if (getGeminiAttachmentCount(editor, input) === 0) return;
      await sleep(250);
    }
  }

  async function attachGeminiReferenceImages(editor: HTMLElement, items: any[], apiUrl: string, authToken: string) {
    const files = await Promise.all(items.map((item, index) => deps.referenceImageJobToFile(item, index, apiUrl, authToken)));
    const beforeCount = getGeminiAttachmentCount(editor);
    const target = (getGeminiComposerRegion(editor) as HTMLElement | null) ?? editor;
    debugLog('gemini 开始附加参考图', {
      count: files.length,
      beforeCount,
      files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
    });
    let expectedCount = beforeCount;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let attached = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const input = await ensureGeminiFileInput(editor);
        debugLog('gemini 附加参考图', {
          index: i + 1,
          attempt,
          expectedCount: expectedCount + 1,
          fileName: file.name,
          size: file.size,
          type: file.type,
          hasFileInput: !!input,
        });
        if (input) {
          deps.setFileInputFiles(input, [file]);
          if (
            await waitForGeminiAttachmentCount(editor, expectedCount + 1, 15000, input) &&
            await waitForGeminiAttachmentReady(editor, expectedCount + 1, 10000, input)
          ) {
            expectedCount += 1;
            attached = true;
            break;
          }
          debugLog('gemini 文件输入上传未生效，准备回退', { index: i + 1, attempt, fileName: file.name });
        } else {
          debugLog('gemini 未发现 file input，直接回退到 paste/drop', { index: i + 1, attempt, fileName: file.name });
        }
        dispatchGeminiPasteFile(editor, file);
        if (
          await waitForGeminiAttachmentCount(editor, expectedCount + 1, 5000, input) &&
          await waitForGeminiAttachmentReady(editor, expectedCount + 1, 10000, input)
        ) {
          expectedCount += 1;
          attached = true;
          break;
        }
        dispatchGeminiDropFile(target, file);
        if (
          await waitForGeminiAttachmentCount(editor, expectedCount + 1, 5000, input) &&
          await waitForGeminiAttachmentReady(editor, expectedCount + 1, 10000, input)
        ) {
          expectedCount += 1;
          attached = true;
          break;
        }
        try {
          const injected = await attachGeminiReferenceImageViaInjected(file);
          debugLog('gemini 页面上下文参考图注入完成', {
            index: i + 1,
            attempt,
            fileName: file.name,
            count: injected.count,
            mode: injected.mode,
          });
          if (injected.attached) {
            const stabilized = await waitForGeminiAttachmentReady(editor, expectedCount + 1, 15000, input);
            debugLog('gemini 页面上下文参考图稳定检查', {
              index: i + 1,
              attempt,
              stabilized,
              ...getGeminiAttachmentState(editor, input),
            });
            if (stabilized) {
              expectedCount += 1;
              attached = true;
              break;
            }
          }
        } catch (error) {
          debugLog('gemini 页面上下文参考图注入失败', {
            index: i + 1,
            attempt,
            fileName: file.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await sleep(250);
      }
      if (!attached) {
        throw new Error(`gemini reference image attach failed: ${file.name}`);
      }
    }
  }

  function getLatestGeminiImageResponseContainer(): Element | null {
    const messageContents = Array.from(document.querySelectorAll('message-content'));
    for (let i = messageContents.length - 1; i >= 0; i--) {
      const message = messageContents[i];
      if (message.querySelector('.attachment-container.generated-images img.image')) return message;
    }
    return null;
  }

  function getGeminiGeneratedImageElements(): HTMLImageElement[] {
    const latestMessage = getLatestGeminiImageResponseContainer();
    if (!latestMessage) return [];
    return Array.from(latestMessage.querySelectorAll<HTMLImageElement>('generated-image img.image.loaded, .attachment-container.generated-images img.image.loaded'))
      .filter((img) => isVisibleElement(img) && !!img.getAttribute('src'));
  }

  function getGeminiImageKeys(): string[] {
    return getGeminiGeneratedImageElements()
      .map((img) => img.getAttribute('src') || '')
      .filter(Boolean);
  }

  async function waitForGeminiOriginalMediaURL(previousSeq: number, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    debugLog('gemini 等待无水印原图 URL', { previousSeq, timeoutMs });
    while (Date.now() < deadline) {
      if (mediaSeq > previousSeq && latestMediaURLs.length > 0) {
        const url = latestMediaURLs[latestMediaURLs.length - 1];
        if (url) return url;
      }
      await sleep(500);
    }
    throw new Error('wait for gemini original media url timed out');
  }

  async function waitForNewGeminiImage(previousKeysInput: string[] | Set<string>, timeoutMs: number): Promise<HTMLImageElement> {
    const deadline = Date.now() + timeoutMs;
    const previousKeys = previousKeysInput instanceof Set ? previousKeysInput : new Set(previousKeysInput);
    debugLog('gemini 等待新图片', { previousKeys: Array.from(previousKeys), timeoutMs });
    let lastSeenKeys = '';
    while (Date.now() < deadline) {
      const currentKeys = getGeminiImageKeys();
      const currentKeySummary = currentKeys.join(',');
      if (currentKeySummary !== lastSeenKeys) {
        lastSeenKeys = currentKeySummary;
        debugLog('gemini 当前图片 key', currentKeys);
      }
      const images = getGeminiGeneratedImageElements();
      for (let i = images.length - 1; i >= 0; i--) {
        const img = images[i];
        const key = img.getAttribute('src') || '';
        if (!key || previousKeys.has(key)) continue;
        if (key.startsWith('blob:') || (img.complete && img.naturalWidth > 0)) {
          debugLog('gemini 新图片已就绪', { key, width: img.naturalWidth, height: img.naturalHeight });
          return img;
        }
      }
      await sleep(1000);
    }
    debugLog('gemini 等待新图片超时', { previousKeys: Array.from(previousKeys), timeoutMs, currentKeys: getGeminiImageKeys() });
    throw new Error('wait for gemini generated image timed out');
  }

  return {
    resetGeminiMediaCapture,
    recordGeminiMediaCapture,
    getGeminiMediaSeq,
    setGeminiPrompt,
    findGeminiComposerRegion,
    clearGeminiReferenceImages,
    getGeminiAttachmentCount,
    ensureGeminiImageMode,
    attachGeminiReferenceImages,
    waitForGeminiAttachmentReady,
    getGeminiAttachmentState,
    getGeminiImageKeys,
    waitForGeminiOriginalMediaURL,
    waitForNewGeminiImage,
  };
}
