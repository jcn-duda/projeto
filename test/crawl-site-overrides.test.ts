// Config ao vivo POR SITE e GATE DA SONDA (Fase 8): fusão global+override com
// trava de segurança (o delay do site só AUMENTA, o teto só DIMINUI), cadência
// do timer, veredito da sonda como único liberador (falha fechada em tudo o
// mais), isolamento de estado por site, status com um card por site e as ações
// por site. O rodízio em si tem suíte irmã em `crawl-multisite.test.ts`.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const store = await import('../src/utils/crawl-store.js');
const crawler = await import('../src/providers/crawler.js');
const live = await import('../src/utils/crawler-live.js');
const { siteConfigOf, cadenceDelayMs, withCadence } = await import('../src/utils/crawler-live-site.js');
const { PROBE_STATE_KEY, verdictFor, probeGate, probeGateOpen } = await import('../src/providers/crawl-probe-gate.js');
const { idleFractionOf, createSiteRuntime } = await import('../src/providers/crawl-site-runtime.js');
const registry = await import('../src/providers/crawl-sites/registry.js');
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
    fetchWork: async (url: string) => ({
      url, status: 'done', imdb: 'tt1000000', title: 'Obra', year: 2000,
      type: 'movie', releases: [item(url)],
    }),
    ...over,
  };
}

/** Registro dublê: dois sites, ids fora da tabela BR (o motor não exige). */
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

