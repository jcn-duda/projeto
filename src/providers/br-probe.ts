// Sonda dirigida do Chupim (Fase 4 revisada).
//
// Problema: quando o pool BR do autofetch fica vazio, a cascata cai no pool de
// melhores sementes — enquanto o dublado pode existir, apenas fora da busca
// viva, nos index-only BR (ApacheTorrent Cardigann/Rede Torrent). Baixar seeds
// na frente disso aquece a obra errada e atrasa o dublado. A sonda procura o
// BR ANTES de liberar seeds, dirigindo o colhedor EXISTENTE só para a
// interseção `indexOnlyIndexers ∩ ptBrIndexers`.
//
// Este módulo é só ESTADO/ORQUESTRAÇÃO — nenhuma chamada de rede. Ele não fala
// com o Jackett: agenda a entrada `br-gap` (com a flag `brProbe`) na fila do
// colhedor e o worker existente executa o modo dirigido. Assim não há um
// segundo worker Jackett, e o orçamento/atividade/breaker do colhedor valem
// integralmente.
//
// Identidade GLOBAL por obra: `<type>:<imdbId>:<season>:<episode>`. Filme vai
// sem S/E (campos vazios); série é chaveada por EPISÓDIO — o pack de temporada
// cobre o episódio pelo lookup do índice, mas a sonda é sobre o que falta
// naquela abertura. Sem config/conta/segredo na chave: a sonda mede o que
// EXISTE nos trackers, não o que está pronto em qual conta.
import crypto from 'node:crypto';
import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import autofetchLive from '../utils/autofetch-live.js';
import { invalidateStreamsForObra } from '../utils/br-gap.js';
import * as harvestQueue from './harvest-queue.js';

export type BrProbeWork = {
  type: 'movie' | 'series';
  imdbId: string;
  season?: number | null;
  episode?: number | null;
};

export type BrProbeState = 'pending' | 'found' | 'empty' | 'failed' | 'capped';

/** Registro persistido. `leaseUntil` só existe em `pending`. */
type BrProbeRecord = {
  state: BrProbeState;
  at: number;
  leaseUntil?: number;
};

export type RequestBrProbeResult = {
  /** A entrada dirigida está agendada na fila. */
  probe: boolean;
  /** `pending` gravado (o worker vai executar o modo probe). */
  pending: boolean;
  /** Motivo do skip, para métrica/diagnóstico. */
  skipped?: string;
  /**
   * A sonda não é elegível (toggle off / RELEASE_INDEX off / sem interseção).
   * Cabe ao chamador do caminho do índice manter a rede de segurança com o
   * `br-gap` normal — desligar a sonda não pode perder o enqueue antigo.
   */
  fallbackBrGap: boolean;
};

// Lease curto do `pending`: crash/restart não deixa seeds bloqueados para
// sempre. Maior que os 60s com que a lista que só tem o aviso é cacheada, para
// o aviso nunca sobreviver ao lease.
const PENDING_LEASE_MS = 10 * 60_000;
// Retry curto de `failed`/`capped`: não martela a fila e libera os seeds.
const RETRY_MS = 5 * 60_000;

function normalize(workInput?: BrProbeWork | null): BrProbeWork | null {
  const imdbId = String(workInput?.imdbId || '');
  if (!/^tt\d+$/.test(imdbId)) return null;
  if (workInput?.type !== 'movie' && workInput?.type !== 'series') return null;
  return {
    type: workInput.type,
    imdbId,
    season: workInput.season ?? null,
    episode: workInput.episode ?? null,
  };
}

/** Identidade global por obra: filme sem S/E; série por episódio. */
export function probeIdentity(work: BrProbeWork): string {
  return `${work.type}:${work.imdbId}:${work.season ?? ''}:${work.episode ?? ''}`;
}

function probeKey(work: BrProbeWork): string {
  return `${prefix('autofetch')}probe:${crypto.createHash('sha256').update(probeIdentity(work)).digest('hex')}`;
}

/**
 * Interseção dirigida: index-only ∩ pt-BR, na ordem de `indexOnlyIndexers`.
 * Só esses reúnem as duas condições: não entram pela busca viva (index-only) e
 * recebem a query em português (pt-BR) — é onde mora o dublado titulado em PT.
 */
export function probeIndexers(): string[] {
  return config.jackett.indexOnlyIndexers.filter((id) => config.jackett.ptBrIndexers.includes(id));
}

/** Sonda operante: RELEASE_INDEX ativo, toggle ligado e interseção não vazia. */
export function probeEnabled(): boolean {
  return config.releaseIndex.enabled && autofetchLive.effective().autoFetchBrProbe && probeIndexers().length > 0;
}

function readRecord(work: BrProbeWork): BrProbeRecord | null {
  const raw = cache.peek(probeKey(work)) as BrProbeRecord | null;
  if (!raw || typeof raw.state !== 'string') return null;
  return raw;
}

