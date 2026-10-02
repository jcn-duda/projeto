import config from '../config.js';
import type { RawItem } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import { stripDiacritics } from '../utils/format.js';
import { prefix } from '../utils/cache-keys.js';

/**
 * O que o Jackett recebe como Query. Buscador WordPress engasga com "SxxEyy":
 * os resolvers locais já removem no servidor, mas indexer BR com definição
 * stock (redetorrent) recebe a query crua e devolve 0. Remover aqui também faz
 * episódios da mesma temporada compartilharem o cache do Jackett. Nos
 * `bareTitleIndexers` o ANO no fim também sai ("Coringa 2019" → 0 lá) — só o
 * do fim, senão o filme "1917" perderia o próprio título. A query original
 * segue intacta para os pré-filtros de temporada/episódio da resolução.
 *
 * O diacrítico também sai, mas SÓ nos BR (`isBr`): medido ao vivo, o buscador
 * WordPress dos sites BR devolve 0 para qualquer query acentuada
 * ("Extermínio" → 0 contra 8–16 de "Exterminio" nos 5 indexers BR), enquanto
 * os globais casam bem com acento — a varredura pt-BR roda neles com
 * `isBr = false` e não pode ser tocada.
 */
export function shapeSearchQuery(indexer: string, query: string, isBr?: boolean) {
  let shaped = String(query || '');
  if (isBr) {
    shaped = shaped.replace(/\bS\d{1,2}(?:E\d{1,3})?\b/gi, ' ');
    shaped = stripDiacritics(shaped);
  }
  if (config.jackett.bareTitleIndexers.includes(indexer)) {
    shaped = shaped.replace(/\s+(?:19|20)\d{2}\s*$/, ' ');
  }
  shaped = shaped.replace(/\s+/g, ' ').trim();
  return shaped || query;
}

/** Orçamento que a busca AO VIVO daria a este indexer. */
export function budgetFor(indexer: string) {
  const isSlow =
    config.jackett.ptBrIndexers.includes(indexer) || config.jackett.slowIndexers.includes(indexer);
  return isSlow ? config.jackett.brIndexerTimeout : config.jackett.indexerTimeout;
}

/**
 * Chaves do cache bruto que uma busca por estes indexers consultaria — a
 * simulação da Fase 0 do índice usa isto para medir, ANTES de qualquer rede,
 * se a matéria-prima da obra já está quente. Reproduz a construção de chave do
 * queryIndexer (mesma moldagem de query); divergir daqui é medir outra coisa.
 */
export function rawKeysFor(indexers: string[], query: string, type: string) {
  return (indexers || []).map((indexer) => {
    const isBr = config.jackett.ptBrIndexers.includes(indexer);
    const searchQuery = shapeSearchQuery(indexer, query, isBr);
    return `${prefix('raw')}jackett:${indexer}:${type}:${searchQuery}`;
  });
}

/**
 * Leitura de DIAGNÓSTICO do cache bruto (P5 recompute): as MESMAS chaves que a
 * busca grava (rawKeysFor), lidas com `cache.peek` — sem fetch, sem breaker,
 * sem indexerStatus, sem promover LRU nem contar hit/miss. Devolve os itens
 * crus que ainda estão quentes por indexer; quem chama monta o balde de
 * matéria-prima local para explicar um sumiço SEM refazer a busca.
 */
export function peekRawFor(indexers: string[], query: string, type: string): RawItem[] {
  return rawKeysFor(indexers, query, type).flatMap((key) => {
    const hit = cache.peek(key);
    return Array.isArray(hit) ? (hit as RawItem[]) : [];
  });
}
