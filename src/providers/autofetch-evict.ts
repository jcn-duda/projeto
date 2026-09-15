// Evicção dirigida dos fallbacks da MESMA obra (Fase 6 do Chupim 2.0) —
// política e orquestração.
//
// Quando um BR dublado aceito pelo Chupim fica `ready`, os `any`/`seeds` que o
// próprio Chupim baixou para a mesma obra passam a ser redundantes. Esta fase
// os remove da conta AllDebrid — opcional, AllDebrid-only e DESTRUTIVA, então
// nasce OFF: com o knob desligado o módulo retorna antes de qualquer leitura.
//
// Quem decide é este módulo; quem executa a parte destrutiva é o método
// opcional `adapter.evictFallbacks` (gate global de delete encapsulado). As
// travas de política, todas em CONJUNÇÃO (qualquer ausência PULA, nada é
// removido por omissão):
//
//   1. o BR ready precisa estar no registro F2 da obra como pool `br` e
//      `dubbed` — ready sem prova é no-op;
//   2. o fallback precisa estar no MESMO registro da obra com pool `any`/`seeds`
//      (o BR ready atual e o pool `br` nunca entram) e NÃO pode ser reserva de
//      `overflow` do C11 — essa é a vaga extra de upgrade (faixa-alvo ausente e
//      superior ao pior BR) e removê-la reverteria o corretivo;
//   3. marker do Chupim em formato NOVO (`obra` = digest da identidade) que case
//      a obra — marker legado `1`/`{id}` é inelegível;
//   4. posse durável `adsub:v1` presente (a autoridade do 8.15, criada só com
//      prova de ausência no snapshot);
//   5. nem `held` volátil nem `adprot` durável;
//   6. idade mínima desde o `acceptedAt` do registro F2 (sem data, pulo);
//   7. `id`/`filename`/status autoritativos e filename sem sinal BR — a última
//      milha, dentro do executor AllDebrid.
//
// Coalescing por `adapter:account:obra`: dois BR ready da mesma obra não rodam
// duas passagens em paralelo sobre os mesmos fallbacks. Fire-and-forget: nunca
// bloqueia a finalização do lote do recheck; erro só vira log/métrica.

import config from '../config.js';
import * as cache from '../utils/cache.js';
import { prefix } from '../utils/cache-keys.js';
import autofetchLive from '../utils/autofetch-live.js';
import * as held from '../debrid/protected.js';
import * as metrics from '../utils/metrics.js';
import * as log from '../utils/logger.js';
import type { DebridAdapter } from '../../types/domain.js';
import { markerKey, markerObra, type MarkerMeta } from './autofetch-marker.js';
import { obraRecord, forgetObraHash, obraDigest, type ObraIdentityInput } from './autofetch-obra.js';
import { hasDurableOwnership } from '../debrid/alldebrid-inventory.js';

/** Identidade de obra que o lote do recheck guarda por hash (subset do hint). */
export type EvictHint = {
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  isPack?: boolean;
};

export interface EvictFallbackInput {
  adapter: DebridAdapter;
  account: string;
  apiKey: string;
  /** Hash do BR ready que dispara a evicção. */
  hash: string;
  hint?: EvictHint | null;
  /** Injeção de tempo para teste; produção usa `Date.now()`. */
  now?: number;
}

const inFlight = new Map<string, Promise<void>>();

// Prova de que o BR da OBRA ficou READY de verdade — do EVENTO, nunca do
// "aceito" no registro. Sem segredo: digest da identidade (já embute
// adapter+conta), TTL da janela do autofetch. É escrita SÓ com o knob ON; OFF
// segue zero escrita/rede da F6. É o que permite reavaliar um fallback que fica
// pronto DEPOIS do BR (o hold dele ainda estava vivo no primeiro ready).
const brReadyPrefix = `${prefix('autofetch')}er:`;

