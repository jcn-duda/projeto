// Identidade de página no `crawl.db`: a fila é uma linha por `(site, url_key)`
// e `url_key` é o CAMINHO da URL, não a URL.
//
// Por quê o caminho: os sites BR trocam de domínio com frequência (o
// NerdFilmes já passou por `xnerdfilmes.net` → `nerdviatorrents.net` →
// `filmesviatorrenthd.net`, o Vaca por `vacatorrentmov.com` →
// `vaqueirofilmes.com`). Com a URL inteira como chave, cada migração de host
// nasce como uma fila NOVA: as 10 mil linhas velhas ficam `done` no arquivo
// antigo e as mesmas páginas voltam a ser lidas do zero no host novo — o
// acervo duplica, o total do painel mente e o teto por hora queima rereadendo o
// que já existe. Com o caminho como identidade, a redescoberta no host novo
// encontra a MESMA linha: o estado (`done`, `imdb`, `releases`) sobrevive e
// só o host gravado é atualizado (é o `decideUpsert` que faz isso no caminho
// `unchanged`). É a decisão registrada da Fase 8.
//
// A `url` continua gravada por inteiro — a chave é o que dedupa, o valor é o
// que o motor lê — e por isso ela guarda sempre o HOST ATUAL.
//
// Normalização: sem esquema/host, sem query, sem fragmento, `//` colapsada e
// barra final fora (a raiz `/` é ela mesma). A chave nunca fica vazia para
// entrada não vazia: um URL malformado que produzisse `''` colapsaria a fila
// inteira do site numa linha só, e o sintoma seria "o crawler encheu 12 h sem
// ler nada".
//
// LIMITAÇÃO CONHECIDA (por desenho, não por esquecimento): a identidade ignora
// a query, então uma página que o site distinga SÓ por query (`?p=123`) cai na
// mesma linha da vizinha. Nenhum site BR rastreado usa essa forma (todos têm
// permalink por caminho); a superfície que realmente pagina por query — a
// listagem — é percorrida pelo cursor opaco de listagem
// (`providers/crawl-cursor.ts`) e nunca entra na `crawl_url`. Se um site
// passar a precisar de identidade por query, o caminho é acrescentar aqui (e
// revisar a migração), não o motor.
import type { CrawlUrlRow, CrawlUrlStatus } from '../providers/crawl-types.js';

/** Corta query e fragmento — o que não é identidade de página. */
function stripQuery(url: string): string {
  return url.split('#')[0].split('?')[0];
}

function normalizePath(path: string): string {
  const cut = stripQuery(path);
  if (!cut) return '/';
  const collapsed = cut.replace(/\/{2,}/g, '/');
  if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.replace(/\/+$/, '') || '/';
  return collapsed;
}

/**
 * Chave de identidade da página. Aceita URL absoluta, caminho relativo (o store
 * também guarda linhas legadas/testes sem host) e entrada malformada — nunca
 * lança e nunca devolve `''` para entrada não vazia.
 */
export function crawlUrlKey(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    return normalizePath(new URL(text).pathname);
  } catch {
    // Sem host: caminho puro. `scheme://host` escrito à mão (sem parser) também
    // perde o host — mesmo efeito, e é a intenção da chave.
    const cut = stripQuery(text);
    const schemeAt = cut.indexOf('://');
    if (schemeAt < 0) return normalizePath(cut);
    const afterHost = cut.slice(schemeAt + 3);
    const slashAt = afterHost.indexOf('/');
    return normalizePath(slashAt >= 0 ? afterHost.slice(slashAt) : '/');
  }
}

/**
 * Grau de maturidade da linha, para escolher quem sobrevive quando duas URLs
 * de mesmo caminho colidem na migração (o host já mudou uma vez). O que prova
 * trabalho vence o que só anota sucesso, e a falha com backoff vence o
 * sucesso — reenfileirar uma página é o lado barato do engano, perder o
 * `done`/`releases` dela é o caro.
 */
const MATURITY: Record<CrawlUrlStatus, number> = {
  inflight: 6, partial: 5, error: 4, done: 3, 'no-torrent': 2, 'no-work': 1, pending: 0, simulated: 0,
};

/** Totalmente ordenado: a escolha é determinística, não "a última que vi". */
function wins(a: CrawlUrlRow, b: CrawlUrlRow): boolean {
  if ((a.progress !== '') !== (b.progress !== '')) return a.progress !== '';
  const ma = MATURITY[a.status] ?? 0;
  const mb = MATURITY[b.status] ?? 0;
  if (ma !== mb) return ma > mb;
  if (a.checkedAt !== b.checkedAt) return a.checkedAt > b.checkedAt;
  if (a.addedAt !== b.addedAt) return a.addedAt > b.addedAt;
  return a.url < b.url;
}

/**
 * Funde as linhas que passaram a ser a MESMA página (mesmo site, mesmo
 * caminho). Uma migração roda UMA vez e o estado consolidado precisa ser
 * honesto: o que dá trabalho (progresso de série, tentativas com backoff)
 * sobrevive, a contagem de releases não some e a fila não inventa uma entrada
 * que ninguém usou. Lista vazia devolve `null` (chamar não é erro).
 */
export function mergeCrawlUrlRows(rows: readonly CrawlUrlRow[]): CrawlUrlRow | null {
  if (!rows.length) return null;
  let winner = rows[0];
  for (const row of rows.slice(1)) if (wins(row, winner)) winner = row;
  const max = (pick: (r: CrawlUrlRow) => number) => rows.reduce((acc, r) => Math.max(acc, pick(r)), 0);
  const min = (pick: (r: CrawlUrlRow) => number) => rows.reduce((acc, r) => Math.min(acc, pick(r)), pick(winner));
  const imdb = winner.imdb ?? rows.map((r) => r.imdb).find((v) => v != null) ?? null;
  // `addedAt` mínimo: a página entrou na fila antes das outras, então a ordem
  // determinística do `takeNext` (next_at, added_at, url_key) não muda de lugar
  // por causa da migração.
  return {
    ...winner,
    lastmod: rows.reduce((acc, r) => (r.lastmod > acc ? r.lastmod : acc), ''),
    imdb,
    tries: max((r) => r.tries),
    nextAt: winner.nextAt,
    checkedAt: max((r) => r.checkedAt),
    releases: max((r) => r.releases),
    addedAt: min((r) => r.addedAt),
  };
}
