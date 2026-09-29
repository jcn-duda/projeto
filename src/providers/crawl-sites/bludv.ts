// Adaptador de raspagem do BLUDV (Fase 8 — card `bludv-cardigann`, profile
// `bludv`; a ponte entre os dois nomes é este arquivo, o mesmo padrão do
// `torrentdosfilmesv2`↔`torrentdosfilmes` e do
// `redetorrent-cardigann`↔`redetorrent`).
//
// O motor cuida de fila, ritmo e gravação; aqui mora a LEITURA DA PÁGINA
// (`fetchWork`: post → âncoras de download → magnet) e a delegação da
// descoberta, sempre pelo resolver JÁ CARREGADO (`br-resolvers.instance`). A
// descoberta em si (índice Yoast → 18 `post-sitemap*.xml` → obras com lastmod e
// tipo pelo slug) está em `bludv-discover.ts`; as regras puras em
// `bludv-discovery.ts`; a medição que justifica cada escolha está no cabeçalho
// daqueles arquivos e aqui embaixo, sem repetir.
//
// ── O QUE ESTE SITE É DIFERENTE (medido em 2026-09-29) ───────────────────────
//
//  1. O MAGNET É DIRETO NO POST, sem salto de protetor. O bloco de downloads é
//     `<a href="magnet:?xt=urn:btih:…">` com a imagem do botão
//     (`alt="Magnet Link"`), ao lado de um `.torrent` em `torcache.net` que o
//     perfil NÃO segue (não é magnet nem protetor na allowlist). É o mesmo
//     caminho do card vivo, que também resolve sem `/resolve`. Logo o
//     `requestCost` de uma página é 1 — e ele é CONTADO, não assumido: se um dia
//     o site passar a publicar botão de protetor, o número errado cobra caro no
//     teto por hora.
//  2. O TRANSPORTE é o `fetchText` DO PROFILE (direto → FlareSolverr no 403),
//     não o `fetchTextDirect` dos outros três sites: o AGENTS registra o BLUDV
//     atrás de challenge do Cloudflare desde 2026-08-28. Na medição de hoje o
//     host respondeu 200 direto, mas o caminho que aguenta o dia em que ele
//     voltar a challenge é o do profile, e é o mesmo que a busca viva usa.
//  3. O `<h1>` TERMINA no ano ("O Final da Turnê Torrent – Blu-ray Rip 720p e
//     1080p Dublado (2016)") — a régua compartilhada de `work-name.ts` serve
//     inteira, e a do TorrentDosFilmes (ano no meio) NÃO é copiada.
//  4. O POST DECLARA UMA TEMPORADA, ao contrário do RedeTorrent: o `<h1>` e o
//     slug dizem "Smallville 10ª Temporada" e o `dn=` do magnet concorda
//     ("Smallville 10 Temporada (2010)"), então a locação sai de
//     `seasonPageGroups` (`season-page.ts`) com a mesma régua do Vaca — e não de
//     `seriesRowGroups`, que é do post que AGREGA temporadas.
//
// ── PORTÃO DE SÉRIE ────────────────────────────────────────────────────────
// 3.236 das 17.860 páginas do acervo (18,1%) são de temporada, e o slug é a única
// fonte de tipo na descoberta (o `post-sitemap*` é misto e não traz tipo). A
// página entra no motor pelo mesmo portão dos outros sites — séries do painel
// (`opts.series.enabled`) ou modo amostra (`seriesProbe`) — e temporada chegada
// como `movie` é recusada antes de qualquer fetch: gravar pack como filme é obra
// que não existe no catálogo.
//
// Travas herdadas do crawler: host do site em TODA URL derivada de conteúdo do
// site (loc do índice, loc do sitemap, URL de obra); descoberta PARCIAL não
// derruba a rodada; erro carrega o custo medido (F1, `withRequestCost`).
// Nada aqui grava banco, agenda nada nem liga o crawler.
import type { RawItem } from '../../../types/domain.js';
import type { ResolverLink } from '../../../resolvers/types.js';
import type { ReleaseTitleInput } from '../../../resolvers/release-format.js';
import type { CrawlPageOptions, CrawlSite, CrawlWorkResult } from '../crawl-types.js';
import config from '../../config.js';
import { instance } from '../../br-resolvers.js';
import * as log from '../../utils/logger.js';
import { magnetHash, withRequestCost } from './shared.js';
import { pageSeasonOf, seasonPageGroups } from './season-page.js';
import { createBludvDiscoverer } from './bludv-discover.js';
import {
  isSeasonSlug, isWorkPath, parseImdbId, parseOriginalTitle, postDeclaresSeries, workTitleYear,
} from './bludv-discovery.js';

