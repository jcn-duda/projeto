// Motor multi-site (Fase 8): rodízio serial com JUSTIÇA entre sites, estado
// isolado por site (pausa, teto horário, cursor, ciclo), override por site com
// trava de segurança, gate da sonda (veredito GO é o único que libera), teto
// agregado do processo, status com um card por site — inclusive com o motor
// DESLIGADO, onde o status precisa abrir o `crawl.db` que ninguém abriu — e as
// travas de segurança das ações por site.
//
// Isolamento: store em MEMÓRIA por caso; adaptadores DUBLÊS por site (o
// registro real nunca é tocado); `idleWindowMs: 0` e `delayMs: 0` desligam
// freio e ritmo, porque a cadência é o que a justiça mede.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CACHE_PERSIST = 'false';

// `node:sqlite` só existe no Node 22+. A quase totalidade dos casos roda no
// store em MEMÓRIA, mas o do veredito gravado em ARQUIVO exige durabilidade
// entre fechar e reabrir — sem o módulo o `open(path)` cai em memória e o
// `resetForTests` apaga o que acabou de ser gravado. Pular é honesto; falhar
// mediria o runtime, não o gate.
let _hasSqlite = true;
try { await import('node:sqlite'); } catch { _hasSqlite = false; }
const skipSemSqlite = !_hasSqlite && 'node:sqlite indisponível — precisa de Node 22+';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const live = await import('../src/utils/crawler-live.js');
const { siteConfigOf, cadenceDelayMs, withCadence } = await import('../src/utils/crawler-live-site.js');
const { PROBE_STATE_KEY, verdictFor, probeGateOpen } = await import('../src/providers/crawl-probe-gate.js');
const { idleFractionOf, createSiteRuntime } = await import('../src/providers/crawl-site-runtime.js');
const registry = await import('../src/providers/crawl-sites/registry.js');
const { selectNext } = await import('../src/providers/crawl-site-select.js');
import type { CrawlDiscovery, CrawlSite, CrawlWorkResult } from '../src/providers/crawl-types.js';
import type { RawItem } from '../types/domain.d.ts';

const savedCrawl = { ...config.crawl };

beforeEach(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  store.open(undefined, { forceMemory: true });
  freshCrawl();
});

after(() => {
  crawler._resetForTest();
  live._resetForTest();
  store.resetForTests();
  Object.assign(config.crawl, savedCrawl);
});

function freshCrawl(overrides: Record<string, unknown> = {}): void {
  Object.assign(config.crawl, {
    enabled: true,
    dryRun: true,
    sites: ['a', 'b'],
    delayMs: 0,
    maxPerHour: 1000,
    idleWindowMs: 0,
    maxTries: 2,
    errorPauseStreak: 5,
    layoutCanary: 10,
    incrementalIntervalMin: 60,
    requireProbe: false,
    discoveryCost: 3,
    siteOverrides: {},
    // O status pode ABRIR o store (ver o bloco "motor desligado" abaixo), e um
    // `dbPath` vazado de um caso para outro faria o banco de verdade aparecer
    // no repositório da suíte.
    dbPath: savedCrawl.dbPath,
  }, overrides);
}

const movie = (url: string) => ({ url, lastmod: '2026-01-01', kind: 'movie' as const });

function item(seed: string): RawItem {
  const hash = (seed.replace(/\W/g, '') + '0'.repeat(40)).slice(0, 40).padEnd(40, '0');
  return {
    title: `Obra ${seed} (2000) 1080p DUBLADO`, magnet: `magnet:?xt=urn:btih:${hash}`,
    indexer: 'a', tracker: 'Fake', isBr: true, seeders: 1, size: 1000,
  };
}

/** Adaptador dublê por site: `discover` semeia, `fetchWork` entrega 1 release. */
function fakeSite(id: string, over: Partial<CrawlSite> = {}): CrawlSite {
  return {
    id,
    label: `Site ${id.toUpperCase()}`,
    discover: async (): Promise<CrawlDiscovery> => ({
      urls: [movie(`/${id}/a`), movie(`/${id}/b`)], complete: true, failures: [],
    }),
    fetchWork: async (url: string): Promise<CrawlWorkResult> => ({
      url, status: 'done', imdb: 'tt1000000', title: 'Obra', year: 2000,
      type: 'movie', releases: [item(url)],
    }),
    ...over,
  };
}

/** Registro dublê: dois sites, ids desconhecidos da tabela (o motor não exige). */
function useSites(sites: Record<string, CrawlSite>): void {
  crawler._setSitesForTest((id) => sites[id] ?? null);
}

