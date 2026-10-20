// Handler do efeito `autofetch_batch` da rota interna
// `POST /internal/search/effects` (F4.1): o orquestrador Rust emite o lote
// PÓS-DEBRID com os fatos internos de cada stream e o Node roda a MESMA cascata
// de sempre (`autoFetchCandidates` → `autoFetchBrDubbed`), com o estado que só
// ele tem: marker/lock/hold, teto por obra, fila persistente, config viva do
// painel e `debrid.enqueue`.
//
// Por que o handler não decide nada: a escolha do Chupim depende de estado de
// PROCESSO (painel vivo, reserva síncrona por obra, `classifyEnqueue`,
// `hold`, fila persistente) e da lista tocável/sonda BR do índice. Trazer isso
// ao Rust seria uma fatia inteira; o contrato fechado foi o inverso — o Rust
// entrega os fatos medidos e o Node continua sendo o dono da decisão. Sem
// mudar o caminho normal e sem duplicar a cascata: este módulo só reconstrói os
// `Stream`s e chama as funções que o `applyDebrid` já chama.
import type { Stream } from '../../types/domain.js';
import { autoFetchCandidates, autoFetchBrDubbed } from './autofetch-runner.js';
import { enrichInstantWithoutCacheCheck } from './debrid-pipeline-steps.js';
import debrid from '../debrid/index.js';
import { opts } from '../runtime.js';
import * as log from '../utils/logger.js';

/** Candidato reconstruído: a seleção exige hash (nunca um aviso). */
export type AutofetchBatchStream = Stream & { infoHash: string };

/** Corpo do efeito, exatamente como `orchestrator/effects.rs` monta. */
export type AutofetchBatchPayload = {
  items?: unknown;
  cached?: unknown;
  known?: unknown;
  season?: unknown;
  episode?: unknown;
  imdbId?: unknown;
  searchKey?: unknown;
};

// Fatos internos que a seleção lê do stream (`types/domain.d.ts`). Só os que o
// lote carrega: qualquer outro campo não influencia a decisão.
const TEXT_FACTS = ['title', 'name'] as const;
const STRING_FACTS = ['_quality', '_indexer', '_tracker'] as const;
const BOOLEAN_FACTS = [
  '_br',
  '_dubbed',
  '_dubClaim',
  '_fromFallback',
  '_fallbackFetchable',
  '_seedFloorWaived',
  '_multiWorkAdmitted',
  '_bankDub',
  '_lied',
] as const;
const NUMBER_FACTS = ['_seeders', '_size', '_packBytes'] as const;

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * Reconstrói um `Stream` do item de fio. Retorna `null` sem hash (a seleção
 * nunca dispara um stream que o `applyDebrid` não conheceria) e descarta fato
 * de tipo errado em vez de propagar lixo para a cascata.
 */
export function streamOfItem(raw: unknown): AutofetchBatchStream | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const infoHash = typeof item.infoHash === 'string' ? item.infoHash.trim() : '';
  if (!infoHash) return null;
  const stream: Record<string, unknown> = { infoHash };
  for (const key of TEXT_FACTS) {
    if (typeof item[key] === 'string') stream[key] = item[key];
  }
  for (const key of STRING_FACTS) {
    if (typeof item[key] === 'string') stream[key] = item[key];
  }
  for (const key of BOOLEAN_FACTS) {
    if (item[key] !== undefined) stream[key] = item[key] === true;
  }
  for (const key of NUMBER_FACTS) {
    if (typeof item[key] === 'number' && Number.isFinite(item[key])) stream[key] = item[key];
  }
  return stream as unknown as AutofetchBatchStream;
}

/**
 * Roda o lote. Espelha os passos do `applyDebrid`
 * (`debrid-pipeline-core.ts:130-134,213-220`):
 *
 * 1. o filtro de entrada do `autoFetchCandidates` (multiobra admitida e reserva
 *    não elegível ficam de fora) — idempotente: o Rust já emitiu filtrado;
 * 2. `autoFetchCandidates` escolhe e SEGURA os hashes (síncrono, sem rede);
 * 3. `enrichInstantWithoutCacheCheck` completa o veredito com o inventário da
 *    conta (adaptador sem `cacheCheck`, como RD/Debrid-Link) — exatamente o
 *    passo do `applyDebrid` antes do despacho;
 * 4. `autoFetchBrDubbed` despacha depois do veredito de cache — com `known`
 *    falso, libera os holds sem enfileirar.
 *
 * A lista COMPLETA (sem o filtro) vai ao despacho: a cobertura por qualidade e
 * o "já tem dublado em cache" olham todos os streams, como no Node.
 */
export function runAutofetchBatch(payload: AutofetchBatchPayload): number {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const streams = rawItems
    .map(streamOfItem)
    .filter((stream): stream is AutofetchBatchStream => stream !== null);
  // Lote sem stream com hash: nada a segurar/despachar — e nada de inventário
  // (o enriquecimento pode acordar rede em adaptador sem `cacheCheck`).
  if (streams.length === 0) return 0;
  const cached = new Set<string>();
  if (Array.isArray(payload.cached)) {
    for (const hash of payload.cached) {
      if (typeof hash === 'string' && hash) cached.add(hash.toLowerCase());
    }
  }
  const season = intOrNull(payload.season);
  const episode = intOrNull(payload.episode);
  const imdbId = typeof payload.imdbId === 'string' && payload.imdbId ? payload.imdbId : undefined;
  const searchKey = typeof payload.searchKey === 'string' && payload.searchKey ? payload.searchKey : undefined;
  const known = payload.known === true;

  const eligible = streams.filter(
    (stream) => !stream._multiWorkAdmitted && !(stream._fromFallback && !stream._fallbackFetchable),
  );
  const candidates = autoFetchCandidates(eligible, { season, episode, imdbId, searchKey });
  // O inventário da conta é estado do NODE: o Rust não o vê. Para adaptador sem
  // `cacheCheck` (RD/Debrid-Link), o `known` do lote pode ser falso mesmo com o
  // acervo respondendo — o mesmo completamento do `applyDebrid` vale aqui.
  const adapter = debrid.current();
  const enrichment = adapter
    ? enrichInstantWithoutCacheCheck(adapter, streams, cached, known, opts().debridApiKey)
    : { cachedForAutofetch: cached, knownForAutofetch: known };
  const enqueued = autoFetchBrDubbed(streams, candidates, {
    cached: enrichment.cachedForAutofetch,
    known: enrichment.knownForAutofetch,
    season, episode, imdbId, searchKey,
  });
  log.debug(
    `[internal] autofetch_batch: itens=${streams.length} known=${enrichment.knownForAutofetch} ` +
      `candidatos=${candidates.length} enfileirados=${enqueued}`,
  );
  return enqueued;
}
