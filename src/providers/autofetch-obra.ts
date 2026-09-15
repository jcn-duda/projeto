// Teto por OBRA do Chupim (Fase 2) — teto persistido + reserva transacional.
//
// O problema que este módulo fecha: hoje cada busca decide sozinha quantos
// downloads disparar (vaga por busca + portões). Buscas repetidas da MESMA obra
// (Stremio pergunta de novo, passe tardio, outro episódio/pack) não enxergam o
// que a anterior já aceitou, então o Chupim reenfileira a mesma obra e enche a
// conta com o mesmo conteúdo. Aqui a vaga é contada por OBRA numa JANELA
// DESLIZANTE (`autoFetchTtl`), compartilhada entre buscas e entre o caminho
// imediato e o dreno da fila.
//
// Três peças, nesta ordem de vida:
//
// 1. RESERVA (volátil): `reserveObra` faz a checagem e a tomada da vaga no
//    MESMO passo síncrono, antes de qualquer `await`. É o que impede duas
//    buscas concorrentes de ultrapassarem o teto: a segunda enxerga a reserva
//    da primeira. A reserva tem lease CURTO — expira sozinha (lazy, sem timer)
//    se o enqueue nunca resolver; nada de reserva pendurada.
// 2. COMMIT (durável): só em `enqueue ok=true`. Aí o hash vira entrada do
//    registro persistido da obra. Reserva recusada NÃO é persistida.
// 3. RELEASE: enqueue false/erro, portão posterior (account-gate/budget),
//    requeue do dreno, cooldown. A vaga volta a existir.
//
// Pools são contadores SEPARADOS: `seeds` nunca consome vaga de `br`.
//
// O registro persistido guarda o mínimo para futuras leituras (F6): por hash o
// pool, o instante do aceite, o título, a classificação br/dubbed e o id
// quando o adapter devolve. NÃO há eviction — quem apaga é o TTL da janela.
// A leitura é defensiva: formato estranho conta como registro vazio, nunca
// derruba a busca.
//
// READY × MORTO/PARADO (contrato explícito):
// - READY continua contando pela JANELA: um download que ficou pronto segue
//   ocupando a vaga até o `autoFetchTtl` vencer — o teto é por obra na janela
//   deslizante, não por "o que está em voo agora".
// - MORTO/PARADO libera a vaga na hora: o recheck remove o hash terminal com
//   `forgetObraHash` ANTES de tentar o dreno, então a reposição SAME POOL volta
//   a caber sem depender de eviction (F6). "Terminal" é só o estado provado
//   (dead/stalled) — false/erro do enqueue apenas liberam a reserva, e o
//   expirado do settle confia no TTL (o registro vence junto com a janela).
// - `forgetObraHash` apaga SÓ o hash pedido, preservando outros hashes e pools
//   do mesmo registro; registro que esvazia tem a chave esquecida.

import crypto from 'node:crypto';
import { prefix } from '../utils/cache-keys.js';
import * as cache from '../utils/cache.js';
import autofetchLive from '../utils/autofetch-live.js';
import * as metrics from '../utils/metrics.js';
import { overflowUpgradeAllowed } from './autofetch-obra-overflow.js';

const OBRA_PREFIX = `${prefix('autofetch')}o:`;

// Lease curto da reserva: o suficiente para cobrir a chamada de enqueue. Não há
// timer — a expiração é lida de `at` a cada consulta, o que mantém o módulo
// determinístico (sem setTimeout) e imune a `mock.timers` dos testes.
export const OBRA_LEASE_TTL_MS = 60_000;

/** Entrada persistida por hash aceito (mínimo do F6). */
export interface ObraEntry {
  hash: string;
  pool: string;
  acceptedAt: number;
  title?: string;
  br?: boolean;
  dubbed?: boolean;
  id?: string;
  /**
   * Faixa de qualidade do aceite (persistida para o overflow de upgrade — C11).
   * Ausente em entrada antiga: o overflow degrada para conservador (não prova
   * superioridade) e nunca é concedido.
   */
  quality?: string;
  /** Marcada quando a vaga foi uma reserva EXTRA de upgrade (cap+1). */
  overflow?: boolean;
}

export interface ObraIdentityInput {
  adapterId: string;
  account: string;
  /** Tipo canônico (`movie`/`series`); ausente é inferido pela presença de season. */
  type?: string | null;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  /**
   * Pack de temporada: o episódio é normalizado para vazio, então packs da
   * MESMA temporada (mesmo anunciados em buscas de E01/E02) dividem a vaga;
   * episódios avulsos continuam separados por `episode`.
   */
  isPack?: boolean;
  searchKey?: string | null;
}