/** Veredito GO no formato do codec da sonda (o gate é o consumidor real). */
function goVerdict(site: string, over: Record<string, unknown> = {}): string {
  const counts = {
    sample: 40, valid: 40, withRelease: 32, magnets: 40, identified: 28,
    buttonNoMagnet: 4, noTorrent: 4, siteLevel: 0, pageError: 0, tmdbDown: 0, noWork: 0,
  };
  const { counts: overCounts, ...rest } = over;
  return JSON.stringify({
    v: 2, site, verdict: 'go', at: 1_000_000, // v2 = codec vigente da sonda (`no-work` como resposta)
    rates: {}, bounds: {}, denominators: { sample: 40, buttonPages: 36, identifyAnswered: 32, validPages: 40 },
    thresholds: {}, reasons: [], stop: 'amostra-completa', kind: 'movie',
    ...rest,
    counts: { ...counts, ...(overCounts as object) },
  });
}

const statusOf = (id: string) => crawler.status().sites.find((s) => s.id === id);

/** `byStatus` zerado, para as contagens do teste de política. */
const EMPTY = {
  pending: 0, inflight: 0, done: 0, 'no-torrent': 0, 'no-work': 0, error: 0, simulated: 0, partial: 0,
};


describe('crawl multi-site: política de rodízio (puro)', () => {
  const runtimes = (a: ReturnType<typeof createSiteRuntime>, b: ReturnType<typeof createSiteRuntime>) => (id: string) => (id === 'b' ? b : a);
  const cfg = { enabled: true, dryRun: true, delayMs: 0, maxPerHour: 10 } as never;
  const queue = (total: number, pending: number) => ({ total, byStatus: { ...EMPTY, pending } });

  test('item vencido tem precedência sobre descoberta vencida', () => {
    const a = createSiteRuntime('a');
    const b = createSiteRuntime('b');
    a.openRunId = 1; // rodada aberta com fila => classe item
    const now = Date.now();
    a.lastActiveAt = now; // serviu agora: a JUSTIÇA colocaria o b na frente
    b.lastActiveAt = now - 1000; // mas o b está DENTRO do intervalo incremental
    const deps = {
      counters: (id: string) => (id === 'a' ? queue(5, 5) : queue(0, 0)),
      probeOpen: () => true, globalCapHit: () => false,
    };
    const { chosen } = selectNext(['a', 'b'], runtimes(a, b), () => cfg, deps, now);
    assert.equal(chosen?.id, 'a', 'item vencida tem precedência sobre descoberta');
  });

  test('justiça: dentro da classe, vence o lastActiveAt mais antigo', () => {
    const a = createSiteRuntime('a');
    const b = createSiteRuntime('b');
    a.openRunId = 1; b.openRunId = 2;
    a.lastActiveAt = 900; b.lastActiveAt = 100;
    const deps = { counters: () => queue(5, 5), probeOpen: () => true, globalCapHit: () => false };
    const { chosen } = selectNext(['a', 'b'], runtimes(a, b), () => cfg, deps, Date.now());
    assert.equal(chosen?.id, 'b', 'o site que faz mais tempo não servido é servido');
  });

  test('classe descoberta só entra quando ninguém tem item vencido', () => {
    const a = createSiteRuntime('a');
    const b = createSiteRuntime('b');
    a.lastActiveAt = 1; b.lastActiveAt = 900;
    const deps = {
      counters: (id: string) => (id === 'a' ? queue(0, 0) : queue(0, 0)),
      probeOpen: () => true, globalCapHit: () => false,
    };
    const { chosen } = selectNext(['a', 'b'], runtimes(a, b), () => cfg, deps, Date.now());
    assert.equal(chosen?.id, 'a', 'ambos só têm descoberta: vale a justiça');
    assert.equal(chosen?.due, 'discovery');
  });

  test('teto e sonda barram com o motivo explícito', () => {
    const a = createSiteRuntime('a');
    const deps = { counters: () => queue(0, 0), probeOpen: () => false, globalCapHit: () => false };
    const probe = selectNext(['a'], () => a, () => cfg, deps, Date.now());
    assert.equal(probe.chosen, null);
    assert.equal(probe.all[0]?.skipReason, 'probe');
    const capped = selectNext(['a'], () => a, () => cfg, { ...deps, probeOpen: () => true, globalCapHit: () => true }, Date.now());
    assert.equal(capped.all[0]?.skipReason, 'teto-horario');
  });
});