/** id do card do Jackett (dedupe, `ji`/`jl`, reserva por indexer falho). */
export const SITE_ID = 'bludv-cardigann';
/** Rótulo humano (card do painel, `tracker` da release). */
export const TRACKER_LABEL = 'BLUDV';
/**
 * Nome do PROFILE do resolver, que NÃO é o id do card: o card é
 * `bludv-cardigann` e o profile é `bludv` (mesma divergência que o
 * `torrentdosfilmesv2`↔`torrentdosfilmes`). `br-resolvers.instance()` é indexado
 * pelo nome do profile — usar o id do card aqui devolveria `null` e a raspagem
 * seria declarada indisponível em produção.
 */
const RESOLVER_NAME = 'bludv';

/**
 * Recorte da instância do profile que o adaptador consome. Declarar a superfície
 * (em vez de `any`) faz o compilador cobrar os métodos contra a API REAL do
 * profile — quebra em compilação se o profile renomear algo. É `import type` o
 * que liga aqui: `src/` não importa o núcleo dos resolvers em runtime, a
 * instância é INJETADA (no processo do addon vem do `br-resolvers.instance`, na
 * sonda e nos testes vem do profile direto).
 */
export interface BludvResolverSurface {
  siteSelector: { url(): string };
  assertAllowedUrl(value: string | null | undefined): URL;
  /** Host candidato do SITE (allowlist do failover) — páginas só dele. */
  isDetailHost(hostname: string | null | undefined): boolean;
  /**
   * Direto → FlareSolverr no 403. ATENÇÃO AO CONTRASTE com o RedeTorrent: o
   * `fetchText` deste profile tem aridade 2 e NÃO aceita `hooks.onRequest`
   * (medido), então é a CHAMADA que conta o custo — ver `countedFetchText` na
   * fábrica. O `fetchFollowingAllowed` abaixo aceita o hook e é ele que conta o
   * salto de protetor.
   */
  fetchText(url: string | URL, referer?: string): Promise<string>;
  parseDownloadLinks(html: string | null | undefined, baseUrl?: string): ResolverLink[];
  fetchFollowingAllowed(value: string, referer?: string | null, hooks?: { onRequest?: () => void }): Promise<string>;
  extractMagnet(html: string | null | undefined): string | null;
  releaseTitle(post: string, link: ReleaseTitleInput, index?: number | null): string;
  parseSize(text: string | null | undefined): number | null;
}

/**
 * `seriesProbe` é o MODO AMOSTRA da Fase 8 (a passagem que a sonda de 40
 * mede). Ele NÃO é mais o portão da série: com a opção de séries do painel
 * ligada (`opts.series.enabled`, a mesma do Vaca e dos outros sites) a página de
 * temporada entra no motor normalmente. Mora aqui, e não em `CrawlPageOptions`,
 * porque aquele é o contrato COMPARTILHADO de todos os sites; `fetchWork` também
 * aceita a mesma flag por chamada (ver `probeRequested`) para quem só tem a
 * interface `CrawlSite`.
 */
export interface BludvCrawlOptions {
  seriesProbe?: boolean;
}

/**
 * Resultado da AMOSTRA de temporada: o contrato compartilhado não tem campo
 * para "quantos botões a página anunciava", e é o denominador que a sonda
 * precisa. Quem só enxerga `CrawlWorkResult` continua com o contrato base.
 */
