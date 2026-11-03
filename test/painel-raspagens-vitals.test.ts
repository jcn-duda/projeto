// Vitals do card no cliente (Fase 4.1/2.1 + holds do /status do sidecar).
// Função pura sobre o payload do bloco `crawl`: sem DOM e sem rede, como no
// padrão dos demais testes do painel. O foco é o fail-open — campo ausente do
// MotorStatus novo vira null/vazio, nunca 0 afirmado nem card quebrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardEtaLabel,
  etaByRateLabel,
  expiredLabel,
  holdForSite,
  holdLabel,
  holdLine,
  http429Label,
  observedRateLabel,
  sidecarExtras,
  siteVitalsOf,
  snapshotAgeLabel,
  vitalsLine,
} from '../src/client/painel/raspagens-vitals.js';
import { etaLabel, type CrawlSiteCard } from '../src/client/painel/raspagens-model.js';
import { ageText } from '../src/client/painel/raspagens-site.js';

const NOW = 1_700_000_000_000;

function cardFixture(over: Record<string, any> = {}): CrawlSiteCard {
  return {
    id: 'bludv-cardigann',
    label: 'BLUDV',
    active: false,
    phase: null,
    total: 100,
    done: 60,
    pending: 5,
    inflight: 0,
    noTorrent: 3,
    noWork: 2,
    error: 1,
    simulated: 0,
    partial: 0,
    progressPercent: 60,
    torrentPercent: 90,
    magnetsFound: 42,
    newReleases: 7,
    pendingRemaining: 24,
    ratePerHour: 500,
    etaHours: null,
    latestRun: null,
    recentWorks: [],
    noWorkList: [],
    errors: [],
    errorGroups: [],
    partialWork: [],
    override: { enabled: true, dryRun: false, delayMs: 700, maxPerHour: 500, overridden: [] },
    probe: {
      verdict: 'go', at: 1, sample: 10,
      rates: { valid: 1, magnet: 1, identify: 1, magnetsPerPage: 2 },
      reasons: [], block: false, inRotation: true, out: null, skip: null, blockedBy: null,
    },
    paused: false,
    ...over,
  } as CrawlSiteCard;
}

test('sidecarExtras lê o serde snake_case do Rust e tolera camelCase', () => {
  const snake = sidecarExtras({
    sidecar: {
      holds: [{ site_id: 'bludv', until_ms: NOW + 180_000 }],
      deferred_count: 7,
      pages_this_hour: 99,
    },
  });
  assert.deepEqual([...snake.holds.entries()], [['bludv', NOW + 180_000]]);
  assert.equal(snake.deferredCount, 7);
  assert.equal(snake.pagesThisHour, 99);

  const camel = sidecarExtras({ sidecar: { holds: [{ siteId: 'vaca', untilMs: 5 }] } });
  assert.deepEqual([...camel.holds.entries()], [['vaca', 5]]);

  // Fail-open: sidecar fora do ar ou campo novo ausente — vazio/null, nunca 0.
  const vazio = sidecarExtras(null);
  assert.equal(vazio.holds.size, 0);
  assert.equal(vazio.deferredCount, null);
  assert.equal(vazio.pagesThisHour, null);

  const semCampos = sidecarExtras({ sidecar: {} });
  assert.equal(semCampos.holds.size, 0, 'sem holds no payload: mapa vazio');
  assert.equal(semCampos.deferredCount, null, 'deferred_count ausente: null, não 0');

  const sujo = sidecarExtras({
    sidecar: { holds: [null, 'x', { site_id: '  ' }, { site_id: 'a' }, { site_id: 'b', until_ms: 'nan' }] },
  });
  assert.equal(sujo.holds.size, 0, 'entrada malformada não entra no mapa');
});

test('hold vigente vira "em espera até" relativo; vencido não é espera', () => {
  const extras = sidecarExtras({
    sidecar: {
      holds: [
        { site_id: 'bludv', until_ms: NOW + 180_000 },
        { site_id: 'vaca', until_ms: NOW - 1000 },
      ],
    },
  });
  assert.equal(holdForSite(extras, 'bludv', NOW), NOW + 180_000);
  assert.equal(holdForSite(extras, 'vaca', NOW), null, 'hold vencido não conta como espera');
  assert.equal(holdForSite(extras, 'nerdfilmes', NOW), null, 'site sem hold: null (a linha some)');

  assert.equal(holdLabel(NOW + 180_000, NOW), 'em 3min');
  assert.equal(holdLabel(NOW + 125 * 60_000, NOW), 'em 2h 5min');
  assert.equal(holdLabel(NOW + 120 * 60_000, NOW), 'em 2h');
  assert.equal(holdLabel(NOW - 1000, NOW), 'liberando', 'passado chega só por corrida de render');
});