function isPendingRecord(raw: BrProbeRecord | null, now = Date.now()): boolean {
  return Boolean(raw && raw.state === 'pending' && Number(raw.leaseUntil) > now);
}

/**
 * O que bloqueia o pool seeds: APENAS `pending` com lease vivo (a sonda está
 * procurando AGORA). `found` NÃO bloqueia — BR dublado já existe no índice, e
 * quem decide se baixar swarm para a mesma obra é a lista/índice na próxima
 * abertura, não um TTL de 12h que o usuário não vê. `empty` libera (não há BR),
 * `failed`/`capped` liberam (retry curto e fila de sementes segue). Toggle
 * desligado não bloqueia nada.
 */
export function probeBlocksSeeds(workInput: BrProbeWork): boolean {
  if (!probeEnabled()) return false;
  const work = normalize(workInput);
  if (!work) return false;
  return isPendingRecord(readRecord(work));
}

/**
 * Idade scheduled -> run da sonda: ms entre o `pending` gravado e a execução
 * atual. `null` quando não há registro (ex.: execução dirigida sem pending).
 * Usado pela métrica `autofetch.brProbe.runWaitMs`.
 */
export function probeRunWaitMs(workInput: BrProbeWork): number | null {
  const work = normalize(workInput);
  if (!work) return null;
  const raw = readRecord(work);
  if (!raw || !Number.isFinite(Number(raw.at))) return null;
  return Date.now() - Number(raw.at);
}

/** `pending` com lease vivo — bloqueio TRANSITÓRIO (o que a política F1 defere). */
export function isBrProbePending(workInput: BrProbeWork): boolean {
  if (!probeEnabled()) return false;
  const work = normalize(workInput);
  return Boolean(work && isPendingRecord(readRecord(work)));
}

/**
 * Estado da sonda para o diagnóstico (Fase 7): leitura QUIET, sem rede. `off`
 * cobre toggle desligado, sem interseção, obra inválida ou nenhum registro —
 * nunca inventa um estado. `pending` com lease vencido é órfão (crash/restart)
 * e sai como `failed` para o painel não mostrar busca ativa que não existe.
 */
export function probeState(workInput: BrProbeWork): BrProbeState | 'off' {
  if (!probeEnabled()) return 'off';
  const work = normalize(workInput);
  if (!work) return 'off';
  const raw = readRecord(work);
  if (!raw) return 'off';
  if (raw.state === 'pending' && !isPendingRecord(raw)) return 'failed';
  return raw.state;
}

function writeRecord(work: BrProbeWork, record: BrProbeRecord): void {
  cache.set(probeKey(work), record, config.debrid.brProbeTtl);
}

function writePending(work: BrProbeWork): void {
  const now = Date.now();
  writeRecord(work, { state: 'pending', at: now, leaseUntil: now + PENDING_LEASE_MS });
}

function ineligibilityReason(): string {
  if (!config.releaseIndex.enabled) return 'release-index-off';
  if (!autofetchLive.effective().autoFetchBrProbe) return 'disabled';
  return 'no-intersection';
}

/**
 * Solicita a sonda de uma obra. Nunca lança e nunca bloqueia — é chamada de
 * dentro da seleção do Chupim e do caminho do índice.
 *
 * Só grava `pending` SINCRONAMENTE quando existe trabalho realmente aceito:
 * a entrada aparece na fila com a flag `brProbe` (o worker vai executar o modo
 * dirigido). Dedupe/promoção são dos gates da fila (Fase 5): uma obra já na
 * fila aceita a flag sem rebaixar o motivo mais forte; um pedido recente
 * (dedupe de 12h) não é reenfileirado e a sonda é skipped — e nesse caso NÃO
 * bloqueia seeds, porque o worker não vai executar o probe.
 */
