export function getNativeSetter() {
  return Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
}

export function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const sel of selectors.split(',').map(s => s.trim())) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

export function isVisibleElement(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  if (style.visibility === 'hidden') return false;
  if (style.display === 'none') return false;
  if (style.opacity === '0') return false;
  return rect.width > 0 && rect.height > 0;
}

export function getEditorCandidates(editorSel: string): HTMLElement[] {
  const selectors = editorSel.split(',').map(s => s.trim()).filter(Boolean);
  const candidates = selectors.flatMap(sel => Array.from(document.querySelectorAll<HTMLElement>(sel)));
  return candidates
    .filter((el) => {
      if (!el.isConnected) return false;
      if (el instanceof HTMLTextAreaElement && (el.disabled || el.readOnly)) return false;
      if (!isVisibleElement(el)) return false;
      return true;
    });
}

export function getVisibleTextareas(): HTMLTextAreaElement[] {
  return Array.from(document.querySelectorAll('textarea')).filter((el): el is HTMLTextAreaElement => {
    return el instanceof HTMLTextAreaElement && isVisibleElement(el);
  });
}

export function applyTextareaValue(ta: HTMLTextAreaElement, next: string): void {
  const previous = ta.value;
  const nativeInputValueSetter = getNativeSetter();
  if (nativeInputValueSetter) nativeInputValueSetter.call(ta, next);
  else ta.value = next;
  const tracker = (ta as any)._valueTracker;
  if (tracker && typeof tracker.setValue === 'function') tracker.setValue(previous);
  const caret = next.length;
  try { ta.setSelectionRange(caret, caret); } catch {}
  ta.dispatchEvent(new Event('focus', { bubbles: true }));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  if (location.hostname !== 'chat.deepseek.com') ta.dispatchEvent(new Event('blur', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', code: 'End', bubbles: true }));
}

export function insertContentEditableText(editor: HTMLElement, text: string): void {
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
  } catch {
    setContentEditablePlainText(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

export function normalizeEditorPlainText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').trim();
}

export function setContentEditablePlainText(editor: HTMLElement, text: string): void {
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
  } catch {}
  editor.textContent = text;
}

export function setContentEditableText(el: HTMLElement, text: string) {
  el.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  document.execCommand('insertText', false, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
