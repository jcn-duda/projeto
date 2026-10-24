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
  test('sem veredito o site fica barrado quando o gate é exigido', () => {
    freshCrawl({ requireProbe: true });
    // Quem respeita o gate na rotação é o sidecar; o card mostra o bloqueio.
    assert.equal(statusOf('a')?.probe?.required, true);
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

  test('GO gravado no crawl_state libera o site no card', () => {
    freshCrawl({ requireProbe: true });
    store.engine().setState('a', PROBE_STATE_KEY, goVerdict('a', {
      rates: { valid: 0.95, magnet: 0.8, identify: 0.7, magnetsPerPage: 1.4 },
      reasons: ['no-work-dominante'],
    }));
    assert.equal(statusOf('b')?.probe?.ok, false, 'site sem veredito continua barrado');
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

  test('gate desligado não barra ninguém (compat com antes da Fase 8)', () => {
    assert.equal(statusOf('a')?.probe?.required, false);
    assert.equal(statusOf('b')?.probe?.required, false);
  });
});

describe('crawl multi-site: estado isolado por site', () => {
  test('pausa de um site não mexe no vizinho', () => {
    const paused = crawler.setPaused(true, 'a');
    assert.equal(paused.ok, true);
    assert.equal(paused.paused, true);
    assert.equal(statusOf('a')?.paused, true);
    assert.equal(statusOf('b')?.paused, false, 'o vizinho não herda a pausa');
    assert.equal(crawler.setPaused(false, 'a').paused, false, 'religar devolve o site');
  });

  test('pausa de site inexistente é recusada (não cria runtime fantasma)', () => {
    const out = crawler.setPaused(true, 'nao-configurado');
    assert.equal(out.ok, false);
    assert.ok(out.error);
  });
});

describe('crawl multi-site: status (topo é o site ativo, card é por site)', () => {
  test('um card por site CONFIGURADO, com rótulo e disponibilidade do adaptador', () => {
    freshCrawl({ sites: ['a', 'b', 'bludv-cardigann'] });
    const status = crawler.status();
    assert.deepEqual(status.sitesConfigured, ['a', 'b', 'bludv-cardigann']);
    assert.equal(status.sites.length, 3, 'site configurado sem adaptador também aparece');
    const bludv = status.sites.find((s) => s.id === 'bludv-cardigann');
    assert.equal(bludv?.site.known, true, 'id da tabela BR é reconhecido');
    // `adapter` vem do REGISTRY: o BLUDV é do sidecar Rust, então o card diz `true`.
    assert.equal(bludv?.site.adapter, true, 'o card do BLUDV tem adaptador (registry)');
    assert.equal(bludv?.site.label, 'BLUDV');
    assert.equal(registry.siteInfo('nao-existe').known, false);
  });

  test('topo reflete o primeiro site e o teto agregado é do processo', () => {
    const status = crawler.status();
    const active = status.sites.find((s) => s.id === status.site);
    assert.ok(active, 'o topo aponta para um card real');
    assert.deepEqual(status.cursors, active?.cursors, 'cursor do topo é o do site ativo');
    assert.equal(status.dryRun, active?.dryRun, 'dryRun do topo é o do site ativo');
    assert.equal(status.maxPerHourTotal, 1000, 'teto agregado do processo');
    assert.equal(status.pagesThisHourTotal, 0, 'o custo por hora é contado pelo sidecar (foto `sidecar`)');
  });

  test('ETA sem custo medido no Node é null (não promete hora inventada)', () => {
    store.engine().upsertUrls('a', [movie('/a1'), movie('/a2')], 1);
    const card = statusOf('a');
    assert.equal(card?.pendingRemaining, 2, 'a fila do site existe');
    assert.equal(card?.etaHours, null, 'sem custo medido, ETA é indisponível');
    // O custo por página é medido pelo sidecar (foto `sidecar` do bloco).
    assert.equal(card?.etaBasis, 'sem-custo-medido');
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
    store.engine().upsertUrls('a', [movie('/a/1')], 1);
    const out = await crawler.simulate(5, 'site-fantasma');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'site-desconhecido');
    assert.equal(store.engine().counters('a').byStatus.inflight, 0);
  });

  test('simulate por site sem adaptador TS responde sem-adaptador e não toca a fila', async () => {
    store.engine().upsertUrls('b', [movie('/b/1')], 1);
    const out = await crawler.simulate(5, 'b');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'sem-adaptador');
    assert.equal(out.site, 'b');
    assert.equal(out.pages, 0);
    assert.equal(store.engine().getUrl('b', '/b/1')?.status, 'pending', 'simulação não consome');
  });
});
