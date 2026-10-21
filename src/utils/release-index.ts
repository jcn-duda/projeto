// Índice de releases por obra (`idx:v14`): a memória que faz o addon virar
// servidor. O `raw:v1` guarda a raspagem por QUERY; aqui guarda o que a obra
// TEM, filtrado e dedupado por hash, e vive semanas.
//
// Desde a F3.1 o dono do namespace é o núcleo Rust (`IdxStore`, via
// `release-index-store.ts`): regras de merge, roteamento, corte e as provas
// (miss, lied, evidência por arquivo, parcial) são do `adom-index`. Este módulo
// só traduz as chamadas do Node, com as mesmas assinaturas de antes. As chamadas
// são síncronas e o Rust grava antes de devolver, então ler logo depois de
// gravar vê o gravado.
//
// Invariantes (mantidos pelo Rust):
// 1. Sem config do usuário e sem chave de debrid na chave: o índice é
//    compartilhado entre instalações de propósito. Item de inventário
//    (`fromAccount`) não entra.
// 2. Só o que já passou pelo filtro de relevância entra no índice.
// 3. Deduplicação por hash, mantendo o registro mais recente (OR na marca BR).
// 4. `seeders` é foto datada (`seenAt`), não verdade corrente.
import config from '../config.js';
import * as metrics from './metrics.js';
import { extractInfoHash } from './format.js';
import { quotaFor } from './cache-quotas.js';
import { bankRowsForMediaSource } from './release-index-media.js';
import { bankRowsNapi } from './rust-release-index.js';
import { idxStore, clearIdxStore } from './release-index-store.js';
import type { FileEvidence, IndexedRelease, ObraLocation } from './release-index-types.js';

export type { IndexedRelease, FileEvidence } from './release-index-types.js';
export { clearIdxStore };

function enabled() {
  return config.releaseIndex.enabled && config.releaseIndex.ttl > 0;
}

function tt(imdbId: string | null | undefined): boolean {
  return Boolean(imdbId) && String(imdbId).startsWith('tt');
}

/**
 * Alimenta o índice com o que a busca provou existir. Idempotente: merge por
 * hash, mais recente vence; itens sem hash e da conta ficam fora.
 */
function record(
  imdbId: string,
  location: ObraLocation,
  items: any[],
  opts: { partial?: boolean; keepPartial?: boolean; source?: 'autofetch' } = {},
): number {
  if (!enabled() || !tt(imdbId) || !Array.isArray(items) || items.length === 0) return 0;
  // A fonte de mídia precisa das linhas do acervo: o Node lê o SQLite do
  // magnet bank e passa só as linhas dos candidatos; o Rust decide o resto.
  const candidatos: { item: any; hash: string }[] = [];
  for (const item of items) {
    if (item?.fromAccount) continue;
    const hash = String(extractInfoHash(item.infoHash || item.magnet || '') || '').toLowerCase();
    if (hash) candidatos.push({ item, hash });
  }
  const bankRows = bankRowsNapi(bankRowsForMediaSource(candidatos));
  const added = idxStore().record(
    imdbId,
    location.season ?? null,
    location.episode ?? null,
    items,
    { partial: Boolean(opts.partial), keepPartial: Boolean(opts.keepPartial), source: opts.source },
    bankRows,
    Date.now(),
  );
  metrics.count('search.idx.recorded', added);
  if (added > 0) metrics.count('search.idx.grown');
  return added;
}

/** Consulta por obra: episódio primeiro, temporada como fallback, raiz por último. */
function lookup(imdbId: string, location: ObraLocation = {}): IndexedRelease[] {
  if (!enabled() || !tt(imdbId)) return [];
  return idxStore().lookup(imdbId, location.season ?? null, location.episode ?? null, Date.now());
}

/** Mesma leitura: no Rust não há LRU nem contador a preservar, então é a mesma. */
function lookupQuiet(imdbId: string, location: ObraLocation = {}): IndexedRelease[] {
  return lookup(imdbId, location);
}

/** Registro PARCIAL: qualquer uma das chaves da obra marcada bloqueia o fast-path. */
function isPartial(imdbId: string, location: ObraLocation = {}): boolean {
  if (!enabled() || !tt(imdbId)) return false;
  return idxStore().isPartial(imdbId, location.season ?? null, location.episode ?? null, Date.now());
}