describe('crawl multi-site: config efetiva por site (trava de segurança)', () => {
  test('delay do site só AUMENTA e teto do site só DIMINUI', () => {
    const base = live.effective();
    assert.equal(siteConfigOf(base, 'a').delayMs, base.delayMs);
    // Pedido de afrouxar a educação com o site é ignorado no cálculo efetivo.
    const faster = { ...base, siteOverrides: { a: { delayMs: 0, maxPerHour: 99_999 } } };
    assert.equal(siteConfigOf(faster, 'a').delayMs, base.delayMs, 'site nunca fica mais rápido que o global');
    assert.equal(siteConfigOf(faster, 'a').maxPerHour, base.maxPerHour, 'site nunca ganha teto acima do global');
    // Endurecer é permitido.
    const slower = { ...base, siteOverrides: { a: { delayMs: 9_000, maxPerHour: 100 } } };
    assert.equal(siteConfigOf(slower, 'a').delayMs, 9_000);
    assert.equal(siteConfigOf(slower, 'a').maxPerHour, 100);
    assert.deepEqual(siteConfigOf(slower, 'a').overridden, ['delayMs', 'maxPerHour']);
  });

  test('enabled ausente = ligado (o kill-switch é o global, não do site)', () => {
    const base = { ...live.effective(), enabled: false };
    assert.equal(siteConfigOf(base, 'a').enabled, true, 'site configurado não nasce desligado');
    assert.equal(siteConfigOf({ ...base, siteOverrides: { a: { enabled: false } } }, 'a').enabled, false);
  });

  test('cadência do timer é o MENOR delay entre sites que podem trabalhar', () => {
    const base = { ...live.effective(), delayMs: 5_000, siteOverrides: {} };
    assert.equal(cadenceDelayMs(base), 5_000, 'sem override, vale o delay global');
    // A trava de segurança impede o site de ser MAIS RÁPIDO que o global, então
    // um override de delay menor não acelera o timer — este é o contrato.
    const faster = { ...base, siteOverrides: { b: { delayMs: 1_000 } } };
    assert.equal(siteConfigOf(faster, 'b').delayMs, 5_000, 'site nunca fica mais rápido que o global');
    assert.equal(cadenceDelayMs(faster), 5_000);
    const globalZero = { ...live.effective(), delayMs: 0, sites: ['b'], siteOverrides: { b: { delayMs: 2_000 } } };
    assert.equal(cadenceDelayMs(globalZero), 2_000, 'site único mais lento define a cadência');
    assert.equal(withCadence(globalZero).delayMs, 2_000);
  });

  test('setSiteOverride recusa chave desconhecida e site fora de CRAWL_SITES', () => {
    const bad = live.setSiteOverride('a', { enabled: true, nasa: 1 } as Record<string, unknown>);
    assert.equal(bad.ok, false);
    assert.ok((bad.errors ?? []).some((e) => /nasa/.test(e)), 'chave fora do subconjunto é erro nomeado');
    const ghost = live.setSiteOverride('site-fantasma', { enabled: false });
    assert.equal(ghost.ok, false, 'override de site não configurado é recusado');
    assert.equal(live.effective().siteOverrides['site-fantasma'], undefined);
    const ok = live.setSiteOverride('a', { delayMs: 10_000_000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.effective.delayMs, Math.min(60_000, 10_000_000), 'clamp de validade 0..60.000');
  });

  test('limpar o override de um site não toca o outro nem os globais', () => {
    live.setSiteOverride('a', { delayMs: 3_000 });
    live.setSiteOverride('b', { delayMs: 4_000 });
    const out = live.clearSiteOverride('a');
    assert.equal(out.ok, true);
    assert.deepEqual(out.overriddenKeys, ['delayMs']);
    assert.equal(live.effective().siteOverrides['a'], undefined);
    assert.equal(siteConfigOf(live.effective(), 'b').delayMs, 4_000);
  });
});

describe('crawl multi-site: gate da sonda (veredito GO é o único que libera)', () => {
  test('sem veredito o site fica barrado quando o gate é exigido', async () => {
    freshCrawl({ requireProbe: true });
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 3; i += 1) await crawler.tick();
    assert.equal(store.engine().counters('a').total, 0, 'sem amostra o site não discovery');
    assert.equal(statusOf('a')?.skipReason, 'probe');
    assert.equal(statusOf('a')?.probe?.ok, false);
    assert.equal(statusOf('a')?.probe?.blockedBy, 'sem-veredito');
  });

  test('veredito GO válido libera; veredito de outro site NÃO', () => {
    const parsed = verdictFor('a', goVerdict('a'));
    assert.equal(parsed?.ok, true);
    assert.equal(probeGateOpen(true, parsed), true);
    assert.equal(verdictFor('b', goVerdict('a'))?.blockedBy, 'veredito-de-outro-site');
    assert.equal(probeGateOpen(true, verdictFor('b', goVerdict('a'))), false);
  });

  test('falha fechada: amostra incompleta, stop parcial, versão e veredito não-go', () => {
    assert.equal(verdictFor('a', goVerdict('a', { counts: { sample: 39 } }))?.blockedBy, 'amostra-incompleta');
    assert.equal(verdictFor('a', goVerdict('a', { stop: 'descoberta-pequena' }))?.blockedBy, 'parcial');
    assert.equal(verdictFor('a', goVerdict('a', { v: 99 })), null, 'versão desconhecida é veredito ausente');
    assert.equal(verdictFor('a', goVerdict('a', { verdict: 'no-go' }))?.blockedBy, 'sem-go');
    assert.equal(verdictFor('a', goVerdict('a', { verdict: 'inconclusive' }))?.blockedBy, 'sem-go');
    assert.equal(verdictFor('a', 'lixo'), null, 'texto solto não é veredito');
    assert.equal(verdictFor('a', 'GO'), null, 'GO maiúsculo solto (codec antigo) não libera');
  });

  test('GO gravado no crawl_state libera o site na rotação', async () => {
    freshCrawl({ requireProbe: true });
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    store.engine().setState('a', PROBE_STATE_KEY, goVerdict('a', {
      rates: { valid: 0.95, magnet: 0.8, identify: 0.7, magnetsPerPage: 1.4 },
      reasons: ['no-work-dominante'],
    }));
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    assert.equal(store.engine().counters('a').total, 2, 'site medido entra na rotação');
    assert.equal(store.engine().counters('b').total, 0, 'site sem veredito continua barrado');
    assert.equal(statusOf('a')?.probe?.verdict, 'go');
    assert.equal(statusOf('a')?.probe?.ok, true);
    assert.equal(statusOf('a')?.probe?.sample, 40);
    // As MEDIDAS chegam no card: sem isto o painel tinha UI de taxa e motivo
    // que o backend nunca mandava (a tela ficava muda com o veredito gravado).
    assert.equal(statusOf('a')?.probe?.rates?.magnet, 0.8, 'a taxa medida do veredito vai no card');
    assert.equal(statusOf('a')?.probe?.rates?.magnetsPerPage, 1.4);
    assert.equal(statusOf('a')?.probe?.counts?.withRelease, 32);
    assert.deepEqual(statusOf('a')?.probe?.reasons, ['no-work-dominante']);
  });

  test('o gate expõe as medidas do veredito, e ausente é null (nunca 0%)', () => {
    const medido = probeGate(true, verdictFor('a', goVerdict('a', {
      rates: { valid: 0.95, magnet: 0.8, identify: 0.7, magnetsPerPage: 1.4 },
      reasons: ['no-work-dominante'],
    })));
    assert.equal(medido.rates?.valid, 0.95);
    assert.equal(medido.rates?.magnetsPerPage, 1.4);
    assert.equal(medido.counts?.withRelease, 32);
    assert.deepEqual(medido.reasons, ['no-work-dominante']);

    // Nunca rodou: a taxa é `null`, não 0% — 0% afirmaria que a sonda mediu e
    // reprovou, e é o que o painel projeta na tela.
    const semVeredito = probeGate(true, null);
    assert.equal(semVeredito.rates, null);
    assert.equal(semVeredito.counts, null);
    assert.deepEqual(semVeredito.reasons, []);

    // Medida alheia não aparece como se fosse deste site: o veredito de `a` no
    // card de `b` explica a não liberação, mas os números são de `a`.
    const outro = probeGate(true, verdictFor('b', goVerdict('a')));
    assert.equal(outro.blockedBy, 'veredito-de-outro-site');
    assert.equal(outro.rates, null, 'taxa de outro site não é medida deste');
    assert.deepEqual(outro.reasons, []);

    // Já é DESTE site e não liberou: as medidas continuam honestas e mostráveis
    // (é o GO com amostra incompleta que o operador precisa enxergar).
    const parcial = probeGate(true, verdictFor('a', goVerdict('a', { counts: { sample: 39 } })));
    assert.equal(parcial.blockedBy, 'amostra-incompleta');
    assert.equal(parcial.counts?.sample, 39);
  });

  test('gate desligado não barra ninguém (compat com antes da Fase 8)', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    // Serial: item vencido tem precedência sobre descoberta, então a fila de `a`
    // (2 páginas) é servida antes da descoberta de `b` — e fechar a rodada de
    // `a` consome um tick sem rede (comportamento herdado do motor de site único).
    for (let i = 0; i < 6; i += 1) await crawler.tick();
    assert.equal(store.engine().counters('a').total, 2);
    assert.equal(store.engine().counters('b').total, 2);
    assert.equal(statusOf('a')?.probe?.required, false);
  });
});

