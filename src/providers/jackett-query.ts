import config from '../config.js';
import type { RawItem } from '../../types/domain.js';
import * as cache from '../utils/cache.js';
import { stripDiacritics } from '../utils/format.js';
import { collapseAcronyms } from '../utils/title-normalization.js';
import { prefix } from '../utils/cache-keys.js';

/**
 * O que o Jackett recebe como Query. A TEMPORADA fica na query BR: os oito
 * cards BR são servidos pelo resolver Rust (127.0.0.1:870x), que extrai a
 * temporada da própria query (`requested_season`) e aplica o filtro ANTES do
 * corte de posts — sem o Sxx, "S.W.A.T. S02" buscava sem temporada e o corte
 * levava as temporadas 6–3 do WordPress. O EPISÓDIO sai do token (S02E05 ->
 * S02) para episódios da mesma temporada compartilharem o cache bruto. Nos
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
    // A temporada FICA (o resolver Rust precisa dela — ver o doc acima); o
    // episódio sai do token. O site em si nunca vê o token: o normalize_query
    // do resolver remove o Sxx antes de buscar (defesa dupla viva nos BR-Rust).
    shaped = shaped.replace(/\bS(\d{1,2})E\d{1,3}\b/gi, 'S$1');
    shaped = stripDiacritics(shaped);
  } else {
    // Sigla com ponto, SÓ nos globais: "G.O.R.A. 2004" voltava vazio nos
    // trackers e "GORA 2004" acha 8; já o WordPress dos BR casa o literal
    // ("S.W.A.T." → 127 na BLUDV, "SWAT" → 0) e fica com os pontos.
    shaped = collapseAcronyms(shaped);
  }
  if (config.jackett.bareTitleIndexers.includes(indexer)) {
    shaped = shaped.replace(/\s+(?:19|20)\d{2}\s*$/, ' ');
  }
  shaped = shaped.replace(/\s+/g, ' ').trim();
  // A moldagem nunca devolve SÓ o token de temporada: sem título a busca não
  // tem o que casar no site (o resolver normalizaria "S01" para vazio), então
  // vale a query original — mesma proteção do fallback de vazio abaixo.
  if (/^S\d{1,2}$/i.test(shaped)) return query;
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
    // O escritor (`queryIndexer`) grava o ENVELOPE `{ items }`; o array cru é
    // o shape legado de antes do P5. Aceitar só um dos dois devolvia [] em
    // produção e o recompute perdia a base `raw` em silêncio.
    const items = Array.isArray(hit) ? hit : (hit as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? (items as RawItem[]) : [];
  });
}