/** Limpa o flag `partial` de todas as chaves da obra, mantendo as releases. */
function clearPartial(imdbId: string, _location: ObraLocation = {}): number {
  if (!enabled() || !tt(imdbId)) return 0;
  return idxStore().clearPartial(imdbId, Date.now());
}

/** Evidência de áudio falso (`lied`) para o hash, nas chaves da obra. */
function markLied(imdbId: string, location: ObraLocation, hash: string): number {
  if (!enabled() || !tt(imdbId) || !hash) return 0;
  const changed = idxStore().markLied(imdbId, location.season ?? null, location.episode ?? null, hash, Date.now());
  if (changed) metrics.count('search.idx.lied', changed);
  return changed;
}

/** Prova de episódio errado: este hash NÃO serve este episódio. */
function markMissing(imdbId: string, location: ObraLocation, hash: string): number {
  if (!enabled() || !tt(imdbId) || !hash) return 0;
  if (location.season == null || location.episode == null) return 0;
  const isNew = idxStore().markMissing(imdbId, location.season, location.episode, hash, Date.now());
  if (isNew) metrics.count('search.idx.miss');
  return isNew ? 1 : 0;
}

/** Prova de temporada errada: este hash não serve nenhum episódio da temporada. */
function markMissingSeason(imdbId: string, season: number, hash: string): number {
  if (!enabled() || !tt(imdbId) || !hash || season == null) return 0;
  const isNew = idxStore().markMissingSeason(imdbId, season, hash, Date.now());
  if (isNew) metrics.count('search.idx.missSeason');
  return isNew ? 1 : 0;
}

/** Falta conhecida do hash para a obra (temporada primeiro, depois o episódio). */
function isMissing(imdbId: string, location: ObraLocation, hash: string): boolean {
  if (!enabled() || !tt(imdbId) || !hash) return false;
  return idxStore().isMissing(imdbId, location.season ?? null, location.episode ?? null, hash, Date.now());
}

/** Evidência por arquivo do hash (áudio, episódio, qualidade e nome vistos no torrent). */
function markFileEvidence(hash: string, evidence: FileEvidence): number {
  if (!enabled() || !hash || !evidence) return 0;
  const isNew = idxStore().markFileEvidence(hash, evidence, Date.now());
  if (isNew) metrics.count('search.idx.file');
  return isNew ? 1 : 0;
}

function fileEvidence(hash: string): FileEvidence | null {
  if (!enabled() || !hash) return null;
  return idxStore().fileEvidence(hash, Date.now());
}

/** Remove do índice a submissão do autofetch que recebeu prova terminal de morte. */
function forgetAutofetchHash(imdbId: string | null | undefined, hash: string): number {
  return idxStore().forgetAutofetchHash(String(imdbId || ''), String(hash || ''), Date.now());
}

/** Diagnóstico e testes: a chave exata existe e está viva no Rust? */
function idxHasKey(key: string): boolean {
  return idxStore().hasKey(key, Date.now());
}

/** Para o painel: quanto do índice existe agora (contado pelo Rust). */
function status() {
  const on = enabled();
  return {
    enabled: on,
    ttlS: config.releaseIndex.ttl,
    entries: on ? idxStore().entries(Date.now()) : 0,
    maxEntries: quotaFor('idx'),
  };
}

/** Agregado por obra só das obras pedidas, dedupe por hash (ver `adom-index`). */
function snapshotWorks(imdbIds: string[]): Map<string, IndexedRelease[]> {
  return new Map(Object.entries(idxStore().snapshotWorks(imdbIds, Date.now())));
}

/** Agregado de TODAS as obras do índice (catálogo da conta). */
function snapshotAllWorks(): Map<string, IndexedRelease[]> {
  return new Map(Object.entries(idxStore().snapshotAllWorks(Date.now())));
}

/** Mesma leitura de isMissing (sem LRU a preservar no Rust). */
const isMissingQuiet = isMissing;

export {
  record, lookup, lookupQuiet, isPartial, clearPartial, markLied, idxHasKey,
  markMissing, markMissingSeason, isMissing, isMissingQuiet,
  markFileEvidence, fileEvidence, forgetAutofetchHash, status, snapshotWorks, snapshotAllWorks,
};
