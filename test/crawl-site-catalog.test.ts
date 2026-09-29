// Catálogo de sites da raspagem: liga/desliga por site pelo painel, inclusive
// o site com adaptador que NÃO está em `CRAWL_SITES` (o `.env` da VPS não é
// tocado pelo deploy — ligar um site novo não pode depender de editá-lo).
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const live = await import('../src/utils/crawler-live.js');
const { siteConfigOf, knownSites, cadenceDelayMs } = await import('../src/utils/crawler-live-site.js');
const registry = await import('../src/providers/crawl-sites/registry.js');
const { siteCatalog, siteHealth, CRAWL_HEALTH_WINDOW_MS } = await import('../src/providers/crawl-site-catalog.js');
const indexerStatus = await import('../src/providers/indexer-status.js');
const schema = await import('../src/utils/crawler-live-schema.js');
import type { CrawlDiscovery, CrawlSite } from '../src/providers/crawl-types.js';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  indexerStatus.clear();
  Object.assign(config.crawl, savedCrawl, {
    enabled: true, dryRun: true, sites: ['vacatorrent'], delayMs: 0, maxPerHour: 1000,
    idleWindowMs: 0, maxTries: 2, errorPauseStreak: 5, layoutCanary: 10,
    incrementalIntervalMin: 60, requireProbe: false, discoveryCost: 3,
  });
});