function noteBrReady(digest: string): void {
  const ttl = Math.max(1, Math.trunc(Number(autofetchLive.effective().autoFetchTtl) || 0));
  cache.set(`${brReadyPrefix}${digest}`, { at: Date.now() }, ttl);
  metrics.count('autofetch.evict.brReady');
}

function hasBrReady(digest: string): boolean {
  return cache.peek(`${brReadyPrefix}${digest}`) != null;
}

/** Pulos elegíveis SOMENTE no AllDebrid e com o adapter implementando o método. */
function evictable(adapter: DebridAdapter | null | undefined): adapter is DebridAdapter {
  return Boolean(
    adapter &&
      adapter.id === 'alldebrid' &&
      typeof adapter.evictFallbacks === 'function',
  );
}

/**
 * Metadado do marker NOVO para o Chupim. `undefined` preserva o marker legado
 * (`1`/`{id}`) — só o AllDebrid com imdbId válido entra, porque é o único que a
 * evicção (Fase 6) consome. A identidade vira DIGEST, nunca imdbId cru.
 */
export function evictMarkerMeta(input: {
  adapterId: string;
  account: string;
  imdbId?: string | null;
  season?: number | null;
  episode?: number | null;
  isPack?: boolean;
  pool?: string;
  title?: string;
  br?: boolean;
  dubbed?: boolean;
}): MarkerMeta | undefined {
  if (input.adapterId !== 'alldebrid') return undefined;
  const imdbId = String(input.imdbId || '');
  if (!/^tt\d+$/.test(imdbId)) return undefined;
  return {
    pool: String(input.pool || ''),
    obra: obraDigest({
      adapterId: input.adapterId,
      account: input.account,
      imdbId,
      season: input.season ?? null,
      episode: input.isPack === true ? null : (input.episode ?? null),
      isPack: input.isPack === true,
    }),
    acceptedAt: Date.now(),
    ...(input.title ? { title: input.title } : {}),
    br: input.br === true,
    dubbed: input.dubbed === true,
  };
}

function identityFor(account: string, hint: EvictHint): ObraIdentityInput {
  return {
    adapterId: 'alldebrid',
    account,
    imdbId: hint.imdbId ?? null,
    season: hint.season ?? null,
    episode: hint.isPack === true ? null : (hint.episode ?? null),
    isPack: hint.isPack === true,
  };
}

