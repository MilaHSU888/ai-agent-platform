import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolEntry, resolveToolUrl } from '../app/tool-entry.tsx';

const root = new URL('../', import.meta.url);
const render = tool => renderToStaticMarkup(createElement(ToolEntry, { tool, onOpenInternal() {} }));

test('vision without an entry remains disabled rather than opening an embedded or generic tool', () => {
  for (const url of [undefined, '', ' ', 'not-a-url', 'javascript:alert(1)', 'https://user:password@example.com']) {
    assert.equal(resolveToolUrl(url), null);
    assert.match(render({id:'vision',url}), /<button disabled=""[^>]*>待設定入口<\/button>/);
  }
});

test('configured HTTP(S) entry opens in an isolated new tab, including a customer intranet URL', () => {
  for (const url of ['https://vision.example.com/tool', 'http://vision.internal:8080/']) {
    assert.equal(resolveToolUrl(url), url);
    const html = render({id:'vision',url});
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.ok(html.includes(`href="${url}"`));
    assert.doesNotMatch(html, /disabled/);
  }
});

test('other internal tools retain their open action; optional URLs also work for other tools', () => {
  assert.match(render({id:'quote'}), /<button>開啟工具/);
  assert.match(render({id:'knowledge-shared'}), /<button>開啟工具/);
  assert.match(render({id:'other',url:'https://tools.example.com/'}), /<a /);
});

test('vision remains in manufacturing 2; embedded code and customer assets have moved out', async () => {
  const page = await readFile(new URL('app/page.tsx', root),'utf8');
  const css = await readFile(new URL('app/globals.css', root),'utf8');
  assert.match(page, /id: "vision", name: "AI 識圖大師"[^\n]+department: "mfg2"/);
  assert.match(page, /id: "mfg2", name: "製造二部"[^\n]+tools: 6/);
  assert.match(page, /<ToolEntry tool=\{selectedTool\}/);
  assert.match(page, /tool.department === activeDepartment/);
  assert.doesNotMatch(page, /VisionWorkspace|VisionReviewWorkspace|customerReviewRows|buildReviewWorkbook|ai-vision-process/);
  assert.doesNotMatch(css, /\.vision-app|\.drawing-inline-editor/);
  assert.ok(!(await readdir(new URL('public/',root))).some(name => /^ai-(?:vision|balloon)-/.test(name)));
});