after(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

function fakeSite(id: string): CrawlSite {
  return {
    id,
    label: `Site ${id}`,
    discover: async (): Promise<CrawlDiscovery> => ({
      urls: [{ url: `https://x.test/${id}/a`, lastmod: '2026-01-01', kind: 'movie' }], complete: true, failures: [],
    }),
    fetchWork: async (url: string) => ({ url, status: 'no-torrent' as const, releases: [] }),
  };
}

describe('crawl catálogo: sites fora do .env', () => {
  test('site do catálogo nasce DESLIGADO; o do .env nasce ligado', () => {
    const eff = live.effective();
    assert.equal(siteConfigOf(eff, 'vacatorrent').enabled, true);
    assert.equal(siteConfigOf(eff, 'nerdfilmes').enabled, false, 'fora do .env: só liga pelo painel');
    assert.deepEqual(knownSites(eff), ['vacatorrent']);
  });

  test('ligar pelo painel coloca o site no motor, desligar mantém o card', () => {
    const on = live.setSiteOverride('nerdfilmes', { enabled: true });
    assert.equal(on.ok, true, 'site com adaptador fora do .env é aceito');
    assert.equal(on.effective.enabled, true);
    assert.deepEqual(knownSites(live.effective()), ['vacatorrent', 'nerdfilmes']);

    live.setSiteOverride('nerdfilmes', { enabled: false });
    assert.deepEqual(knownSites(live.effective()), ['vacatorrent', 'nerdfilmes'], 'desligado continua visível');
    assert.equal(siteConfigOf(live.effective(), 'nerdfilmes').enabled, false);

    live.clearSiteOverride('nerdfilmes');
    assert.deepEqual(knownSites(live.effective()), ['vacatorrent'], '"voltar ao global" = padrão do .env');
  });

  test('desligar um site do .env pelo painel', () => {
    assert.equal(live.setSiteOverride('vacatorrent', { enabled: false }).ok, true);
    assert.equal(siteConfigOf(live.effective(), 'vacatorrent').enabled, false);
  });

  test('site fora da tabela continua recusado; o último card pendente já tem adaptador', () => {
    // O `apachetorrent-cardigann` era o ÚLTIMO card BR sem adaptador e saiu
    // desta lista: ligar um site pendente criaria um card "sem-adaptador"
    // eterno, que não rasga nada — e é exatamente por isso que ele agora
    // aceita o override e nasce DESLIGADO fora do `CRAWL_SITES` (o `.env` da
    // VPS não é tocado pelo deploy). Depois deste commit os OITO cards da
    // tabela têm adaptador, então a trava que sobra para exercitar é a de
    // "fora da tabela".
    const apache = live.setSiteOverride('apachetorrent-cardigann', { enabled: true });
    assert.equal(apache.ok, true, 'com adaptador, o painel liga o site');
    assert.equal(live.effective().siteOverrides['apachetorrent-cardigann']?.enabled, true);
    assert.ok(knownSites(live.effective()).includes('apachetorrent-cardigann'));
    const ghost = live.setSiteOverride('site-fantasma', { enabled: true });
    assert.equal(ghost.ok, false, 'fora da tabela não é site');
    assert.equal(live.effective().siteOverrides['site-fantasma'], undefined);
  });

  test('cadência considera o site ligado pelo painel', () => {
    Object.assign(config.crawl, { sites: [], delayMs: 700 });
    live.setSiteOverride('nerdfilmes', { enabled: true, delayMs: 3000 });
    assert.equal(cadenceDelayMs(live.effective()), 3000);
  });

  test('config gravada com ajuste de site não gera aviso falso no boot', () => {
    const { sanitizeStoredConfig } = schema;
    const stored = { enabled: true, delayMs: 800, siteOverrides: { nerdfilmes: { enabled: true } } };
    const { clean, errors } = sanitizeStoredConfig(stored);
    assert.deepEqual(errors, [], 'siteOverrides não é "chave desconhecida"');
    assert.deepEqual(clean.siteOverrides, { nerdfilmes: { enabled: true } });
    assert.equal(clean.delayMs, 800);
    // O aviso VERDADEIRO continua: chave escalar desconhecida e site corrompido.
    const bad = sanitizeStoredConfig({ nasa: 1, siteOverrides: { x: 'lixo' } });
    assert.ok(bad.errors.some((e) => /nasa/.test(e)));
    assert.ok(bad.errors.some((e) => /"x"/.test(e)));
  });

  test('adapterIds lista só quem tem adaptador', () => {
    // `torrentdosfilmesv2` entrou na Fase 8: o card é o id, e o profile tem
    // outro nome (`torrentdosfilmes`) — a ponte fica no próprio adaptador.
    // `comandotorrents` é o card seguinte; `redetorrent-cardigann` o quarto
    // (profile `redetorrent`, mesma divergência de id) e `bludv-cardigann` o
    // quinto (profile `bludv`, a mesma divergência). Todos nascem desligados
    // fora de CRAWL_SITES — o `.env` da VPS não é tocado pelo deploy.
    // `hdrtorrent-cardigann` e `apachetorrent-cardigann` são os dois últimos:
    // os primeiros sem sitemap, com a descoberta pela LISTAGEM paginada
    // `/pagina/N/` pelo núcleo `crawl-sites/listing-discover.ts` (e no Apache,
    // a ponte pelo NOME do profile `apachetorrent`). Com este último, a lista
    // tem os OITO cards BR — a Fase 8 não tem mais pendência.
    assert.deepEqual(registry.adapterIds(), [
      'vacatorrent', 'nerdfilmes', 'torrentdosfilmesv2', 'comandotorrents', 'redetorrent-cardigann',
      'apachetorrent-cardigann', 'hdrtorrent-cardigann', 'bludv-cardigann',
    ]);
    assert.deepEqual(registry.adapterIds(), registry.tableIds(), 'nada ficou sem adaptador');
  });
});

describe('crawl catálogo: saúde do site (a cor do toggle)', () => {
  const now = 10_000_000;
  const clean = { autoPause: null, errorStreak: 0, lastActiveAt: 0 };

  test('pausa automática da raspagem = caído, mesmo com o Jackett online', () => {
    indexerStatus.record('nerdfilmes', { ok: true, ms: 100, budgetMs: 4000 });
    const h = siteHealth('nerdfilmes', { ...clean, autoPause: { reason: 'error-streak' } }, now);
    assert.equal(h.health, 'offline');
    assert.match(h.detail, /error-streak/);
  });

  test('erro seguido sem pausa = instável; página recente sem erro = no ar', () => {
    assert.equal(siteHealth('nerdfilmes', { ...clean, errorStreak: 2 }, now).health, 'instavel');
    const recent = siteHealth('nerdfilmes', { ...clean, lastActiveAt: now - 5 * 60_000 }, now);
    assert.equal(recent.health, 'online');
    assert.match(recent.detail, /há 5 min/);
  });

  test('raspagem velha cai para a medição do Jackett; nada medido = desconhecido', () => {
    const old = { ...clean, lastActiveAt: now - CRAWL_HEALTH_WINDOW_MS - 1 };
    assert.equal(siteHealth('nerdfilmes', old, now).health, 'unknown', 'nunca "no ar" por omissão');
    indexerStatus.record('nerdfilmes', { ok: false, results: 0 });
    assert.equal(siteHealth('nerdfilmes', old).health, 'offline');
    indexerStatus.record('nerdfilmes', { ok: true, ms: 9000, budgetMs: 4000 });
    assert.equal(siteHealth('nerdfilmes', undefined).health, 'instavel', 'lento é instável');
    indexerStatus.record('nerdfilmes', { ok: true, ms: 100, budgetMs: 4000 });
    assert.equal(siteHealth('nerdfilmes', undefined).health, 'online');
  });

  test('o catálogo do status leva a saúde de cada site', () => {
    indexerStatus.record('vacatorrent', { ok: false, results: 0 });
    const vaca = crawler.status().catalog.find((c) => c.id === 'vacatorrent');
    assert.equal(vaca?.health, 'offline');
    assert.equal(crawler.status().catalog.find((c) => c.id === 'bludv-cardigann')?.health, 'unknown');
  });
});

describe('crawl catálogo: status e motor', () => {
  test('catálogo traz a tabela inteira com o liga/desliga efetivo e a origem', () => {
    live.setSiteOverride('nerdfilmes', { enabled: true });
    const catalog = siteCatalog(live.effective());
    assert.equal(catalog.length, registry.SITE_TABLE.length);
    const vaca = catalog.find((c) => c.id === 'vacatorrent');
    const nerd = catalog.find((c) => c.id === 'nerdfilmes');
    const bludv = catalog.find((c) => c.id === 'bludv-cardigann');
    assert.deepEqual(
      { inEnv: vaca?.inEnv, enabled: vaca?.enabled, over: vaca?.enabledOverridden },
      { inEnv: true, enabled: true, over: false },
    );
    assert.deepEqual(
      { inEnv: nerd?.inEnv, enabled: nerd?.enabled, over: nerd?.enabledOverridden, configured: nerd?.configured },
      { inEnv: false, enabled: true, over: true, configured: true },
    );
    assert.equal(bludv?.adapter, true, 'o BLUDV ganhou adaptador no COMMIT 1 da Fase 8');
    assert.equal(bludv?.enabled, false, 'mas continua desligado: fora do CRAWL_SITES, só entra pelo painel');
    assert.equal(crawler.status().catalog.length, registry.SITE_TABLE.length, 'o status do painel carrega o catálogo');
  });

  test('site ligado pelo painel ganha card e entra na rotação', async () => {
    crawler._setSitesForTest((id) => fakeSite(id));
    Object.assign(config.crawl, { sites: [] });
    crawler.start();
    assert.equal(crawler.status().sites.length, 0, 'nada no .env, nada ligado');
    live.setSiteOverride('nerdfilmes', { enabled: true });
    assert.deepEqual(crawler.status().sites.map((s) => s.id), ['nerdfilmes']);
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 4; i += 1) await crawler.tick();
    assert.ok(store.engine().counters('nerdfilmes').total > 0, 'o motor raspou o site ligado pelo painel');
  });

  test('ações por site aceitam o site ligado pelo painel (fora do CRAWL_SITES)', () => {
    // O bug: o NerdFilmes ligado no painel devolvia "0 URL(s)" com HTTP 200 em
    // Reprocessar/Zerar, porque a validação olhava só o `.env`.
    live.setSiteOverride('nerdfilmes', { enabled: true });
    store.engine().upsertUrls('nerdfilmes', [{ url: 'https://x.test/a', lastmod: '', kind: 'movie' }], 1);
    store.engine().markResult('nerdfilmes', 'https://x.test/a', { status: 'no-work', imdb: null, releases: 0 }, 1);
    const noWork = crawler.reprocessNoWork('nerdfilmes');
    assert.deepEqual({ ok: noWork.ok, requeued: noWork.requeued }, { ok: true, requeued: 1 });
    assert.equal(crawler.reprocessErrors('nerdfilmes').ok, true);
    assert.equal(crawler.resetSite('nerdfilmes').ok, true);
  });

  test('site fora do motor é recusado com motivo, nunca "0" mudo', () => {
    const r = crawler.reprocessNoWork('comandotorrents');
    assert.equal(r.ok, false, 'tem adaptador, mas não foi ligado');
    assert.equal(r.reason, 'site-desconhecido');
  });

  test('pausa por site aceita o site ligado pelo painel', () => {
    live.setSiteOverride('nerdfilmes', { enabled: true });
    assert.equal(crawler.setPaused(true, 'nerdfilmes').ok, true);
  });
});