export interface BludvSeasonSample extends CrawlWorkResult {
  /** Botões de torrent anunciados na página (o denominador). */
  buttons: number;
  /** Botões efetivamente lidos: aqui é o mesmo número, porque o magnet é
   *  direto no HTML (não há salto de protetor a seguir). */
  buttonsFollowed: number;
}

// `seriesProbe` por CHAMADA: o `CrawlPageOptions` compartilhado não tem o campo
// e não é meu para mudar — cast concentrado aqui, leitura por `=== true`.
function probeRequested(pageOpts?: CrawlPageOptions): boolean {
  return (pageOpts as { seriesProbe?: unknown } | undefined)?.seriesProbe === true;
}

/**
 * Fábrica do adaptador: recebe a superfície do resolver pronta (nos testes, a
 * instância real do profile com fetch dublê).
 */
export function createBludvCrawlSite(surface: BludvResolverSurface, options: BludvCrawlOptions = {}): CrawlSite {
  const seriesProbe = options.seriesProbe === true;

  /**
   * Página do SITE (host safety): loc de sitemap, loc de obra e URL de página
   * derivam de conteúdo do site — só hostname candidato serve como página. O
   * host rejeitado viaja no erro (diagnóstico do painel); o assert do resolver é
   * a segunda camada.
   */
  function assertSiteUrl(value: string): URL {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error('invalid_url'); }
    if (!surface.isDetailHost(parsed.hostname)) {
      throw new Error(`blocked_host:${parsed.hostname.toLowerCase()}`);
    }
    return surface.assertAllowedUrl(value);
  }

  /**
   * `fetchText` DO PROFILE com o custo da chamada contado, porque o BLUDV é o
   * ÚNICO dos sites que ainda não tem o `hooks.onRequest` no
   * `fetchText` (medido: aridade 2, contra 3 do RedeTorrent e 1+hook do
   * TorrentDosFilmes). Sem contar aqui o `requestCost` sai 0 — que é pior do que
   * um número errado: a rodada entraria de graça no teto por hora, e o teto é de
   * requisições.
   *
   * Contar a CHAMADA (e não o hop) é a mesma semântica que o hook do
   * RedeTorrent: uma chamada é um acesso, e o solve do FlareSolverr é o MESMO
   * acesso — a sessão que ele abre é a do `fetch` direto seguinte, então contá-lo
   * inflaria o teto com trabalho já feito. O que não cabe na chamada é o salto de
   * protetor, e esse fica no `fetchFollowingAllowed` (que aceita o hook e só o
   * dispara em fetch de verdade — medido: magnet direto não conta).
   */
  function countedFetchText(url: string, onRequest: () => void): Promise<string> {
    onRequest();
    return surface.fetchText(url);
  }

  return {
    id: SITE_ID,
    label: TRACKER_LABEL,

    // A descoberta mora em `bludv-discover.ts` (índice → `post-sitemap*` → URLs
    // com lastmod e tipo pelo slug): é a metade "para cima" do adaptador, e as
    // duas já não cabiam no mesmo arquivo. Ela é montada uma vez por instância
    // porque carrega o aviso de série e a política de falha que segura o cursor
    // do crawler.
    discover: createBludvDiscoverer(surface, seriesProbe),

    async fetchWork(url: string, pageOpts?: CrawlPageOptions): Promise<CrawlWorkResult> {
      const season = pageOpts?.kind === 'tv_show';
      if (season && !seriesProbe && !probeRequested(pageOpts) && pageOpts?.series?.enabled !== true) {
        // Séries desligadas: linha de temporada na fila (enfileirada com a opção
        // ligada) vira erro explicado, ZERO rede — a recusa é do portão, não do
        // site. Mesma trava dos outros três sites.
        const message = 'bludv-cardigann: página de temporada fora do motor (séries desligadas no painel)';
        log.warn(`[crawl] ${message}: ${url}`);
        return { url, status: 'error', error: message };
      }
      // Contador de requisições REAIS desta página (F3). O magnet é direto no
      // HTML, então o número medido hoje é 1 por página — mas ele é CONTADO:
      // se o site passar a publicar botão de protetor, o `follow` abaixo soma o
      // salto e o teto por hora continua recebendo o número certo.
      const counter = { n: 0 };
      const countRequest = () => { counter.n += 1; };
      try {
        // Defesa em profundidade: a fila nasce da nossa descoberta, mas o store
        // pode ter sido editado — host de fora é rejeitado na porta.
        const workUrl = assertSiteUrl(url);
        if (!isWorkPath(workUrl)) {
          throw new Error(`not_a_work_page:${workUrl.pathname.toLowerCase()}`);
        }
        if (!season && isSeasonSlug(workUrl)) {
          // Linha de QUEM não classificou por slug: gravar o pack de temporada
          // como filme é obra errada no acervo; recusar deixa a linha visível.
          const message = 'temporada_com_kind_movie: a página é de temporada (pack) e a fila a pediu como filme '
            + '(reprocessar/zera o site)';
          log.warn(`[crawl] bludv-cardigann: ${message}: ${url}`);
          return { url, status: 'error', error: message };
        }
        if (season && !isSeasonSlug(workUrl)) {
          // O inverso: a fila pediu série e a página é de filme. A descoberta
          // classifica pelo slug (única fonte de tipo — o `post-sitemap*` é
          // misto), então este caso só existe com o store editado; gravar o filme
          // na chave de série é a mesma obra errada, do outro lado.
          const message = 'filme_com_kind_tv_show: a página NÃO é de temporada (o slug não diz) e a fila a pediu como série '
            + '(reprocessar/zera o site)';
          log.warn(`[crawl] bludv-cardigann: ${message}: ${url}`);
          return { url, status: 'error', error: message };
        }
        // 1 REQUISIÇÃO: o HTML do post já carrega o magnet no bloco de download.
        const pageHtml = await countedFetchText(workUrl.href, countRequest);
        if (!season && postDeclaresSeries(pageHtml)) {
          // O slug não disse temporada, mas o post se declara série nas próprias
          // categorias ("Boneca Russa 1ª Temporada" em slug sem "temporada").
          // Identificar como filme casaria um homônimo no TMDB — obra ERRADA
          // no acervo; recusar deixa a linha visível no painel.
          const message = 'serie_com_kind_movie: o post está na categoria de séries e a fila o pediu como filme';
          log.warn(`[crawl] bludv-cardigann: ${message}: ${url}`);
          return { url, status: 'error', error: message, requestCost: counter.n };
        }
        const { title, year, raw } = workTitleYear(pageHtml);
        if (!title) {
          // Página sem nome é quebra de layout, não obra sem nome: erro para o
          // backoff do motor (e canário do painel), nunca release inventada.
          return { url, status: 'error', error: 'layout: página sem <h1> de título', requestCost: counter.n };
        }
        // tt ancorado no rótulo "IMDb" da ficha. A âncora é o que separa a
        // ficha de um widget de outro post colado (a armadilha medida no
        // ComandoTorrents); `null` devolve a identificação para título+ano, que
        // é o estado honesto — obra errada é pior que obra nenhuma.
        const imdb = parseImdbId(pageHtml);
        // O `parseDownloadLinks` do profile lê o magnet DIRETO e o `.torrent`
        // (que ele ignora: não é magnet nem protetor na allowlist). O `post`
        // resolve href relativo e é o que o card vivo entrega.
        const links = surface.parseDownloadLinks(pageHtml, workUrl.href);
        const type = season ? 'series' as const : 'movie' as const;
        if (!links.length) {
          // Post sem botão de torrent (só streaming, ou o `.torrent` morreu):
          // terminal, sem gastar rede de protetor.
          return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
        }
        // Na AMOSTRA o teto é o knob de série do motor (`CRAWL_SERIES_MAX_BUTTONS`):
        // página com muitos botões é a régua e um outlier não vira 200 requests.
        const maxButtons = Math.max(
          1,
          Math.trunc(Number(pageOpts?.series?.maxButtons ?? config.crawl.seriesMaxButtons) || config.crawl.seriesMaxButtons),
        );
        const announced = links.length;
        const planned = season ? links.slice(0, maxButtons) : links;
        if (planned.length < announced) {
          log.warn(`[crawl] bludv-cardigann: ${announced} botão(ões) na página de temporada, `
            + `seguindo ${planned.length} (teto de série)`);
        }
        const releases: RawItem[] = [];
        const seen = new Set<string>();
        for (const link of planned) {
          // O `follow` do núcleo devolve a URI sem gastar rede quando a entrada já
          // é `magnet:` (é o caso medido neste site: 13 botões em 12 posts, todos
          // direto), e conta o salto se um dia o site voltar a protetor. Por isso
          // ele é chamado SEMPRE: o `requestCost` sai certo nos dois caminhos sem
          // um `if` que só ficaria verdadeiro se o site fosse medido de novo.
          const finalHtml = await surface.fetchFollowingAllowed(link.url, workUrl.href, { onRequest: countRequest });
          const magnet = surface.extractMagnet(finalHtml);
          // Cadeia resolveu mas não há magnet: não inventa.
          if (!magnet) continue;
          const hash = magnetHash(magnet);
          if (hash && seen.has(hash)) continue;
          if (hash) seen.add(hash);
          releases.push({
            // `raw` é o `<h1>` CRU: é o que o `releaseTitle` do profile limpa, e
            // é byte a byte o `title=` do card de busca — a mesma régua que o
            // card vivo usa. Limpar aqui produziria uma segunda régua.
            title: surface.releaseTitle(raw, link),
            magnet,
            indexer: SITE_ID,
            tracker: TRACKER_LABEL,
            // Origem BR é campo do provider. Fonte BR não publica swarm; 1
            // sobrevive ao MIN_SEEDERS.
            isBr: true,
            seeders: 1,
            size: surface.parseSize(link.size) ?? undefined,
          });
        }
        if (!releases.length) {
          // Todos os botões terminais → sem torrent publicável neste post. Estado
          // terminal, e é o honesto: nada a esperar desta URL.
          return { url, status: 'no-torrent', imdb, title, year, type, requestCost: counter.n };
        }
        // A ficha publica o título original; o helper do site lê as DUAS formas
        // que o BLUDV usa. É o 2º nome da identificação quando o `<h1>` não casa
        // ninguém no TMDB.
        const originalTitle = parseOriginalTitle(pageHtml);
        if (season) {
          // Série: o post declara UMA temporada (o `<h1>` e o `dn=` concordam), e
          // a locação sai da mesma régua do Vaca, com a temporada da página como
          // base e o `dn` de cada botão decidindo o resto. `buttons`/
          // `buttonsFollowed` são o denominador da sonda.
          const pageSeason = pageSeasonOf(raw, workUrl.href);
          const sample: BludvSeasonSample = {
            url, status: 'done', imdb, title, year, originalTitle, season: pageSeason, type, releases,
            groups: seasonPageGroups(releases, { season: pageSeason, title: raw }),
            requestCost: counter.n, buttons: announced, buttonsFollowed: releases.length,
          };
          return sample;
        }
        return { url, status: 'done', imdb, title, year, originalTitle, type, releases, requestCost: counter.n };
      } catch (err) {
        // F1: throw NÃO perde o custo medido (F3).
        throw withRequestCost(err, counter.n);
      }
    },
  };
}

/**
 * Instância de produção: reusa o resolver `bludv` JÁ CARREGADO no processo
 * (mesmo seletor de domínio, mesma sessão de FlareSolverr, mesmos caches). É
 * este export que o registry chama, e ele NUNCA liga `seriesProbe`: em produção
 * a série entra pela opção de séries do painel (`opts.series.enabled`).
 */
export function bludvCrawlSite(): CrawlSite {
  const surface = instance(RESOLVER_NAME) as BludvResolverSurface | null;
  if (!surface || typeof surface.fetchText !== 'function') {
    throw new Error('bludv-cardigann: resolvedor embutido não carregado — raspagem indisponível');
  }
  return createBludvCrawlSite(surface);
}
