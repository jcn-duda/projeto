// Vitals do card por site (Fase 4.1 ritmo real / contagem de 429; Fase 2.1
// "link expirado"). O Node NÃO abre o `crawl.db` (dono é o sidecar): tudo aqui
// é computado sobre a FOTO que `crawl-read-engine.ts` guarda — as linhas mais
// recentes por status, com `checkedAt`.
//
// A janela de 1 h conta `checkedAt`; a lista `done`/`error` que a foto traz
// vem cortada pelo `limit` do pedido (`SNAPSHOT_LIMIT`), então o ritmo pode
// SATURAR: quando a amostra inteira cabe na janela, o número é um piso ("≥")
// e não uma medição fechada. O cliente mostra o sinal; aqui vai o booleano.
//
// Com o bloco `vitals` da foto, os números são do site INTEIRO, contados pelo
// sidecar: as listas não trazem `no-torrent` nem `pending`, e era nelas que o
// Vaca tinha 85% das páginas e todo 429 adiado (o card mostrava 30 pág/h com
// 290 reais e 429 zerado — 2026-11-03). A conta sobre as listas abaixo só
// sobra para foto de sidecar anterior ao bloco.
//
// 429: o motor grava o motivo no campo `error` (depois do conserto ele fica em
// linhas `pending` com error gravado) — a contagem é pelo CAMPO error, nunca
// pelo status da linha. "expirado" é substring (LIKE '%expirado%'): o texto do
// portão do BLUDV varia ("link expirado no portão", "expirado: …").
import type { CrawlReadEngine } from './crawl-read-engine.js';
import type { CrawlUrlRow } from './crawl-types.js';

/** Janela do ritmo real e das taxas de erro. */
export const HOUR_MS = 3_600_000;

/** Linhas pedidas por status para os vitals. Igual ao teto do sidecar
 * (`MAX_LIMIT` do snapshot): acima disso o corte é lá, não aqui. */
export const VITALS_LIST_LIMIT = 200;

/** Estatística de um padrão de erro: total na amostra e ocorrências na última
 * hora. `total` é limitado pela amostra que a foto trouxer. */
export interface ErrorStat {
  total: number;
  lastHour: number;
}

export interface SiteVitals {
  /** Páginas com `checkedAt` na última hora (done + no-work + partial + error
   * — é o que a foto expõe; `no-torrent` não vem na foto e o ritmo pode ser
   * subestimado nos sites com muitas páginas sem torrent). */
  pagesLastHour: number;
  /** Tamanho da amostra usada (as linhas que a foto trouxe). */
  pagesSample: number;
  /** Amostra inteira dentro da janela: o ritmo é um piso ("≥"). */
  pagesSaturated: boolean;
  /** Erros `http_429…` (por campo error, qualquer status). */
  http429: ErrorStat;
  /** Erros com "expirado" no texto (portão do BLUDV e afins). */
  expired: ErrorStat;
}

/** `checkedAt` dentro da última hora (0 é "nunca checada" do store). */
function withinLastHour(checkedAt: number, now: number): boolean {
  if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;
  const age = now - checkedAt;
  return age >= 0 && age < HOUR_MS;
}

function emptyStat(): ErrorStat {
  return { total: 0, lastHour: 0 };
}

/** Conta as linhas cujo `error` casa o padrão, total e na última hora. */
function statWhere(rows: CrawlUrlRow[], now: number, match: (error: string) => boolean): ErrorStat {
  const stat = emptyStat();
  for (const row of rows) {
    const error = String(row.error || '');
    if (!error || !match(error)) continue;
    stat.total += 1;
    if (withinLastHour(row.checkedAt, now)) stat.lastHour += 1;
  }
  return stat;
}

/** LIKE 'http_429%': prefixo, com detalhe livre depois (retry, host…). */
export function isHttp429(error: string): boolean {
  return /^http_429/i.test(error);
}

/** LIKE '%expirado%': o texto do portão não é fixo (BLUDV repete a cadeia). */
export function isExpiredLink(error: string): boolean {
  return error.toLowerCase().includes('expirado');
}

/** Listas do card JÁ lidas da mesma foto — o vitals as reaproveita sem
 * repetir `listByStatus` (contrato de custo do poll: `test/crawl-status.test.ts`
 * amarra uma leitura por status; reler aqui dobraria o custo de cada ciclo). */
export interface SiteVitalLists {
  done: CrawlUrlRow[];
  no_work: CrawlUrlRow[];
  partial: CrawlUrlRow[];
  error: CrawlUrlRow[];
}

/** Vitals de UM site sobre a foto vigente. Site sem foto volta zerado (o card
 * mostra "—"/idade da foto) — nunca lança: um vitals não derruba o bloco.
 * Quando o card já leu as listas (mesma foto), elas chegam prontas em `lists`
 * e o engine NÃO é tocado: uma leitura por status paga card e vitals. */
export function buildSiteVitals(
  engine: CrawlReadEngine,
  siteId: string,
  now = Date.now(),
  lists?: SiteVitalLists,
): SiteVitals {
  // Todas as listas que a foto expõe participam: página checada é atividade
  // (done, no-work, partial) e o 429/expirado mora no campo `error` de
  // qualquer uma delas. `no-torrent` não vem na foto (limite reportado).
  const rows = lists
    ? [...lists.done, ...lists.no_work, ...lists.partial, ...lists.error]
    : [
        ...engine.listByStatus(siteId, 'done', VITALS_LIST_LIMIT),
        ...engine.listByStatus(siteId, 'no-work', VITALS_LIST_LIMIT),
        ...engine.listByStatus(siteId, 'partial', VITALS_LIST_LIMIT),
        ...engine.listByStatus(siteId, 'error', VITALS_LIST_LIMIT),
      ];
  const counted = engine.vitals?.(siteId);
  if (counted) {
    return {
      pagesLastHour: counted.pagesLastHour,
      pagesSample: rows.length,
      pagesSaturated: false,
      http429: { ...counted.http429 },
      expired: { ...counted.expired },
    };
  }
  const pagesLastHour = rows.filter((row) => withinLastHour(row.checkedAt, now)).length;
  return {
    pagesLastHour,
    pagesSample: rows.length,
    pagesSaturated: rows.length >= VITALS_LIST_LIMIT && pagesLastHour >= rows.length,
    http429: statWhere(rows, now, isHttp429),
    expired: statWhere(rows, now, isExpiredLink),
  };
}
