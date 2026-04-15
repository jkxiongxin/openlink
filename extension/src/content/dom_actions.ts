export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForElement<T extends Element>(selector: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector(selector) as T | null;
    if (el) return el;
    await sleep(250);
  }
  throw new Error(`element not found: ${selector}`);
}

export async function clickElementLikeUser(el: HTMLElement) {
  el.focus();
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + Math.max(1, Math.min(rect.width - 1, rect.width / 2 || 1));
  const clientY = rect.top + Math.max(1, Math.min(rect.height - 1, rect.height / 2 || 1));
  const mouseInit = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0 };

  try { el.dispatchEvent(new PointerEvent('pointerdown', mouseInit)); } catch {}
  el.dispatchEvent(new MouseEvent('mousedown', mouseInit));
  await sleep(30);
  try { el.dispatchEvent(new PointerEvent('pointerup', mouseInit)); } catch {}
  el.dispatchEvent(new MouseEvent('mouseup', mouseInit));
  el.dispatchEvent(new MouseEvent('click', mouseInit));
  await sleep(80);

  if (location.hostname === 'labs.google' && location.pathname.startsWith('/fx')) {
    const stillThere = document.contains(el);
    if (stillThere) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
  }
}
