// Núcleo PURO compartilhado pelos adaptadores de site do crawler
// (`crawl-sites/*`). Nasceu quando o NerdFilmes passou a ser o SEGUNDO
// consumidor real de três regras que não podem divergir entre sites:
//
//   - `parseTitleYear`: o `<h1>` da obra alimenta a identificação por
//     título/ano (Fase 2). Duas cópias divergiriam em silêncio — a sonda,
//     o `crawl-page` e o painel classify a página com a MESMA régua;
//   - `magnetHash`: o mesmo torrent em dois botões é um item só (dedupe);
//   - `withRequestCost`: erro que carrega o custo medido (F1) — o motor cobra
//     o que foi gasto antes de falhar, não 1 por página.
//
// O que NÃO mora aqui é o que é REGRA DE SITE: o recorte de URL de obra, o
// nome do sitemap (`movie-sitemap*` do Vaca contra `post-sitemap*` do
// NerdFilmes), oIMDb ancorado na ficha técnica e a lista de protetores. Isso
// fica no adaptador de cada um — duas cópias divergentes de `parseImdbId` já
// custaram uma obra errada no acervo.
import { decodeEntities } from '../../utils/title-normalization.js';

/**
 * Título e ano do `<h1>` da obra ("Expresso do Amanhã (2013)", "Bancários
 * (2020)"). O WordPress devolve o título com entidade crua ("A Gangster&#8217;s
 * Life", "Mike &#038; Nick"): decodificar ANTES de tudo — a query do TMDB não
 * encontra a obra com "&#8217;" no meio e o título herdado pelas releases
 * carregaria o lixo (medido ao vivo na sonda: 2 de 30 páginas sem IMDb perdiam
 * a identificação só por isso).
 *
 * Comentário, `<script>` e `<style>` saem ANTES do casamento: o `<h1>` do
 * theme não precisa ser o PRIMEIRO literal da página, e WordPress Full
 * Coverage / plugins deixam marcação comentada — um `<!-- <h1>…</h1> -->`
 * no topo do HTML fazia o título virar lixo com o ano certo grudado no fim
 * (achado no recorte de fixture do NerdFilmes, 2026-09-28). Sem o ano do
 * bracket, o `<h1>` real entra; com ele, o título fica como o site publica.
 *
 * Só o parêntese FINAL vira ano: post com ano no meio ("1ª Temporada (2022)
 * WEB-DL") fica sem ano, e sem ano a identificação não roda (a trava é de
 * segurança — sem ano não há com que discriminar homônimo de qualquer época).
 */
export function parseTitleYear(html: string): { title: string; year: number | null } {
  const source = withoutNoise(html);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] ?? '';
  const text = decodeEntities(h1.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const yearMatch = /\((\d{4})\)\s*$/.exec(text);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const title = (yearMatch ? text.slice(0, yearMatch.index) : text).replace(/\s+/g, ' ').trim();
  return { title, year: year && year >= 1900 && year <= 2100 ? year : null };
}

/** Comentário, `<script>` e `<style>` fora (ver `parseTitleYear`). */
function withoutNoise(html: string): string {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

/**
 * Título ORIGINAL que o post publica sob o `<h1>` (`<span class="movie-original">
 * Título original: 7 كلاب</span>`, NerdFilmes). É o segundo nome da
 * identificação: o site titula em inglês ou num pt-BR que o TMDB não tem
 * ("7 Dogs", "A Armadilha do Coelho"), e o original casa o `original_title`
 * do TMDB. Medido em 2026-09-28: 6 de 11 páginas "sem obra" traziam o
 * original certo. Ausente (o Vaca não publica) = `null`, e a identificação
 * segue só com o `<h1>`, como antes. É dado AUXILIAR: a ficha pode estar errada
 * (post que junta dois filmes) e por isso nunca decide sozinho — só casa pela
 * mesma régua estrita + ano da página.
 */
export function parseOriginalTitle(html: string): string | null {
  const source = withoutNoise(html);
  const span = /<span[^>]*class="[^"]*\bmovie-original\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(source)?.[1];
  // Sem o span, a FICHA dos WordPress BR (ComandoTorrents, TorrentDosFilmes):
  // `<b>Título Original:</b> Dr. No<br />` — com ou sem acento, com o `:`
  // dentro ou fora do negrito. O valor acaba na primeira tag.
  const raw = span ?? FICHA_ORIGINAL_RE.exec(source)?.[1];
  if (!raw) return null;
  const text = decodeEntities(raw.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^t[íi]tulo original\s*:?\s*/i, '')
    .trim();
  // Dois nomes ("Paradox / Sha po lang: taam long", "Dans la brume / Just a
  // Breath Away") não dizem QUAL é o original: no primeiro o inglês vem antes, e
  // "Paradox" casou outro filme ("Paradoxo", 2018) no lugar do "Comando Final 3:
  // Paradoxo" de Hong Kong (medido, 2026-09-28). Na dúvida, nome nenhum.
  if (text.includes(' / ')) return null;
  // O site repete a ficha no `alt` de uma imagem, SEM as quebras: o valor vinha
  // colado no rótulo seguinte ("The SimpsonsLançamento: 1989Gênero: …", "Small Axe
  // IMDb: 7,8/10 Ano de…", medido 2026-09-28). Corta no primeiro rótulo de ficha.
  const name = text.replace(FICHA_NEXT_LABEL_RE, '').trim();
  // Teto de sanidade: span que engoliu marcação quebrada não vira nome de obra.
  return name && name.length <= 200 ? name : null;
}

// Rótulo de ficha seguido de `:` (com o "S06" de "Lançamento S06:"). Sem borda de palavra
// na frente de propósito: no `alt` o rótulo vem COLADO no nome ("SimpsonsLançamento").
const FICHA_NEXT_LABEL_RE = /\s*(?:IMDb|(?:Ano\s+de\s+)?Lan(?:[çc]|&ccedil;)amento|G[êe]nero|Formato|Qualidade|Idioma|[ÁA]udio|Legenda|Tamanho|Dura[çc][ãa]o)\s*(?:S\d+\s*)?:.*$/i;
// O valor para na tag OU na aspa: dentro de um atributo (`alt="…"`) a aspa é o fim.
const FICHA_ORIGINAL_RE = /T(?:[íi]|&iacute;|&#237;)tulo\s+Original\s*(?:<\/?(?:b|strong|span)\b[^>]*>\s*)*:?\s*(?:<\/?(?:b|strong|span)\b[^>]*>\s*)*([^<"]{1,200})/i;

/** btih do magnet (40 hex ou 32 base32, qualquer caixa). `null` sem hash. */
export function magnetHash(magnet: string): string | null {
  return /xt=urn:btih:([a-z0-9]{32,40})/i.exec(magnet)?.[1]?.toLowerCase() ?? null;
}

/**
 * Anexa o custo medido ao erro (F1): a exceção sobe com `requestCost` e o
 * `crawl-page` repassa ao motor — página que falhou no 4º hop custa 4, não 1.
 * Erro alheio (não-`Error`) é embrulhado; o original vai na mensagem.
 */
export function withRequestCost(err: unknown, cost: number): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  (e as Error & { requestCost?: number }).requestCost = cost;
  return e;
}