/** Coalescing por adapter:account:obra; a segunda chamada em voo é um no-op. */
function runCoalesced(key: string, task: () => Promise<void>): Promise<void> {
  const existing = inFlight.get(key);
  if (existing) {
    metrics.count('autofetch.evict.coalesced');
    return existing;
  }
  const p = task()
    .catch((err: unknown) => {
      metrics.count('autofetch.evict.error');
      log.warn('[autofetch] evict de fallbacks falhou:', log.errorMessage(err));
    })
    .finally(() => {
      if (inFlight.get(key) === p) inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

/**
 * Ponto de entrada do recheck no ramo `ready`. Nunca lança e nunca bloqueia:
 * devolve a promessa do trabalho em voo (os testes aguardam; produção ignora).
 */
export function maybeEvictFallbacks(input: EvictFallbackInput): Promise<void> {
  const noop = Promise.resolve();
  if (!config.debrid.autoFetchEvictFallback) return noop;
  const adapter = input.adapter;
  if (!evictable(adapter)) return noop;

  const hash = String(input.hash || '').toLowerCase();
  const hint = input.hint;
  if (!hash || !hint || !/^tt\d+$/.test(String(hint.imdbId || ''))) {
    metrics.count('autofetch.evict.skipped.no-hint');
    return noop;
  }
  const account = String(input.account || '');
  if (!account) return noop;

  const identity = identityFor(account, hint);
  const digest = obraDigest(identity);
  const record = obraRecord(identity);
  const ready = record.find((e) => e.hash === hash);
  // A prova "BR ready" nasce do EVENTO ready: só o hash ready comprovadamente
  // pool br+dubbed a grava (não confia em "está ready" nem em "foi aceito").
  const readyIsBr = Boolean(ready && ready.pool === 'br' && ready.dubbed === true);
  if (readyIsBr) noteBrReady(digest);
  // Gatilho válido: o ready ATUAL é o BR, ou a obra já provou BR ready antes —
  // aí o fallback que fica pronto depois reavalia (o hold dele já saiu, porque
  // o recheck só chama isto após liberar o hold do próprio ready).
  if (!readyIsBr && !hasBrReady(digest)) {
    metrics.count('autofetch.evict.skipped.ready-not-br');
    return noop;
  }

  const minAge = Math.max(0, Number(config.debrid.autoFetchEvictFallbackMinAgeMs) || 0);
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const eligible: string[] = [];

  for (const entry of record) {
    if (entry.pool !== 'any' && entry.pool !== 'seeds') continue;
    // O hash ready atual NÃO é excluído de propósito: quando ele é qualquer
    // coisa que não `br` (fallback que ficou pronto), ele mesmo é candidato —
    // o recheck já liberou o hold dele antes desta chamada. O pool `br` nunca
    // entra por causa do filtro acima.
    // C11: a vaga de OVERFLOW é reserva deliberada de upgrade (faixa-alvo
    // ausente entre os BR e superior ao pior BR registrado). Não há prova de
    // que o BR ready cobre aquela faixa; removê-la reverteria o corretivo.
    // Fail-safe: overflow nunca é evictado.
    if (entry.overflow === true) {
      metrics.count('autofetch.evict.skipped.overflow');
      continue;
    }
    // Marker novo compatível: exige digest da MESMA obra. Legado (`1`/`{id}`)
    // não tem `obra` e é inelegível por contrato.
    if (markerObra(adapter.id, account, entry.hash) !== digest) {
      metrics.count('autofetch.evict.skipped.marker-missing');
      continue;
    }
    if (!hasDurableOwnership(account, entry.hash)) {
      metrics.count('autofetch.evict.skipped.no-ownership');
      continue;
    }
    if (held.isHeld(entry.hash, account)) {
      metrics.count('autofetch.evict.skipped.held');
      continue;
    }
    if (held.isDurablyProtected(adapter.id, account, entry.hash)) {
      metrics.count('autofetch.evict.skipped.protected');
      continue;
    }
    if (!(entry.acceptedAt > 0) || now - entry.acceptedAt < minAge) {
      metrics.count('autofetch.evict.skipped.too-young');
      continue;
    }
    eligible.push(entry.hash);
  }

  if (!eligible.length) {
    metrics.count('autofetch.evict.skipped.no-fallback');
    return noop;
  }

  const apiKey = String(input.apiKey || '');
  const evictFn = adapter.evictFallbacks!.bind(adapter);
  metrics.count('autofetch.evict.eligible', eligible.length);
  return runCoalesced(`${adapter.id}:${account}:${digest}`, async () => {
    const result = await evictFn(apiKey, eligible);
    for (const skip of result.skipped || []) {
      metrics.count(`autofetch.evict.skipped.${skip.reason || 'other'}`);
    }
    for (const removed of result.removed || []) {
      // Sucesso confirmado pelo executor: esquece o marker e libera a vaga da
      // obra (a prova durável adsub e o `adrm` já foram tratados lá).
      cache.forget(markerKey(adapter.id, account, removed.hash));
      forgetObraHash({ ...identity, hash: removed.hash });
    }
    const total = result.removed?.length || 0;
    if (total > 0) {
      metrics.count('autofetch.evict.removed', total);
      log.info(`[autofetch] evict: ${total} fallback(s) any/seeds da obra removido(s) da conta AllDebrid`);
    }
  });
}

/** Estado volátil para diagnóstico/testes; nunca expõe obra nem conta cruas. */
export function evictInFlightCount(): number {
  return inFlight.size;
}