export interface ObraReserveInput extends ObraIdentityInput {
  pool: string;
  hash?: string;
  /** Candidato seeds do regime raro (slotLimit correspondente): sobe o teto. */
  rare?: boolean;
  slotLimit?: number;
  /** Faixa de qualidade do candidato (para o overflow de upgrade — C11). */
  quality?: string;
}

/** Reserva concedida. `key` vazio = sem identidade utilizável (teto não se aplica). */
export interface ObraLease {
  id: string;
  key: string;
  pool: string;
  hash: string;
  rare: boolean;
  /** A vaga veio da reserva EXTRA de upgrade (cap+1). */
  overflow?: boolean;
}

type Pending = { id: string; pool: string; rare: boolean; at: number; hash: string; quality?: string; overflow?: boolean };
const pending = new Map<string, Pending[]>();
let sequence = 0;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function inferType(type: string | null | undefined, season: number | null | undefined): 'movie' | 'series' {
  const explicit = String(type || '').toLowerCase();
  if (explicit === 'series' || explicit === 'movie') return explicit;
  // O fluxo de busca não carrega `type`; a presença de temporada é a evidência
  // que sobra. Filme tem season nulo.
  return season != null && Number.isFinite(Number(season)) ? 'series' : 'movie';
}

function segment(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '';
  return String(Math.trunc(Number(value)));
}

/**
 * Identidade estável da obra: `adapterId:accountScope:type:imdbId:season:episode`.
 * Sem imdbId válido cai no digest do searchKey — LIMITAÇÃO DOCUMENTADA: dois
 * fluxos com o mesmo searchKey compartilham o teto; searchKeys distintos (ex.:
 * passe tardio com outra chave) não compartilham. Sem imdbId E sem searchKey
 * não há identidade: o teto não se aplica (fail-open, como o gate de conta frio).
 */
export function obraIdentity(input: ObraIdentityInput): string {
  const type = inferType(input.type, input.season);
  const base = `${input.adapterId || ''}:${input.account || ''}:${type}`;
  const imdbId = String(input.imdbId || '');
  if (/^tt\d+$/.test(imdbId)) {
    // Pack de temporada não é "o episódio E02": a identidade vira a temporada.
    const episodeSeg = input.isPack ? '' : segment(input.episode);
    return `${base}:${imdbId}:${segment(input.season)}:${episodeSeg}`;
  }
  return `${base}:sk:${sha256(String(input.searchKey || ''))}`;
}

/** Chave de cache do registro da obra (`autofetch:v3:o:<sha256>`). */
export function obraKey(input: ObraIdentityInput): string {
  return `${OBRA_PREFIX}${sha256(obraIdentity(input))}`;
}

/** Teto da vaga por pool. `br` acompanha a vaga por busca; `any` é 1; `seeds`
 *  sobe no regime raro; pool desconhecido é conservador (1). */
function poolCap(pool: string, rare: boolean, live: ReturnType<typeof autofetchLive.effective>): number {
  if (pool === 'br') return Math.max(1, Math.trunc(Number(live.autoFetchMax) || 1));
  if (pool === 'seeds') {
    const cap = rare ? live.autoFetchRareMax : live.autoFetchTopSeedsMax;
    return Math.max(1, Math.trunc(Number(cap) || 1));
  }
  return 1;
}

function seedsRare(input: ObraReserveInput, live: ReturnType<typeof autofetchLive.effective>): boolean {
  if (input.pool !== 'seeds') return false;
  if (input.rare === true) return true;
  const rareMax = Math.trunc(Number(live.autoFetchRareMax) || 0);
  const topMax = Math.trunc(Number(live.autoFetchTopSeedsMax) || 0);
  // O seletor marca `rare` e eleva `slotLimit` para rareMax; aceitar o slot
  // correspondente cobre o caminho do dreno, que não carrega o booleano.
  return rareMax > topMax && input.slotLimit != null && Number(input.slotLimit) >= rareMax;
}

function windowMs(live: ReturnType<typeof autofetchLive.effective>): number {
  return Math.max(0, Number(live.autoFetchTtl) || 0) * 1000;
}