describe('crawl multi-site: rodízio serial', () => {
  test('um site por vez: cada tick serve UM site e o rodízio respeita a fila', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    // 8 ticks: a descobre e drena as 2 páginas, depois b faz o mesmo. O que
    // este caso trava é o SERIAL (um site por requisição) e o isolamento: o
    // rodízio interno é a política pura testada acima.
    for (let i = 0; i < 8; i += 1) await crawler.tick();
    const ca = store.engine().counters('a');
    const cb = store.engine().counters('b');
    assert.equal(ca.total, 2, 'cada site tem a SUA fila');
    assert.equal(cb.total, 2, 'cada site tem a SUA fila');
    assert.equal(ca.byStatus.simulated, 2);
    assert.equal(cb.byStatus.simulated, 2);
    assert.ok(store.engine().latestRun('a') && store.engine().latestRun('b'), 'rodada por site');
  });

  test('site que DEVE trabalho mas não foi servido diz "aguarda-rodizio"', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 3; i += 1) await crawler.tick();
    // Depois da descoberta de `a`, `b` também deve descoberta: ficou na fila.
    const b = statusOf('b');
    assert.equal(b?.skipReason, 'aguarda-rodizio');
    assert.notEqual(b?.skipReason, 'sem-trabalho');
  });

  test('site desabilitado por override sai da rotação e diz por quê', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    live.setSiteOverride('b', { enabled: false });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 4; i += 1) await crawler.tick();
    assert.equal(store.engine().counters('b').total, 0, 'site desligado não discovery nem página');
    assert.ok((store.engine().counters('a').byStatus.simulated ?? 0) >= 1, 'o site ligado continua working');
    assert.equal(statusOf('b')?.skipReason, 'desabilitado');
    assert.equal(statusOf('b')?.enabled, false);
    assert.equal(statusOf('a')?.enabled, true);
  });

  test('teto horário do site não toca o vizinho; o teto global barra os dois', async () => {
    freshCrawl({ maxPerHour: 4 });
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    live.setSiteOverride('a', { maxPerHour: 3 });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 8; i += 1) await crawler.tick();
    const total = (id: string) => store.engine().counters(id).byStatus.simulated;
    // Cada descoberta custa `discoveryCost` (3) e cada página 1, no teto
    // AGREGADO do processo (4/h): nada pode passar do global.
    assert.equal(total('a') + total('b'), 0, 'teto global de 4 req/h não paga nem uma página (descoberta já custa 3)');
    assert.equal(statusOf('a')?.skipReason, 'teto-horario');
    assert.equal(statusOf('b')?.skipReason, 'teto-horario');
  });
});

