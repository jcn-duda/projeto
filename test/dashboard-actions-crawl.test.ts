// Ações do crawler no painel (Fase 4): dispatch real por /dashboard-action.json
// (allowlist → confirm → gate) com store em memória. "Reprocessar erros",
// "Reprocessar sem obra" e "Zerar" vão ao sidecar Rust: aqui um sidecar falso
// em loopback. Nada toca rede externa, o acervo ou a VPS.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.CACHE_PERSIST = 'false';

import { createApp } from '../src/app.js';
import config from '../src/config.js';
import * as crawler from '../src/providers/crawler.js';
import * as store from '../src/utils/crawl-store.js';
import * as live from '../src/utils/crawler-live.js';
import { createTestServer } from './e2e/e2e-harness.js';

const TOKEN = 'tok-crawl';
let server: any;
const saved: Record<string, any> = {};
const savedCrawl = { ...config.crawl };

const movie = (url: string) => ({ url, lastmod: '2026-01-01', kind: 'movie' as const });

/** Resposta do sidecar falso: status HTTP + corpo (o real recusa com 400/401/500). */
type FakeReply = { status?: number; body: Record<string, unknown> };

/** Sidecar Rust falso: grava o corpo de cada chamada e responde como o real. */
async function withFakeSidecar(
  reply: (body: Record<string, unknown>) => FakeReply,
  fn: (calls: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const calls: Array<Record<string, unknown>> = [];
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      calls.push({ path: req.url, token: req.headers['x-indexer-test-token'], ...body });
      const out = reply(body);
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const savedPort = config.crawl.sidecarPort;
  config.crawl.sidecarPort = (fake.address() as AddressInfo).port;
  try {
    await fn(calls);
  } finally {
    config.crawl.sidecarPort = savedPort;
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
}

before(async () => {
  saved.testToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
  server = await createTestServer(createApp().app);
});

beforeEach(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  Object.assign(config.crawl, {
    enabled: false, dryRun: true, sites: ['fake'], delayMs: 0, maxPerHour: 1000,
    idleWindowMs: 0, maxTries: 2, errorPauseStreak: 5, layoutCanary: 10, incrementalIntervalMin: 60,
  });
});

after(async () => {
  await server.close();
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  config.jackett.testToken = saved.testToken;
  Object.assign(config.crawl, savedCrawl);
});

const post = (body: Record<string, unknown>) =>
  server.request('POST', '/dashboard-action.json', {
    headers: { 'X-Indexer-Test-Token': TOKEN },
    body,
  });

test('crawl-pause alterna a pausa manual', async () => {
  const paused = await post({ action: 'crawl-pause', paused: true });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.paused, true);
  const resumed = await post({ action: 'crawl-pause', paused: false });
  assert.equal(resumed.json.paused, false);
});

test('crawl-config-get/set/reset com validação do schema', async () => {
  const get = await post({ action: 'crawl-config-get' });
  assert.equal(get.status, 200);
  assert.ok(Array.isArray(get.json.config.schema));

  const bad = await post({ action: 'crawl-config-set', patch: { nope: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'validation_error');

  const set = await post({ action: 'crawl-config-set', patch: { enabled: true, delayMs: 700 } });
  assert.equal(set.status, 200);
  assert.equal(set.json.effective.enabled, true);
  assert.equal(set.json.effective.delayMs, 700);

  const reset = await post({ action: 'crawl-config-reset', confirm: true });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.effective.enabled, false, 'volta ao default do .env');
});

test('crawl-simulate sem adaptador TS responde sem-adaptador e não toca a fila', async () => {
  store.engine().upsertUrls('fake', [movie('/a'), movie('/b')], 1);
  const res = await post({ action: 'crawl-simulate', max: 20 });
  // Indisponibilidade é 200 com o motivo, não erro HTTP (mesmo contrato de antes).
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'sem-adaptador');
  assert.equal(res.json.pages, 0);
  assert.equal(store.engine().counters('fake').byStatus.pending, 2, 'a fila fica intacta');
});

test('crawl-reprocess-errors vai ao sidecar (dono do crawl.db) e devolve a resposta dele', async () => {
  await withFakeSidecar(
    (body) => ({ body: { ok: true, action: body.action, site: body.site, requeued: 3 } }),
    async (calls) => {
      const res = await post({ action: 'crawl-reprocess-errors', site: ' fake ' });
      assert.equal(res.status, 200);
      assert.equal(res.json.requeued, 3);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, '/action');
      assert.equal(calls[0].action, 'crawl-reprocess-errors');
      assert.equal(calls[0].site, 'fake', 'id sem espaço nas bordas');
      assert.equal(calls[0].token, TOKEN, 'o token interno vai no header');
    },
  );
});

test('sidecar fora do ar: reprocessar erros é 502 com o motivo', async () => {
  const savedPort = config.crawl.sidecarPort;
  config.crawl.sidecarPort = 1;
  try {
    const res = await post({ action: 'crawl-reprocess-errors', site: 'fake' });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'sidecar não acessível');
  } finally {
    config.crawl.sidecarPort = savedPort;
  }
});

