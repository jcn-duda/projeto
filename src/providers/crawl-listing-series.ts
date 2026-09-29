// IDENTIDADE DO PORTÃO DE SÉRIES no cursor de LISTAGEM (Fase 8). O cursor em si
// — página, marco, âncora e `rounds` — mora em `crawl-cursor.ts`, e este módulo
// não o duplica: ele carrega o único dado que a COBERTURA daquele cursor não
// expressa, e por isso o torna um cursor diferente.
//
// ## O buraco que este módulo fecha
//
// A listagem de um site BR é MISTA: a mesma página tem card de filme e card de
// série. Com séries desligadas, o `walkListing` LÊ a página (o request foi gasto
// no site) e descarta a URL de série — a política certa, herdada dos sites com
// sitemap. Só que a página também é CONSUMIDA pelo cursor: `page + 1`, `seen +
// posts.length`, e o `anchor` vira o último post da página quando o round fecha.
// A partir daí aquelas páginas ficam PARA TRÁS do marco, e a âncora afirma (com
// a autorização do motor) que tudo abaixo dela já foi enfileirado. Não foi:
// as URLs de série foram jogadas no caminho. Ligar séries depois não recupera
// nada — o acervo de série só volta com "Zerar site", que joga também o que já
// foi enfileirado e gasto.
//
// ## Por que o estado do portão ENTRA na identidade do cursor
//
// A cobertura do cursor é um RESUMO ("li até este post"), e o resumo só vale
// para a varredura que o produziu. Um cursor escrito com séries desligadas
// descreve um mundo em que a série foi descartada; continuá-lo com séries
// ligadas é afirmar cobertura que não existe. Daí a decisão: gravar JUNTO do
// cursor o valor do portão com que ele foi escrito, e quando o valor ATUAL
// diferir do gravado, apagar o cursor — a próxima rodada recomeça da página 1 e
// a série entra na varredura inteira.
//
// ## Por que o descarte é IRREVERSÍVEL (e por que isso é o conserto certo)
//
// O CAMINHO OPOSTO — "parar a varredura enquanto houver página com série
// descartada" — parece mais barato e é o erro: com séries desligadas PARA
// SEMPRE, ele releria as mesmas páginas para sempre, sem nunca gastar a
// orçamento do teto por hora, e o site ficaria congelado no ponto em que a
// primeira página mista apareceu. O descarte de uma varredura, ao contrário, é
// idempotente pelo motivo que o próprio cursor promete: a listagem é reidempotente
// por `url_key`, e o `upsert` do store também — reler uma página já enfileirada
// não duplica nada, só gasta requisição. O que é irreversível é a PERDA: uma
// URL de série lida e descartada não fica em lugar nenhum (a fila nunca a viu), e
// a única forma de recuperá-la é reler a página onde ela estava. Logo, o conserto
// não é inventar memória do que foi descartado (o site não oferece histórico de
// listagem), é garantir que a releitura acontece.
//
// ## Marker ausente = cursor de antes desta mudança
//
// Um cursor gravado por uma versão anterior não tem marcador. Ele conta como
// INCOMPATÍVEL e é descartado uma única vez: reler a listagem do zero é o lado
// barato, e o piso de uma releitura é uma varredura completa, não perda de dado.
import * as store from '../utils/crawl-store.js';
import * as log from '../utils/logger.js';
import {
  clearListingCursor, listingCursorKey, loadListingCursor, saveListingCursor,
  type ListingCursor,
} from './crawl-cursor.js';
import type { CrawlPageKind } from './crawl-types.js';

/**
 * Sufixo da chave irmã no `crawl_state`. Fica DERIVADA da chave do cursor (e
 * não uma lista de sites) porque a identidade que importa é a mesma: a mesma
 * listagem, no mesmo site, com o mesmo kind.
 */
export const LISTING_SERIES_SUFFIX = ':series';

/** Chave do marcador de séries (irmã da chave do cursor, no mesmo `crawl_state`). */
export function listingSeriesKey(kind: CrawlPageKind, listing: string): string {
  return `${listingCursorKey(kind, listing)}${LISTING_SERIES_SUFFIX}`;
}

/** O valor gravado é `1`/`0` — e nada mais, para que estado virgem seja ≠ gravado. */
function markerOf(seriesEnabled: boolean): string {
  return seriesEnabled === true ? '1' : '0';
}

/**
 * Lê o cursor de listagem respeitando a identidade do portão de séries.
 *
 * `null` (recomeçar da página 1) quando: nunca foi lida; o token é inválido ou
 * de outra listagem; ou o portão atual difere do marcador gravado — e neste
 * último caso o cursor é APAGADO aqui mesmo, para que a próxima gravação
 * (mesma chave, valor novo) não reencontre o estado velho.
 *
 * Sem cursor não há o que comparar: a listagem já vai recomeçar da página 1, e o
 * marcador é reescrito na próxima gravação.
 */
export function loadListingCursorForSeries(
  site: string,
  kind: CrawlPageKind,
  listing: string,
  seriesEnabled: boolean,
): ListingCursor | null {
  const cursor = loadListingCursor(site, kind, listing);
  if (!cursor) return null;
  const saved = store.engine().getState(site, listingSeriesKey(kind, listing));
  if (String(saved ?? '') === markerOf(seriesEnabled)) return cursor;
  clearListingCursor(site, kind, listing);
  log.info(`[crawl] ${site}: portão de séries ${seriesEnabled ? 'ligado' : 'desligado'} `
    + `≠ o do cursor (${cursor.path}) — cursor da listagem descartado; a varredura `
    + 'recomeça da página 1 para recuperar o que a varredura anterior descartou');
  return null;
}

/**
 * Grava o cursor JUNTO com o portão que o produziu. Quem chama é o adaptador, e
 * ele só chama quando a rodada consumiu página alguma.
 *
 * Marcador ANTES do cursor de propósito: um crash entre as duas escritas deixa o
 * cursor ANTIGO com o marcador novo, e a rodada seguinte continua daquele
 * ponto — releitura barata. Na ordem inversa, o mesmo crash deixaria o cursor
 * novo com o marcador velho, e a próxima rodada o trataria como incompatível e
 * jogaria a varredura inteira fora.
 */
export function saveListingCursorForSeries(cursor: ListingCursor, seriesEnabled: boolean): void {
  store.engine().setState(
    cursor.site, listingSeriesKey(cursor.kind, cursor.path), markerOf(seriesEnabled),
  );
  saveListingCursor(cursor);
}