// --- O status com o motor DESLIGADO -----------------------------------------
//
// `CRAWL_ENABLED=false` é o default de instalação, e aí `start()` volta antes
// de `primeSite` — nada abre o `crawl.db`. O status respondia `sites: []`,
// `engine: null` e sem `probe`/`siteConfig`/`skipReason`/`etaHours`, e o painel
// ficava sem como mostrar "sonda não rodada" de um site que nunca rodou, que é
// o estado inicial de todo site novo. Aqui o status LÊ o store (abrindo o que
// não estiver aberto, e só uma vez) sem gravar veredito nem mexer na fila.
describe('crawl: status com o motor desligado', () => {
  /** Store fechado + `dbPath` temporário: prova que a abertura vem do status. */
  function closedStore(): string {
    crawler._resetForTest();
    store.resetForTests();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-crawl-off-'));
    freshCrawl({ dbPath: path.join(dir, 'crawl.db') });
    return dir;
  }

  test('sites[] traz um card por site CONFIGURADO, não só o site ativo', () => {
    const dir = closedStore();
    try {
      freshCrawl({ enabled: false, sites: ['a', 'b', 'c'] });
      crawler.start();
      const status = crawler.status();
      assert.notEqual(status.engine, null, 'sem engine o painel não tem nem onde ler o veredito');
      assert.deepEqual(status.sites.map((s) => s.id), ['a', 'b', 'c'], 'um card por site de CRAWL_SITES');
      assert.equal(status.sitesConfigured.length, 3);
      for (const card of status.sites) {
        assert.equal(card.probe.verdict, null, `${card.id}: sonda nunca rodou é null, nunca "go"`);
        assert.equal(card.skipReason, 'desabilitado', `${card.id}: a exclusão real é do operador`);
        // `siteConfig.enabled` é a decisão LOCAL do site (o override). O
        // kill-switch do motor é o `enabled` do topo, traduzido no `skipReason`
        // — por isso `true` aqui e "desligado" no card.
        assert.equal(card.enabled, true, `${card.id}: sem override, o site está ligado por si`);
        assert.equal(status.enabled, false, 'o motor é que está desligado');
        assert.ok(card.siteConfig, `${card.id}: a config efetiva chega no card`);
        assert.equal(card.siteConfig.maxPerHour, 1000, `${card.id}: config efetiva herda o global`);
        // Sem pendência e sem custo medido, o ETA é zero com o motivo declarado
        // — nunca horas inventadas a partir de um teto que ninguém mediu.
        assert.equal(card.etaHours, 0);
        assert.equal(card.etaBasis, 'sem-pendencia');
      }
    } finally {
      // Fecha a engine ANTES de apagar: no Windows o crawl.db aberto trava o
      // unlink, e a engine vazada contaminaria o caso seguinte.
      store.resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('o gate é coerente com requireProbe e o veredito gravado é lido', () => {
    const dir = closedStore();
    try {
      freshCrawl({ enabled: false, sites: ['a', 'b'], requireProbe: true });
      crawler.start();
      const semGo = crawler.status().sites.find((s) => s.id === 'a');
      assert.equal(semGo?.probe.required, true);
      assert.equal(semGo?.probe.verdict, null, 'sem veredito gravado, o painel nunca vê "go"');
      assert.equal(semGo?.probe.ok, false);
      assert.equal(semGo?.probe.blockedBy, 'sem-veredito', 'o motivo da não liberação é explícito');

      // Veredito gravado: o card tem de MOSTRÁ-lo mesmo com o motor desligado.
      store.engine().setState('b', PROBE_STATE_KEY, goVerdict('b'));
      const go = crawler.status().sites.find((s) => s.id === 'b');
      assert.equal(go?.probe.verdict, 'go', 'veredito gravado é visível sem o motor estar ligado');
      assert.equal(go?.probe.ok, true);
      assert.equal(go?.probe.blockedBy, null);
      assert.equal(go?.probe.sample, 40);
    } finally {
      // Fecha a engine ANTES de apagar: no Windows o crawl.db aberto trava o
      // unlink, e a engine vazada contaminaria o caso seguinte.
      store.resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('o motor desligado não abre nada — quem abre é o status, e abre UMA vez', () => {
    const dir = closedStore();
    try {
      freshCrawl({ enabled: false, sites: ['a', 'b'] });
      crawler.start();
      assert.equal(store.currentEngine(), null, 'start() com enabled=false volta antes de abrir');
      const primeiro = crawler.status();
      const engine = store.currentEngine();
      assert.notEqual(engine, null, 'o status abriu o store');
      crawler.status();
      assert.equal(store.currentEngine(), engine, 'a engine existente é REUTILIZADA (nada de reabrir)');
      assert.deepEqual(primeiro.sites.map((s) => s.id), ['a', 'b']);

      // Abrir pelo status não é autorizar: nem veredito, nem fila, nem rodada.
      for (const id of ['a', 'b']) {
        assert.equal(engine?.counters(id).total, 0, `${id}: o status não enfileirou nada`);
        assert.equal(engine?.getState(id, PROBE_STATE_KEY), null, `${id}: o status não gravou veredito`);
        assert.equal(engine?.latestRun(id), null, `${id}: o status não abriu rodada`);
        assert.equal(engine?.listByStatus(id, 'done', 5).length, 0, `${id}: nenhuma linha de fila`);
      }
    } finally {
      // Fecha a engine ANTES de apagar: no Windows o crawl.db aberto trava o
      // unlink, e a engine vazada contaminaria o caso seguinte.
      store.resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('requireProbe com o store NUNCA aberto não trava o motor em si mesmo', { skip: skipSemSqlite }, async () => {
    const dir = closedStore();
    try {
      // Boot desligado (não abre nada) e depois o operador religa pelo REST —
      // caminho em que nenhum poll do painel passou para abrir o store.
      freshCrawl({ enabled: false, sites: ['a'], requireProbe: true });
      crawler.start();
      store.resetForTests();
      assert.equal(store.currentEngine(), null, 'premissa: nenhuma engine aberta');
      // Grava o veredito no ARQUIVO e fecha tudo: o tick tem de reabrir e ler.
      store.resetForTests();
      store.open(path.join(dir, 'crawl.db'));
      store.engine().setState('a', PROBE_STATE_KEY, goVerdict('a'));
      store.close();
      store.resetForTests();
      assert.equal(store.currentEngine(), null, 'store fechado de novo: o tick precisa reabrir');

      useSites({ a: fakeSite('a') });
      // O `dbPath` volta junto: o `tick` reabre pelo MESMO arquivo onde o
      // veredito foi gravado (e este `dbPath` é o temporário do caso, nunca o
      // do repositório).
      freshCrawl({ enabled: true, sites: ['a'], requireProbe: true, dbPath: path.join(dir, 'crawl.db') });
      crawler._forceDiscoveryForTest('a');
      await crawler.tick();

      assert.notEqual(store.currentEngine(), null, 'o tick abriu a engine para LER o veredito');
      const card = statusOf('a');
      assert.equal(card?.probe.verdict, 'go', 'o GO gravado é visto sem depender do painel');
      assert.ok(
        (card?.cycle.discoveryAdded ?? 0) > 0,
        'e o site entrou na rotação (o gate fail-closed não trancou o motor)',
      );
    } finally {
      store.resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

