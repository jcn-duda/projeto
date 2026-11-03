// VOCABULÁRIO ÚNICO dos "tick pulado" (Fase 4.3): o card explica POR QUE o
// site não anda com um só mapa (motivos do motor + derivados do painel), na
// ordem de autoridade. Função pura, sem DOM e sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKIP_VOCAB,
  skipHint,
  skipLabel,
  siteWhyIdle,
  whyIdleText,
} from '../src/client/painel/raspagens-skip.js';
import type { CrawlSiteCard, CrawlSummary } from '../src/client/painel/raspagens-model.js';

const NOW = 1_700_000_000_000;

function summaryFixture(over: Partial<CrawlSummary> = {}): CrawlSummary {
  return {
    enabled: true,
    dryRun: false,
    paused: false,
    autoPause: null,
    site: 'vaca',
    siteReady: true,
    sitesConfigured: ['vaca'],
    engine: 'sidecar',
    cursor: null,
    cursors: { movie: null, tv_show: null },
    nextDiscoveryAt: null,
    pagesThisHour: 10,
    maxPerHour: 500,
    delayMs: 700,
    idleWindowMs: 3000,
    errorStreak: 0,
    canaryStreak: 0,
    runOpen: false,
    probeBlock: false,
    ...over,
  } as CrawlSummary;
}

function cardFixture(over: Record<string, any> = {}): CrawlSiteCard {
  return {
    id: 'vaca',
    label: 'Vaca',
    active: false,
    phase: null,
    total: 10,
    done: 5,
    pending: 5,
    inflight: 0,
    noTorrent: 0,
    noWork: 0,
    error: 0,
    simulated: 0,
    partial: 0,
    progressPercent: 50,
    torrentPercent: 100,
    magnetsFound: 3,
    newReleases: 1,
    pendingRemaining: 5,
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

test('o vocabulário cobre os motivos do motor e os derivados do painel', () => {
  const motor = ['pausado', 'auto-pausa', 'teto-horario', 'usuario-ativo', 'parser-pendente', 'ingest-pendente', 'sem-fila'];
  const derivados = ['desabilitado', 'probe', 'sem-adaptador', 'sem-trabalho', 'em-espera'];
  for (const id of [...motor, ...derivados]) {
    assert.ok(SKIP_VOCAB[id]?.label, `motivo ${id} tem rótulo`);
    assert.ok(SKIP_VOCAB[id].hint, `motivo ${id} tem o porquê`);
  }
  assert.equal(skipLabel('teto-horario'), 'teto horário');
  assert.equal(skipHint('usuario-ativo'), 'o app está em uso; a raspagem só roda com o app ocioso');
  assert.equal(skipLabel('motivo-novo-do-motor'), 'motivo-novo-do-motor', 'id desconhecido: o próprio id, nunca rótulo inventado');
  assert.equal(skipHint('motivo-novo-do-motor'), '', 'hint inventado seria mentira');
  assert.equal(skipLabel(null), '');
  assert.equal(skipHint(undefined), '');
});

test('"por que não anda" segue a ordem de autoridade e nunca mente em site ativo', () => {
  const summary = summaryFixture();

  // Exclusão da rotação vence TUDO — mesmo com pausa e hold vigente.
  const fora = siteWhyIdle(
    cardFixture({ probe: { ...cardFixture().probe, out: 'desligado' }, paused: true }),
    summary,
    NOW + 60_000,
  );
  assert.deepEqual(fora.map((r) => r.id), ['desabilitado']);

  const semGo = siteWhyIdle(
    cardFixture({ probe: { ...cardFixture().probe, out: 'sem-go' } }),
    summary,
    null,
  );
  assert.deepEqual(semGo.map((r) => r.id), ['probe']);

  // Auto-pausa vem antes da pausa manual; hold entra como 'em-espera'.
  const parado = siteWhyIdle(
    cardFixture({ active: true, paused: true }),
    summaryFixture({ autoPause: { reason: 'error-streak', detail: 'x' } }),
    NOW + 60_000,
  );
  assert.deepEqual(parado.map((r) => r.id), ['auto-pausa', 'pausado', 'em-espera']);

  // Teto horário: balde GLOBAL do summary cheio enquanto o site é o ativo.
  const teto = siteWhyIdle(
    cardFixture({ active: true }),
    summaryFixture({ pagesThisHour: 500, maxPerHour: 500 }),
    null,
  );
  assert.deepEqual(teto.map((r) => r.id), ['teto-horario']);
  // Fora da vez (não ativo), o site não é quem consome o balde: sem motivo.
  assert.equal(siteWhyIdle(cardFixture(), summaryFixture({ pagesThisHour: 500, maxPerHour: 500 }), null).length, 0);
  // Balde não cheio e teto 0 (desligado) nunca satura.
  assert.equal(siteWhyIdle(cardFixture({ active: true }), summaryFixture({ pagesThisHour: 499, maxPerHour: 500 }), null).length, 0);
  assert.equal(siteWhyIdle(cardFixture({ active: true }), summaryFixture({ pagesThisHour: 999, maxPerHour: 0 }), null).length, 0);

  // skipReason do motor entra com o MESMO vocabulário, sem duplicar.
  const motor = siteWhyIdle(
    cardFixture({ probe: { ...cardFixture().probe, skip: 'usuario-ativo' } }),
    summary,
    null,
  );
  assert.deepEqual(motor.map((r) => r.id), ['usuario-ativo']);

  // Site ativo e sem freio: vazio — "não anda" tem que ser verdade.
  assert.deepEqual(siteWhyIdle(cardFixture({ active: true }), summary, null), []);
});

test('whyIdleText junta rótulo e porquê; sem motivo, a linha some', () => {
  const reasons = siteWhyIdle(
    cardFixture({ active: true, paused: true }),
    summaryFixture({ autoPause: { reason: 'x', detail: 'y' } }),
    null,
  );
  assert.equal(reasons.length, 2);
  assert.match(whyIdleText(reasons), /^pausa automática — /);
  assert.match(whyIdleText(reasons), /pausado — pausa manual do operador/);
  assert.equal(whyIdleText([]), '');
});