test('crawl-reprocess-no-work vai ao sidecar com o corpo {site} e devolve a contagem', async () => {
  store.engine().upsertUrls('fake', [movie('/a')], 1);
  await withFakeSidecar(
    (body) => ({ body: { ok: true, action: 'crawl-reprocess-no-work', site: body.site, requeued: 2, ids: ['/a', '/c'] } }),
    async (calls) => {
      const res = await post({ action: 'crawl-reprocess-no-work', site: ' fake ' });
      assert.equal(res.status, 200, 'não é destrutiva: nada é apagado');
      assert.equal(res.json.requeued, 2);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, '/crawl/reprocess-no-work');
      assert.equal(calls[0].site, 'fake', 'id sem espaço nas bordas');
      assert.equal(calls[0].action, undefined, 'a rota nova leva SÓ {site}: sem action/confirm');
      assert.equal(calls[0].token, TOKEN, 'o token interno vai no header');
      assert.equal(store.engine().getUrl('fake', '/a')?.status, 'pending',
        'quem escreve é o sidecar: o Node não toca a fila');
    },
  );
});

test('reprocessar sem obra sem `site` cai no site ativo do motor (o sidecar exige o site)', async () => {
  await withFakeSidecar(
    () => ({ body: { ok: true, action: 'crawl-reprocess-no-work', requeued: 0 } }),
    async (calls) => {
      const res = await post({ action: 'crawl-reprocess-no-work' });
      assert.equal(res.status, 200);
      assert.equal(calls[0]?.site, 'fake', 'o sidecar recusa site vazio: o Node resolve o primeiro do motor');
    },
  );
});

test('400 do sidecar vira erro de validação; 401/500 viram internal_error', async () => {
  let status = 400;
  await withFakeSidecar(
    () => ({ status, body: { ok: false, error: status === 400 ? 'site desconhecido: fake' : 'token inválido' } }),
    async (calls) => {
      const bad = await post({ action: 'crawl-reprocess-no-work', site: 'fake' });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error, 'validation_error');
      assert.deepEqual(bad.json.errors, ['site desconhecido: fake'], 'o motivo do sidecar chega ao painel');
      status = 401;
      const unauthorized = await post({ action: 'crawl-reprocess-no-work', site: 'fake' });
      assert.equal(unauthorized.status, 502);
      assert.equal(unauthorized.json.error, 'internal_error');
      assert.ok(!JSON.stringify(unauthorized.json).includes(TOKEN), 'o token nunca volta ao painel');
      status = 500;
      const boom = await post({ action: 'crawl-reprocess-no-work', site: 'fake' });
      assert.equal(boom.status, 502);
      assert.equal(boom.json.error, 'internal_error');
      assert.equal(calls.length, 3);
    },
  );
});

test('sidecar fora do ar: reprocessar sem obra é 502 internal_error', async () => {
  const savedPort = config.crawl.sidecarPort;
  config.crawl.sidecarPort = 1;
  try {
    const res = await post({ action: 'crawl-reprocess-no-work', site: 'fake' });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'internal_error');
    assert.deepEqual(res.json.errors, ['sidecar não acessível']);
  } finally {
    config.crawl.sidecarPort = savedPort;
  }
});

test('reprocessar sem obra em site fora do motor é 400 com motivo (não "0 URL(s)" em 200)', async () => {
  const res = await post({ action: 'crawl-reprocess-no-work', site: 'outro' });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
  assert.deepEqual(res.json.errors, ['site-desconhecido']);
});

test('crawl-reset exige confirm e vai ao sidecar só com o site informado', async () => {
  await withFakeSidecar(
    (body) => ({ body: { ok: true, action: body.action, site: body.site, urls: 7 } }),
    async (calls) => {
      const noConfirm = await post({ action: 'crawl-reset', site: 'fake' });
      assert.equal(noConfirm.status, 400);
      assert.equal(noConfirm.json.error, 'confirmation_required');
      assert.equal(calls.length, 0, 'sem confirm nada chega ao sidecar');

      const ok = await post({ action: 'crawl-reset', site: 'fake', confirm: true });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.urls, 7);
      assert.equal(calls.length, 1);
      assert.deepEqual({ action: calls[0].action, site: calls[0].site, confirm: calls[0].confirm },
        { action: 'crawl-reset', site: 'fake', confirm: true });
    },
  );
});

test('o painel recebe o formato do crawler.status() com a foto do sidecar ao lado', async () => {
  // Sidecar fora do ar (porta fechada): o bloco não pode virar "DESLIGADO"
  // e "nenhum site" — o crawl.db e a config continuam valendo.
  const saved = { port: config.crawl.sidecarPort };
  Object.assign(config.crawl, { sidecarPort: 1 });
  try {
    store.engine().upsertUrls('fake', [movie('/a')], 1);
    const res = await server.request('GET', '/dashboard-status.json?blocos=crawl', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
    });
    assert.equal(res.status, 200);
    const crawl = res.json.crawl;
    assert.equal(crawl.engine, 'rust');
    assert.equal(typeof crawl.enabled, 'boolean', 'campo que o badge do motor lê');
    assert.deepEqual(crawl.sites.map((s: { id: string }) => s.id), ['fake'], 'cards dos sites configurados');
    assert.equal(crawl.sidecar.active, false);
    assert.equal(crawl.error, 'sidecar não acessível');
  } finally {
    Object.assign(config.crawl, { sidecarPort: saved.port });
  }
});
