import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResolver } from '../resolvers/profiles/bludv.js';
import { createBludvCrawlSite } from '../src/providers/crawl-sites/bludv.js';
import { stubFetch } from './helpers/stub.js';
import { gatePost, legacyButton, legacyUrl, legacyMagnet, siteUrl, postUrl } from './helpers/bludv-gate-fixtures.js';

test('BLUDV crawl: cerca abortada após ler o post não abre portão nem protetor', async () => {
  const site = createBludvCrawlSite(createResolver({ siteUrl }));
  let aborted = false;
  const stub = stubFetch((url) => {
    assert.equal(url, postUrl, 'passo invalidado não pode ocupar o solvedor');
    aborted = true;
    return new Response(gatePost() + legacyButton);
  });
  try {
    const result = await site.fetchWork(postUrl, { isAborted: () => aborted });
    assert.equal(result.releases?.length ?? 0, 0);
    assert.equal(result.requestCost, 1, 'a página já lida continua custando');
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test('BLUDV crawl: abort entre botões impede o segundo protetor e preserva custo', async () => {
  const site = createBludvCrawlSite(createResolver({ siteUrl }));
  let aborted = false;
  const secondUrl = 'https://systemads1.com/go/segundo-fixture';
  const html = `<h1>Filme Fixture (2026)</h1>${legacyButton}`
    + `<p>WEB-DL 720p Dublado (1 GB)</p><a href="${secondUrl}">Magnet-Link</a>`;
  const stub = stubFetch((url) => {
    if (url === postUrl) return new Response(html);
    assert.equal(url, legacyUrl, 'nenhum botão após a cerca deve gastar rede');
    aborted = true;
    return new Response(`<a href="${legacyMagnet}">Magnet-Link</a>`);
  });
  try {
    const result = await site.fetchWork(postUrl, { isAborted: () => aborted });
    assert.equal(result.releases?.length, 1);
    assert.equal(result.requestCost, 2);
    assert.equal(stub.calls.length, 2);
    assert.equal(result.releases?.[0].isBr, true);
    assert.equal(result.releases?.[0].seeders, 1);
  } finally { stub.restore(); }
});

test('BLUDV crawl: falha de protetor é retentável e carrega o custo da tentativa', async () => {
  const site = createBludvCrawlSite(createResolver({ siteUrl }));
  const stub = stubFetch((url) => {
    if (url === postUrl) return new Response(`<h1>Filme Fixture (2026)</h1>${legacyButton}`);
    assert.equal(url, legacyUrl);
    throw new Error('rede simulada indisponível');
  });
  try {
    await assert.rejects(() => site.fetchWork(postUrl), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /rede simulada/);
      assert.ok('requestCost' in error);
      assert.equal(error.requestCost, 2);
      return true;
    });
    assert.equal(stub.calls.length, 2);
  } finally { stub.restore(); }
});