export function requestBrProbe(
  workInput: BrProbeWork,
  opts: { mode?: 'upgrade' | 'evidence' } = {},
): RequestBrProbeResult {
  const work = normalize(workInput);
  if (!work) {
    metrics.count('autofetch.brProbe.skipped.invalid');
    return { probe: false, pending: false, skipped: 'invalid', fallbackBrGap: false };
  }
  if (!probeEnabled()) {
    const reason = ineligibilityReason();
    metrics.count(`autofetch.brProbe.skipped.${reason}`);
    return { probe: false, pending: false, skipped: reason, fallbackBrGap: true };
  }

  const now = Date.now();
  const raw = readRecord(work);
  if (raw?.state === 'pending' && !isPendingRecord(raw, now)) {
    // Lease órfão (crash/restart deixou `pending` sem worker): não bloqueia mais
    // e a próxima solicitação reagenda. Métrica própria para o diagnóstico não
    // confundir órfão com sonda ativa.
    metrics.count('autofetch.brProbe.orphan');
  }
  if (isPendingRecord(raw, now)) {
    metrics.count('autofetch.brProbe.skipped.pending');
    return { probe: true, pending: true, skipped: 'pending', fallbackBrGap: false };
  }
  if (raw?.state === 'found' || raw?.state === 'empty') {
    // found: BR já provado (dedupe de 12h; NÃO bloqueia seeds). empty: sonda
    // completou sem BR há pouco — o dedupe evita re-sondar, mas seeds liberam.
    metrics.count(`autofetch.brProbe.skipped.${raw.state}`);
    return { probe: false, pending: false, skipped: raw.state, fallbackBrGap: false };
  }
  if ((raw?.state === 'failed' || raw?.state === 'capped') && now - raw.at < RETRY_MS) {
    metrics.count('autofetch.brProbe.skipped.retry');
    return { probe: false, pending: false, skipped: 'retry', fallbackBrGap: false };
  }

  // Coalescing GENÉRICO (item aberto 8): `enqueue` já funde a intenção na obra
  // EM VOO (mesma identidade) quando ela está sendo colhida agora. A sonda é só
  // mais um motivo na mesma esteira — antes havia um caminho próprio
  // (`attachProbe`) que não cobria enqueues comuns, e a obra era raspada duas
  // vezes. A identidade do `enqueue` é a MESMA do colhedor (`obraIdentity`, sem
  // o tipo); incluir o tipo aqui nunca casaria com a obra em voo.
  const identity = harvestQueue.obraIdentity({ imdbId: work.imdbId, season: work.season, episode: work.episode });
  const outcome = harvestQueue.enqueue({
    type: work.type,
    imdbId: work.imdbId,
    season: work.season,
    episode: work.episode,
    reason: 'br-gap',
    brProbe: true,
  });
  if (outcome.reason === 'coalesced') {
    // A execução corrente cobre a sonda (run dirigido ou colheita completa com
    // a flag anexada); o tick finaliza o estado pelo resultado.
    writePending(work);
    metrics.count('autofetch.brProbe.coalesced');
    metrics.count(`autofetch.brProbe.scheduled.${opts.mode || 'evidence'}`);
    log.debug(`[br-probe] ${identity}: colheita em voo, intenção anexada`);
    return { probe: true, pending: true, skipped: 'inflight', fallbackBrGap: false };
  }
  const queued = harvestQueue.findQueued(work);
  if (!queued?.brProbe) {
    metrics.count(`autofetch.brProbe.skipped.${outcome.reason}`);
    return { probe: false, pending: false, skipped: outcome.reason, fallbackBrGap: false };
  }
  writePending(work);
  metrics.count('autofetch.brProbe.scheduled');
  // Razão do agendamento (upgrade × evidência BR): separa o diagnóstico sem
  // inflar contadores — a decisão de plausibilidade mora nos call sites.
  metrics.count(`autofetch.brProbe.scheduled.${opts.mode || 'evidence'}`);
  log.info(`[br-probe] sonda dirigida agendada: ${identity} (${probeIndexers().join(',')})`);
  return { probe: true, pending: true, fallbackBrGap: false };
}

/**
 * Estado final da sonda, chamado pelo colhedor ao consumir a entrada dirigida.
 * Sempre invalida as listas prontas da obra — inclusive em `empty`/`failed`/
 * `capped` — para o aviso de `pending` não congelar no cache.
 */
export function finalizeBrProbe(workInput: BrProbeWork, state: Exclude<BrProbeState, 'pending'>): void {
  const work = normalize(workInput);
  if (!work) return;
  writeRecord(work, { state, at: Date.now() });
  const cleared = invalidateStreamsForObra(work.imdbId);
  metrics.count(`autofetch.brProbe.${state}`);
  if (cleared > 0) metrics.count('autofetch.brProbe.invalidated', cleared);
  log.debug(`[br-probe] ${probeIdentity(work)} -> ${state} (${cleared} lista(s) invalidada(s))`);
}

/**
 * Preempção por tráfego: a obra volta à fila e será recolhida. Não finaliza —
 * renova o lease para o aviso/bloqueio não caírem no meio de um retry legítimo.
 */
export function noteBrProbePreempted(workInput: BrProbeWork): void {
  const work = normalize(workInput);
  if (!work) return;
  metrics.count('autofetch.brProbe.preempted');
  writePending(work);
}

/** Limpeza pontual (teste/painel): esquece o estado da obra. */
export function clearBrProbe(workInput: BrProbeWork): void {
  const work = normalize(workInput);
  if (!work) return;
  cache.forget(probeKey(work));
}

/**
 * Helper LIMITADO de teste: grava um registro cru. A chave é derivada da
 * identidade pública; nenhum caminho de produção usa isto.
 */
export function __setBrProbeRecordForTest(workInput: BrProbeWork, record: BrProbeRecord): void {
  const work = normalize(workInput);
  if (!work) return;
  writeRecord(work, record);
}

/** Helper LIMITADO de teste: estado bruto (sem mascarar lease/retry). */
export function __probeStateForTest(workInput: BrProbeWork): BrProbeState | null {
  const work = normalize(workInput);
  return work ? (readRecord(work)?.state ?? null) : null;
}