describe('crawl multi-site: estado isolado por site', () => {
  test('pausa e teto de um site não mexem no vizinho', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    const paused = crawler.setPaused(true, 'a');
    assert.equal(paused.ok, true);
    assert.equal(paused.paused, true);
    live.setSiteOverride('b', { maxPerHour: 1 });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 3; i += 1) await crawler.tick();
    assert.equal(store.engine().counters('a').total, 0, 'site pausado não trabalha');
    assert.equal(statusOf('a')?.paused, true);
    assert.equal(statusOf('a')?.skipReason, 'pausado');
    assert.ok(store.engine().counters('b').total > 0, 'vizinho segue rodando');
  });

  test('pausa de site inexistente é recusada (não cria runtime fantasma)', () => {
    const out = crawler.setPaused(true, 'nao-configurado');
    assert.equal(out.ok, false);
    assert.ok(out.error);
  });

  test('pausa automática (streak do site) é isolada por site', async () => {
    freshCrawl({ errorPauseStreak: 2 });
    const broken: CrawlSite = {
      id: 'a', label: 'A quebrado',
      discover: async (): Promise<CrawlDiscovery> => ({ urls: [movie('/a1'), movie('/a2')], complete: true, failures: [] }),
      fetchWork: async (url: string): Promise<CrawlWorkResult> => ({ url, status: 'error', error: 'HTTP 403 Forbidden' }),
    };
    useSites({ a: broken, b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 8; i += 1) await crawler.tick();
    assert.equal(statusOf('a')?.autoPause?.reason, 'error-streak');
    assert.equal(statusOf('a')?.skipReason, 'auto-pausa');
    assert.ok(store.engine().counters('b').total > 0, 'o outro site não herdou a pausa');
    assert.equal(statusOf('b')?.autoPause, null);
  });

  test('ciclo e cursor são por site', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 8; i += 1) await crawler.tick();
    const ca = store.engine().counters('a');
    const cb = store.engine().counters('b');
    assert.equal(ca.total, 2);
    assert.equal(cb.total, 2);
    assert.ok(store.engine().latestRun('a'), 'cada site tem a sua rodada');
    assert.ok(store.engine().latestRun('b'));
  });
});

