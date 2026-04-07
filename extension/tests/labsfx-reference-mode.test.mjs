import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { countLabsFxReferenceCards, findLabsFxComposerRegion } from '../src/content/labsfx_dom.ts';

const fixtures = [
  {
    name: 'empty',
    path: '/Users/xiongxin/projects/openlink/额外支持/flow/参考模式空输入框.html',
    expectedCount: 0,
  },
  {
    name: 'single-reference',
    path: '/Users/xiongxin/projects/openlink/额外支持/flow/参考模式带图输入框.html',
    expectedCount: 1,
  },
  {
    name: 'multi-reference',
    path: '/Users/xiongxin/projects/openlink/额外支持/flow/参考模式带多图输入框.html',
    expectedCount: 2,
  },
  {
    name: 'single-reference-with-prompt',
    path: '/Users/xiongxin/projects/openlink/额外支持/flow/参考模式输入框带图带提示词.html',
    expectedCount: 1,
  },
];

for (const fixture of fixtures) {
  test(`labsfx reference card count: ${fixture.name}`, () => {
    const html = readFileSync(fixture.path, 'utf8');
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const editor = document.querySelector('[data-slate-editor="true"][contenteditable="true"]');
    assert.ok(editor, 'expected editor to exist');
    const region = findLabsFxComposerRegion(editor, document);
    assert.ok(region, 'expected composer region to exist');
    assert.equal(countLabsFxReferenceCards(region), fixture.expectedCount);
  });
}
