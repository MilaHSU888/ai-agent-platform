import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Home from '../app/page.tsx';

test('WorkHub renders the actual tool catalogue and department navigation', () => {
  const html = renderToStaticMarkup(createElement(Home));
  assert.match(html, /製造二部/);
  assert.match(html, /tool-search/);
  assert.match(html, /企業知識庫問答/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|vision-app/);
});

test('unrelated quotation and knowledge workspaces remain available', async () => {
  const source = await readFile(new URL('../app/page.tsx',import.meta.url),'utf8');
  assert.match(source, /<QuoteWorkspace onBack=/);
  assert.match(source, /<KnowledgeWorkspace department=/);
  assert.match(source, /<GeneralToolWorkspace tool=/);
  assert.match(source, /function KnowledgeAdminPanel/);
});
