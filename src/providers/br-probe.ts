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
// com o Jackett: PEDE a entrada `br-gap` (com a flag `brProbe`) ao colhedor
// NATIVO do gateway (`POST /harvest/enqueue`) e o worker de lá executa o modo
// dirigido. Assim não há um segundo worker Jackett, e o orçamento/atividade/
// breaker do colhedor valem integralmente. A fila local (`harvest:v1:q`) e o
// dedupe de 12h deixaram de ser do Node na Fase 5.
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
import { enqueueNativeHarvest, pendingNativeHarvest } from '../utils/harvest-native.js';

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
// A confirmação do enfileiramento sai um tique depois do POST: a ponte manda o
// pedido fire-and-forget e o GET do `pending` é outro socket — sem essa folga o
// gateway podia responder "não está na fila" antes de processar o POST.
const CONFIRM_DELAY_MS = 250;

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
  const exempt = new Set(config.jackett.liveExemptIndexers);
  return config.jackett.indexOnlyIndexers.filter((id) => config.jackett.ptBrIndexers.includes(id) && !exempt.has(id));
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
 * Confirma no gateway que a obra entrou na fila COMO SONDA. Best-effort: a
 * ponte não devolve o resultado do POST (`enqueueNativeHarvest` é
 * fire-and-forget, para o efeito da busca nunca esperar rede), então a leitura
 * do `pending` vem depois — e só ela pode DESFAZER o lease local.
 *
 * Sem resposta (`null`: ponte em backoff/timeout) o `pending` FICA: "não sei"
 * nunca vira "não está na fila" — bloquear sementes por dez minutos é mais
 * barato que baixar swarm na frente de um dublado que estava sendo procurado.
 */
function confirmNativeProbe(work: BrProbeWork): void {
  const timer = setTimeout(() => {
    void pendingNativeHarvest(work.imdbId).then((state) => {
      if (!state) {
        metrics.count('autofetch.brProbe.unconfirmed');
        return;
      }
      const scheduled = state.queued && state.brProbe;
      metrics.count(scheduled ? 'autofetch.brProbe.confirmed' : 'autofetch.brProbe.unconfirmed');
      if (scheduled) return;
      // O gateway respondeu que a obra não está na fila como sonda (dedupe de
      // 12h, kill-switch ou pedido perdido). Solta o lease para não segurar
      // sementes por uma sonda que não vai rodar; `failed` entra no retry
      // curto de 5 min.
      writeRecord(work, { state: 'failed', at: Date.now() });
      log.debug(`[br-probe] ${probeIdentity(work)}: gateway não confirmou a sonda`);
    });
  }, CONFIRM_DELAY_MS);
  // Confirmação de estado, não trabalho pendente: não segura o processo.
  if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref?.();
}

/**
 * Solicita a sonda de uma obra. Nunca lança e nunca bloqueia — é chamada de
 * dentro da seleção do Chupim e do caminho do índice.
 *
 * Só grava `pending` quando o pedido REALMENTE saiu para o gateway: o lease é
 * o que segura o pool de sementes enquanto a sonda procura. Dedupe/promoção/
 * coalescing são do colhedor nativo (Fase 5) — uma obra já na fila aceita a
 * flag sem rebaixar o motivo mais forte; um pedido recente (dedupe de 12h) não
 * é reenfileirado, e a confirmação do `pending` solta o lease nesse caso.
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

  // O enfileiramento é do GATEWAY (fila, prioridade e dedupe de 12h dele).
  // `false` = o pedido nem saiu (ponte em backoff ou IMDb fora do contrato):
  // sem fila, nada bloqueia sementes.
  const requested = enqueueNativeHarvest({
    type: work.type,
    imdbId: work.imdbId,
    reason: 'br-gap',
    brProbe: true,
    ...(work.season != null ? { season: work.season } : {}),
    ...(work.episode != null ? { episode: work.episode } : {}),
  });
  if (!requested) {
    metrics.count('autofetch.brProbe.skipped.bridge');
    return { probe: false, pending: false, skipped: 'bridge', fallbackBrGap: false };
  }
  writePending(work);
  metrics.count('autofetch.brProbe.scheduled');
  // Razão do agendamento (upgrade × evidência BR): separa o diagnóstico sem
  // inflar contadores — a decisão de plausibilidade mora nos call sites.
  metrics.count(`autofetch.brProbe.scheduled.${opts.mode || 'evidence'}`);
  log.info(`[br-probe] sonda dirigida agendada: ${probeIdentity(work)} (${probeIndexers().join(',')})`);
  confirmNativeProbe(work);
  return { probe: true, pending: true, fallbackBrGap: false };
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