test('siteVitalsOf lê o payload cru do backend; campo ausente é null, não 0', () => {
  const crawl = {
    sites: [{
      id: 'bludv', pagesLastHour: 12, pagesSample: 40, pagesSaturated: true,
      http429: { total: 3, lastHour: 1 }, expired: {}, snapshotAt: 123,
    }],
  };
  const vitals = siteVitalsOf(crawl, 'bludv');
  assert.equal(vitals.pagesLastHour, 12);
  assert.equal(vitals.pagesSaturated, true);
  assert.deepEqual(vitals.http429, { total: 3, lastHour: 1 });
  assert.equal(vitals.expired.total, null, 'stat parcial: null — o rótulo some em vez de afirmar');
  assert.equal(siteVitalsOf(crawl, 'vaca').pagesLastHour, null, 'site fora da foto: tudo null');
  assert.equal(siteVitalsOf(null, 'vaca').snapshotAt, null, 'payload vazio: fail-open');
});

test('rótulos dos vitals: só com medida de verdade, "≥" quando a amostra satura', () => {
  const de = (over: Record<string, any>) => siteVitalsOf({ sites: [{ id: 'a', ...over }] }, 'a');
  assert.equal(observedRateLabel(de({ pagesLastHour: 12 })), '12 pág/h');
  assert.equal(observedRateLabel(de({ pagesLastHour: 12, pagesSaturated: true })), '≥12 pág/h');
  assert.equal(observedRateLabel(de({})), '', 'ritmo não medido: rótulo some');

  assert.equal(http429Label({ total: null, lastHour: null }), '');
  assert.equal(http429Label({ total: 0, lastHour: 0 }), '');
  assert.equal(http429Label({ total: 5, lastHour: null }), '429: 5');
  assert.equal(http429Label({ total: 5, lastHour: 2 }), '429: 5 (2 na última hora)');
  assert.equal(expiredLabel({ total: 4, lastHour: 0 }), 'expirados: 4');
  assert.equal(expiredLabel({ total: 4, lastHour: 3 }), 'expirados: 4 (3 na última hora)');

  assert.equal(
    vitalsLine(de({ pagesLastHour: 12, http429: { total: 3, lastHour: 1 }, expired: { total: 2, lastHour: 0 } })),
    'ritmo observado 12 pág/h · 429: 3 (1 na última hora) · expirados: 2',
  );
  assert.equal(vitalsLine(siteVitalsOf(null, 'a')), '', 'nada medido: a linha inteira some');
});

test('ETA: backend primeiro; fallback é pendência ÷ ritmo observado; ritmo 0 é "—"', () => {
  assert.equal(etaByRateLabel(24, 12), etaLabel(2), '24 pendentes a 12/h: 2h');
  assert.equal(etaByRateLabel(24, 0), null, 'ritmo 0: sem chute (o chamador mostra "—")');
  assert.equal(etaByRateLabel(24, null), null, 'ritmo não medido: sem chute');
  assert.equal(etaByRateLabel(0, 12), null);

  const vitals12 = siteVitalsOf({ sites: [{ id: 'bludv-cardigann', pagesLastHour: 12 }] }, 'bludv-cardigann');
  assert.equal(cardEtaLabel(cardFixture({ pendingRemaining: 0, total: 100 }), vitals12), 'concluído');
  assert.equal(cardEtaLabel(cardFixture({ etaHours: 2 }), vitals12), '2h', 'ETA medido do backend tem precedência');
  assert.equal(cardEtaLabel(cardFixture({ etaHours: null, pendingRemaining: 24 }), vitals12), '2h', 'fallback: pendência ÷ ritmo observado');
  assert.equal(cardEtaLabel(cardFixture({ etaHours: null, pendingRemaining: 24 }), siteVitalsOf(null, 'x')), '—', 'sem ritmo medido: "—"');
});

test('linhas compostas: espera do hold + adiadas; idade da foto separa site zerado de ponte', () => {
  const extras = sidecarExtras({
    sidecar: { holds: [{ site_id: 'bludv', until_ms: NOW + 180_000 }], deferred_count: 7 },
  });
  assert.equal(holdLine(extras, 'bludv', NOW), 'em espera até em 3min · 7 adiada(s) pelo motor');
  assert.equal(holdLine(sidecarExtras(null), 'bludv', NOW), '', 'sem sidecar: a linha some');
  assert.equal(holdLine(sidecarExtras({ sidecar: { deferred_count: 0 } }), 'bludv', NOW), '', '0 adiadas não afirma problema');

  assert.equal(snapshotAgeLabel(siteVitalsOf(null, 'a'), NOW), 'sem foto do sidecar');
  assert.equal(snapshotAgeLabel(siteVitalsOf({ sites: [{ id: 'a', snapshotAt: NOW - 5 * 60_000 }] }, 'a'), NOW), 'foto há 5min');
});