describe('crawl multi-site: status (topo é o site ativo, card é por site)', () => {
  test('um card por site CONFIGURADO, com rótulo e disponibilidade do adaptador', () => {
    freshCrawl({ sites: ['a', 'b', 'bludv-cardigann'] });
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    const status = crawler.status();
    assert.deepEqual(status.sitesConfigured, ['a', 'b', 'bludv-cardigann']);
    assert.equal(status.sites.length, 3, 'site configurado sem adaptador também aparece');
    const bludv = status.sites.find((s) => s.id === 'bludv-cardigann');
    assert.equal(bludv?.site.known, true, 'id da tabela BR é reconhecido');
    // `adapter` vem do REGISTRY (`crawl-status.ts` monta o card de lá), não do
    // mapa `useSites` deste teste: o BLUDV entrou na tabela de adaptadores no
    // COMMIT 1 da Fase 8, então o card diz `true` mesmo com a instância injetada
    // sendo a falsa de `a`/`b`.
    assert.equal(bludv?.site.adapter, true, 'o card do BLUDV tem adaptador (registry)');
    assert.equal(bludv?.site.label, 'BLUDV');
    assert.equal(registry.siteInfo('nao-existe').known, false);
  });

  test('topo reflete o site ATIVO e o teto agregado é do processo', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    for (let i = 0; i < 8; i += 1) await crawler.tick();
    const status = crawler.status();
    const active = status.sites.find((s) => s.id === status.site);
    assert.ok(active, 'o topo aponta para um card real');
    assert.deepEqual(status.cursors, active?.cursors, 'cursor do topo é o do site ativo');
    assert.equal(status.dryRun, active?.dryRun, 'dryRun do topo é o do site ativo');
    assert.equal(status.maxPerHourTotal, 1000, 'teto agregado do processo');
    assert.ok((status.pagesThisHourTotal ?? 0) >= 2, 'custo agregado inclui as descobertas');
  });

  test('ETA sem ociosidade medida é null (não promete hora inventada)', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    crawler._forceDiscoveryForTest();
    await crawler.tick();
    const card = statusOf('a');
    assert.equal(card?.pendingRemaining, 2, 'a fila do site existe');
    assert.equal(card?.etaHours, null, 'sem amostra de ociosidade, ETA é indisponível');
    assert.equal(card?.etaBasis, 'sem-ociosidade-medida');
  });

  test('ETA com ociosidade medida é ajustado pela fração', () => {
    const rt = createSiteRuntime('a');
    assert.equal(idleFractionOf(rt), null, 'sem amostra não há fração');
    rt.attempts = 10; rt.trafficBlocks = 8;
    assert.equal(idleFractionOf(rt), 0.2, '8 de 10 ticks barrados pelo freio');
  });
});

describe('crawl multi-site: ações por site', () => {
  test('simulate rejeita site fora de CRAWL_SITES sem tocar a fila', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    store.engine().upsertUrls('a', [movie('/a/1')], 1);
    const out = await crawler.simulate(5, 'site-fantasma');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'site-desconhecido');
    assert.equal(store.engine().counters('a').byStatus.inflight, 0);
  });

  test('simulate por site roda no site pedido e devolve a fila', async () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    store.engine().upsertUrls('b', [movie('/b/1')], 1);
    const out = await crawler.simulate(5, 'b');
    assert.equal(out.ok, true);
    assert.equal(out.site, 'b');
    assert.equal(out.pages, 1);
    assert.equal(store.engine().getUrl('b', '/b/1')?.status, 'pending', 'simulação não consome');
  });

  test('"Zerar site" limpa a fila e PRESERVA o veredito da sonda', () => {
    useSites({ a: fakeSite('a'), b: fakeSite('b') });
    store.engine().upsertUrls('a', [movie('/a/1')], 1);
    store.engine().startRun('a', 'initial', '', 1);
    store.engine().setState('a', PROBE_STATE_KEY, goVerdict('a'));
    const out = crawler.resetSite('a');
    assert.equal(out.ok, true);
    assert.equal(store.engine().counters('a').total, 0, 'fila do site apagada');
    assert.equal(store.engine().getState('a', PROBE_STATE_KEY), goVerdict('a'), 'veredito preservado (medição cara)');
  });

  test('"Zerar site" recusa site não configurado', () => {
    const out = crawler.resetSite('nao-configurado');
    assert.equal(out.ok, false);
    assert.ok(out.error);
  });
});