/** Leitura defensiva do registro persistido: formato estranho = vazio. */
function readRecord(key: string): ObraEntry[] {
  if (!key) return [];
  const raw = cache.get(key) as { entries?: unknown } | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.entries)) return [];
  const out: ObraEntry[] = [];
  for (const item of raw.entries) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const hash = String(e.hash || '').toLowerCase();
    if (!hash) continue;
    out.push({
      hash,
      pool: String(e.pool || ''),
      acceptedAt: Number.isFinite(Number(e.acceptedAt)) ? Number(e.acceptedAt) : 0,
      ...(e.title != null ? { title: String(e.title) } : {}),
      br: e.br === true,
      dubbed: e.dubbed === true,
      ...(e.id != null && e.id !== '' ? { id: String(e.id) } : {}),
      ...(e.quality != null && e.quality !== '' ? { quality: String(e.quality) } : {}),
      ...(e.overflow === true ? { overflow: true } : {}),
    });
  }
  return out;
}

/** Reservas vivas da obra, podando as vencidas de passagem. */
function pendingFor(key: string, now: number): Pending[] {
  const list = pending.get(key);
  if (!list || list.length === 0) return [];
  const alive = list.filter((p) => p.at + OBRA_LEASE_TTL_MS > now);
  if (alive.length === list.length) return alive;
  if (alive.length > 0) pending.set(key, alive);
  else pending.delete(key);
  return alive;
}

/** Entradas persistidas ainda dentro da janela (descartadas: vencidas). */
function windowedRecord(key: string, now: number, span: number): ObraEntry[] {
  if (span <= 0) return [];
  return readRecord(key).filter((e) => e.acceptedAt > now - span);
}

/** Contagem por pool = persistido na janela + reservas vivas. */
function countsFrom(entries: ObraEntry[], alive: Pending[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.pool] = (counts[entry.pool] || 0) + 1;
  for (const heldVaga of alive) counts[heldVaga.pool] = (counts[heldVaga.pool] || 0) + 1;
  return counts;
}

/**
 * Registro + reservas vivas como `ObraEntry`, para a decisão de overflow. Sem
 * as PENDING, uma faixa-alvo recém-reservada (ainda não commitada) não aparecia
 * e um segundo hash da MESMA faixa ganhava o slot cap+1 — reserva viva é vaga
 * ocupada, com a qualidade dela.
 */
function combinedView(entries: ObraEntry[], alive: Pending[]): ObraEntry[] {
  const heldEntries: ObraEntry[] = alive.map((p) => ({
    hash: p.hash,
    pool: p.pool,
    acceptedAt: p.at,
    ...(p.quality ? { quality: p.quality } : {}),
    ...(p.overflow ? { overflow: true } : {}),
  }));
  return [...entries, ...heldEntries];
}

function noCapLease(pool: string, hash: string, rare: boolean): ObraLease {
  return { id: '', key: '', pool, hash, rare };
}

/**
 * Reserva a vaga da obra de forma SÍNCRONA. `null` = teto do pool fechado
 * nesta janela (o chamador desiste e libera o que já adquiriu). A reserva não
 * é persistida: só o `commitObra` grava.
 */
export function reserveObra(input: ObraReserveInput): ObraLease | null {
  const pool = String(input.pool || '');
  const hash = String(input.hash || '').toLowerCase();
  const live = autofetchLive.effective();
  const rare = seedsRare(input, live);
  const validImdb = /^tt\d+$/.test(String(input.imdbId || ''));
  if (!input.adapterId || !input.account || (!validImdb && !input.searchKey)) {
    return noCapLease(pool, hash, rare);
  }

  const key = obraKey(input);
  const now = Date.now();
  const span = windowMs(live);
  const alive = pendingFor(key, now);
  const record = windowedRecord(key, now, span);
  const counts = countsFrom(record, alive);
  const cap = poolCap(pool, rare, live);
  const current = counts[pool] || 0;
  let overflow = false;
  if (current >= cap) {
    // Só o cap EXATO abre a reserva extra (cap+1): acima disso a janela já
    // consumiu o overflow. A decisão vê registro + reservas PENDING vivas, com
    // a qualidade delas — sem isso uma faixa-alvo recém-reservada não bloqueava
    // a duplicata ainda-não-commitada.
    if (current !== cap || !overflowUpgradeAllowed(combinedView(record, alive), input)) {
      metrics.count('autofetch.obra.cap-blocked');
      return null;
    }
    overflow = true;
    metrics.count('autofetch.obra.overflow-upgrade');
  }

  sequence += 1;
  const lease: ObraLease = { id: `${now}:${sequence}`, key, pool, hash, rare, ...(overflow ? { overflow: true } : {}) };
  const list = pending.get(key) || [];
  list.push({ id: lease.id, pool, rare, at: now, hash, ...(input.quality ? { quality: String(input.quality) } : {}), ...(overflow ? { overflow: true } : {}) });
  pending.set(key, list);
  metrics.count('autofetch.obra.reserved');
  return lease;
}

