export function findLabsFxComposerRegion(editor: Element | null, root: ParentNode = document): Element | null {
  if (editor && (editor as HTMLElement).isConnected) {
    const direct = editor.closest('.sc-84e494b2-0');
    if (direct) return direct;
  }

  const regions = Array.from(root.querySelectorAll('.sc-84e494b2-0'));
  for (const region of regions) {
    if (region.querySelector('[data-slate-editor="true"][contenteditable="true"]')) {
      return region;
    }
  }
  return null;
}

export function countLabsFxReferenceCards(region: Element | null): number {
  if (!region) return 0;
  return region.querySelectorAll(
    'button[data-card-open] img[alt*="收录在集合中"], button[data-card-open] img[alt*="媒体内容"]'
  ).length;
}