function removePending(lease: ObraLease): boolean {
  const list = pending.get(lease.key);
  if (!list) return false;
  const kept = list.filter((p) => p.id !== lease.id);
  if (kept.length === list.length) return false;
  if (kept.length > 0) pending.set(lease.key, kept);
  else pending.delete(lease.key);
  return true;
}

/** Devolve a vaga de uma reserva não aceita (false/erro/portão/requeue/aborto). */
export function releaseObra(lease: ObraLease | null | undefined): void {
  if (!lease || !lease.key) return;
  if (removePending(lease)) metrics.count('autofetch.obra.released');
}

/**
 * Confirma o aceite: sai da reserva e vira entrada durável da obra. Dedupe por
 * hash (o mesmo hash aceito duas vezes não conta dobrado). O TTL do registro é
 * a janela; entradas antigas são descartadas na leitura/gravação, então a
 * janela é deslizante POR HASH, não um balde que renova tudo.
 */
export function commitObra(
  lease: ObraLease | null | undefined,
  entry: { hash: string; pool: string; title?: string; br?: boolean; dubbed?: boolean; id?: string; quality?: string; overflow?: boolean },
): void {
  if (!lease || !lease.key) return;
  removePending(lease);
  const hash = String(entry.hash || lease.hash || '').toLowerCase();
  if (!hash) return;

  const live = autofetchLive.effective();
  const now = Date.now();
  const span = windowMs(live);
  const kept = readRecord(lease.key).filter((e) => {
    if (e.hash === hash) return false;
    if (span <= 0) return false;
    return e.acceptedAt > now - span;
  });
  kept.push({
    hash,
    pool: String(entry.pool || lease.pool || ''),
    acceptedAt: now,
    ...(entry.title ? { title: entry.title } : {}),
    br: entry.br === true,
    dubbed: entry.dubbed === true,
    ...(entry.id ? { id: entry.id } : {}),
    ...(entry.quality ? { quality: String(entry.quality) } : {}),
    ...((entry.overflow ?? lease.overflow) === true ? { overflow: true } : {}),
  });
  cache.set(lease.key, { entries: kept }, Math.max(1, Math.trunc(Number(live.autoFetchTtl) || 0)));
  metrics.count('autofetch.obra.committed');
}

/** Registro persistido da obra (testes/diagnóstico). Não expõe chave nem conta. */
export function obraRecord(input: ObraIdentityInput): ObraEntry[] {
  return readRecord(obraKey(input));
}

/**
 * Remove um hash TERMINAL (morto/parado) do registro da obra, liberando a vaga
 * na hora. Apaga SÓ o hash pedido: outros hashes e pools do mesmo registro
 * ficam intactos; se o registro esvaziar, a chave é esquecida (sem lixo).
 * Devolve `true` quando algo saiu. Nunca lança e nunca toca outra obra.
 */
export function forgetObraHash(input: ObraIdentityInput & { hash: string }): boolean {
  const key = obraKey(input);
  const hash = String(input.hash || '').toLowerCase();
  if (!key || !hash) return false;
  const before = readRecord(key);
  const kept = before.filter((e) => e.hash !== hash);
  if (kept.length === before.length) return false;
  const live = autofetchLive.effective();
  if (kept.length > 0) {
    cache.set(key, { entries: kept }, Math.max(1, Math.trunc(Number(live.autoFetchTtl) || 0)));
  } else {
    cache.forget(key);
  }
  metrics.count('autofetch.obra.forgotten');
  return true;
}

/** Estado volátil do módulo para o diagnóstico; nunca inclui identidade crua. */
export function obraStatus() {
  const now = Date.now();
  let reserved = 0;
  for (const key of [...pending.keys()]) reserved += pendingFor(key, now).length;
  return { works: pending.size, reserved, leaseTtlMs: OBRA_LEASE_TTL_MS };
}

/**
 * Limpa SÓ o estado volátil (reservas) — simula o restart do processo. O
 * registro persistido vive no cache e sobrevive de propósito: é o teste de que
 * o teto por obra atravessa o restart.
 */
export function resetObraForTest(): void {
  pending.clear();
  sequence = 0;
}
