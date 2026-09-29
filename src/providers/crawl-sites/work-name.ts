// Régua do NOME DA OBRA no `<h1>` dos WordPress BR da mesma rede —
// TorrentDosFilmes e ComandoTorrents publicam o título no mesmo molde ("Nome
// Torrent (2016) BluRay 720p e 1080p Dual Áudio – Download"). Nasceu no
// `torrentdosfilmes-discovery.ts` e foi extraída quando o ComandoTorrents se
// mostrou o segundo consumidor: com o `cleanPostTitle` do resolver (a régua do
// TÍTULO DA RELEASE, que também serve a busca viva) sobravam "– GDRIVE",
// " e" órfão e "/ Legendas Fixas em Português" no nome, e a página ia para
// `no-work` (medido na raspagem real, 2026-09-28). Duas cópias da régua
// divergiriam em silêncio.
//
// O que é daqui: tirar do `<h1>` o que é VITRINE (fonte, qualidade, áudio,
// canais, "Torrent", temporada) e devolver o nome que o TMDB conhece. O ano é
// de quem chama (parêntese no `<h1>`, ficha da página). Em caso de dúvida a
// régua erra para o lado de NÃO achar nome: título demais que sobrou vira
// `nome-sem-casamento` no TMDB e nunca obra errada gravada.
import { decodeEntities } from '../../utils/title-normalization.js';

/** Ano em parênteses, em qualquer posição do título (o site o põe no meio). */
export const YEAR_PAREN_RE = /[（(]\s*((?:19|20)\d{2})\s*[)）]/;

// Um ordinal ("1ª", "2º", "7°", "3a") e a versão sem marca ("2"). O `°` é o
// sinal de GRAU que o site usa quando não tem "ª" ("The Big Bang Theory 9°
// Temporada"); `a`/`o` cobrem a grafia por letra.
const ORDINAL_MARKED = String.raw`\d{1,2}\s*[ªºa°]`;
const ORDINAL = String.raw`\d{1,2}\s*[ªºa°]?`;
/**
 * Entre dois ordinais da MESMA lista: espaço, vírgula, hífen, e o conector —
 * que é a palavra de UNION ("1ª e 2ª") ou a de FAIXA ("1ª à 11ª", forma
 * DOMINANTE nas páginas que publicam a série inteira; medida ao vivo em
 * 2026-09-29 em "The Walking Dead 1ª à 11ª Temporada" e "Os Simpsons 1ª à 33ª
 * Temporada", que sem isso ficavam com o "1ª à" no nome e o TMDB não achava
 * nada). O BLUDV escreve a faixa com AGUDO ("Homeland: Segurança Nacional 1ª á
 * 8ª Temporada"), e sem o `á` sobrava o "1ª á" no nome. O conector só é gasto se o que vem DEPOIS dele for outro ordinal: a
 * lista é uma sequência, nunca um nome.
 */
const ORDINAL_SEP = String.raw`\s*(?:[,&]\s*)?(?:[-–—]\s*)?(?:(?:até|ate|à|á|a|e)\s+)?`;

/** Ruído de VITRINE que o theme gruda no título, na ordem em que aparece.
 *  Cada entrada existe porque está no acervo real medido (a lista de tokens do
 *  slug do TorrentDosFilmes dá a frequência: `torrent` 435, `bluray` 351,
 *  `download` 338, `720p` 304, `dublado` 271, `1080p` 258, `dual`+`audio` 214,
 *  `legendado` 119…). NADA aqui é removido do título da RELEASE — o
 *  `releaseTitle` do profile limpa o que é vitrine; aqui a régua é o NOME. */
const NOISE_RES: readonly RegExp[] = [
  // 1. Temporada: é estrutura de release, não nome de obra. Apaga a LISTA
  //    INTEIRA de ordinais, não um deles: o post que publica a série inteira
  //    escreve "1ª e 2ª Temporada" ("Superman & Lois"), "1ª 2ª 3ª 4ª 5ª 6ª
  //    Temporada" ("Community"), "1ª, 2ª e 3ª Temporada" ("The Sinner") e
  //    "1ª à 33ª Temporada" ("Os Simpsons") — a forma anterior apagava UM
  //    ordinal e deixava a lista (ou a faixa) no nome, que o TMDB não resolve.
  //    O PRIMEIRO ordinal da lista só vale sozinho se tem marca: sem ela o
  //    número é parte do nome ("Stranger Things: Histórias de 85 1ª e 2ª
  //    Temporada" — o "85" é da obra e a lista começa no "1ª"; "Agente 007 1ª
  //    Temporada").
  //    A palavra SOZINHA, sem ordinal, só sai como "Temporada Completa"/"Todas
  //    as Temporadas": "Temporada" é nome de FILME ("Temporada de Caça", 2006;
  //    "Temporada de Patos") e virava "de Caça", sem obra no TMDB. O "as" de
  //    "Todas as Temporadas" é opcional: o BLUDV escreve "Elite Histórias
  //    Breves Todas Temporadas", e o "Todas Temporadas" ficava no nome.
  new RegExp(
    String.raw`\b(?:(?:(?:${ORDINAL_MARKED}${ORDINAL_SEP}(?:${ORDINAL}${ORDINAL_SEP})*)|\d{1,2}\s*[ªºa°]?\s*)`
    + String.raw`temporadas?(?:\s+(?:complet[ao]s?|inteiras?))?`
    + String.raw`|todas\s+(?:as\s+)?temporadas(?:\s+(?:complet[ao]s?|inteiras?))?`
    + String.raw`|temporadas?\s+(?:complet[ao]s?|inteiras?))`,
    'gi',
  ),
  /\bmini\s*s[ée]ries?\b/gi,
  // Faixa de ANOS entre parênteses ("Homeland … (2011-2020)", BLUDV): é o
  // período da série publicada inteira, nunca nome. O ano da página sai da
  // ficha; sem esta regra sobrava "(2011 2020)" no nome.
  /\(\s*(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}\s*\)/g,
  /\b\d{1,3}\s+epis[óo]dios\b/gi,
  // 2. Fonte e codec. "3D" e "HSBS" SOZINHOS não entram: "Sea Rex 3D: Journey to
  //    a Prehistoric World" só casa no TMDB com o 3D no nome. O PAR "3D HSBS"
  //    (formato do arquivo: half side-by-side, over-under) sai inteiro — "007
  //    Contra o Satânico Dr. No – BluRay 3D HSBS (1962)" ia para `no-work`.
  //    `rip` em minúscula também não: no `<h1>` ele só aparece dentro de
  //    "WebRip"/"BRRip", que a regra já pega — e é por isso que `Rip` MAIÚSCULO
  //    é regra separada (abaixo). "DVD-R Oficial" é o disco, não o nome.
  /\b(?:blu[\s-]?ray|bd[\s-]?rip|br[\s-]?rip|web[\s-]?dl|web[\s-]?rip|dvd[\s-]?rip|dvd[\s-]?scr|webcam|hdtv|hd[\s-]?ts|cam[\s-]?rip|remux)\b/gi,
  /\b3d\s*[-–]?\s*(?:half[\s-]?)?(?:h[\s-]?sbs|sbs|h?[\s-]?ou|tab)\b/gi,
  /\bdvd[\s-]?r\b(?:\s+oficial)?/gi,
  // 3. Canais de áudio ("5.1", "5.1CH", "6ch", "2.0") e marcas de faixa.
  /\b\d[\s.,]?\d?\s*(?:ch|canais?)\b/gi,
  /\b(?:5\.1|7\.1|7\.2|2\.0|ddp|atmos)\b/gi,
  // 4. Legenda fixa ("O Regresso / Legendas Fixas em Português", Comando): a
  //    frase inteira, antes da regra de palavra solta, que só tira "legenda".
  /(?:^|\s)legendas?\s+(?:fixas|embutidas)(?:\s+em\s+portugu[eê]s)?/gi,
  // 5. Áudio e idioma. `Dual` sozinho e `Nacional` são rótulo do arquivo, não
  //    nome de obra. `original` NÃO entra (sozinho ele é nome: "Original Sin"),
  //    e o `áudio original` cai no `áudio` logo abaixo. A borda é ESPAÇO/PONTUAÇÃO
  //    explícita, e não `\b`: em JavaScript `\b` é definido por `[A-Za-z0-9_]`, e
  //    acento não é caractere de palavra — `\b[aá]udio` nunca casaria em
  //    "Dual Áudio" (borda espaço/letra acentuada não é transição), que é
  //    exatamente a forma que o site publica. "Aúdio" (acento trocado) é grafia
  //    real do site ("Quebrando Regras Torrent – Bluray 720p Dual Aúdio (2008)").
  /(?:^|[-\s([/|—–])(?:dublad[oa]s?|legendad[oa]s?|dual|multi\s*[aá][uú]dio|[aá][uú]dio|legenda|embutida|nacional)(?=$|[-)\s\]/|—–.,;:!])/gi,
  // 6. Vitrine: o que o site oferece, não o que a obra é. Só as formas do
  //    acervo medido — `mirrors`/`links` saem de propósito ("Mirrors" é filme).
  /\b(?:torrents?|download|baixar|gr[aá]tis|online|assistir|completo|completa|mega|gdrive)\b/gi,
  // 7. Qualidade e container soltos ("1080p", "4K", "FULL HD", "HD").
  /\b(?:full\s*hd|ultra\s*hd|\d{3,4}\s*[pi]|\b4k\b|\b8k\b|\bhd\b|\bsd\b)\b/gi,
];
/**
 * Ruído que o site publica em CAIXA ALTA e que também é palavra de nome: vai
 * numa lista separada, SEM a flag `i`, porque é exatamente a caixa que
 * denuncia a vitrine. Medido em 2026-09-28 na sonda de 40 (cada entrada
 * citando o `<h1>` real que vazava e ia para `no-work`):
 *
 *   "Deadpool Torrent – Bluray Rip 720p | 1080p Legendado Download (2016)"
 *   "Contra o Tempo Torrent – BluRay Rip 720p e 1080p Dual Áudio 5.1 (2011)"
 *   "Arábia Torrent (2018) Nacional WEB-DL 1080p FULL Download"
 *
 * `Rip` e `FULL` saem; "Mirrors" e "Full Metal Jacket" (com a caixa do nome)
 * continuam de pé, que é o motivo de esta lista não usar `\b`-insensível.
 */
const NOISE_CAPS_RES: readonly RegExp[] = [/\bRip\b/g, /\bFULL\b/g];
/**
 * Conector órfão no FIM do nome: o site escreve "… 720p e 1080p" e "Dublado e
 * Legendado", e as regras de qualidade/áudio apagam os dois vizinhos, deixando
 * o "e" grudado no nome ("Introspectum Motel e", "Contra o Tempo e"). Só o
 * "e" FINAL sai: um nome português que termine na conjunção "e" não existe, e
 * "Deuses e Monstros" (o "e" no meio) nunca é tocado.
 */
const TRAILING_CONNECTOR_RE = /\s+e$/i;
/**
 * Separador órfão que sobra da limpeza. O `+` no grupo de repetição era um
 * erro: exigia DOIS separadores seguidos, e a forma DOMINANTE do site é o
 * separador ÚNICO cercado de espaço ("… – Bluray", "5.1 / Dublado", "… –"),
 * que ficava no nome ("Deadpool – Rip", "Noturno / FULL"). O `:` fica DE
 * FORA de propósito: ele é separador de NOME ("Sea Rex 3D: Journey to a
 * Prehistoric World", "Chainsaw Man – O Filme: Arco da Reze"), e a régua não
 * tem nenhum ganho medido em removê-lo.
 *
 * O `&` também fica DE FORA, pelo mesmo motivo do `:`: ele é parte de nome de
 * obra, não conector de vitrine — e a régua perdia o nome real
 * ("Superman & Lois" → "Superman Lois", medido em 2026-09-29). Um `&` que for
 * mesmo resíduo continua saindo pelo `EDGE_SEP_RE` das bordas ("Dublado &
 * Legendado 1080p" → "Dublado Legendado"), e o `normalizeTitle` da
 * identificação já reduz "&" e espaço ao mesmo token, então a busca no TMDB é
 * a mesma com ou sem ele.
 *
 * A classe põe o hífen PRIMEIRO de propósito: `–-` seria intervalo de caractere
 * invertido e a regex nem compila.
 */
const ORPHAN_SEP_RE = /\s*[-–—/|+]\s*(?:[-–—/|+]\s*)*/g;
// Borda do nome: separador que sobrou grudo no começo/fim. O `&` CONTINUA aqui
// mesmo tendo saído do `ORPHAN_SEP_RE` — é o que limpa o "&" órfão que a
// vitrine deixou ("Dublado & Legendado 1080p" → "Dublado Legendado").
const EDGE_SEP_RE = /^[–\-—/|:&+\s]+|[–\-—/|:&+\s]+$/g;

/** O que o `<h1>` diz, já decodificado e colapsado (comentário/script fora). */
export function h1Text(html: string): string {
  const source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(source)?.[1] ?? '';
  return decodeEntities(h1.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** O `<h1>` sem o parêntese do ano: o ano e o nome sem ele. */
export function splitParenYear(raw: string): { rest: string; year: number | null } {
  const match = YEAR_PAREN_RE.exec(raw);
  if (!match) return { rest: raw, year: null };
  return {
    rest: `${raw.slice(0, match.index)} ${raw.slice(match.index + match[0].length)}`,
    year: Number(match[1]),
  };
}

/**
 * Ano DECLARADO na ficha da página ("<b>Lançamento:</b> <a>2021</a>", "<b>Ano
 * de Lançamento:</b> 2017 (Brasil)"). Fallback de quem chama quando o `<h1>` não
 * traz o ano entre parênteses — "As Cores do Amor Torrent – WEB-DL 1080p Dual
 * Áudio" e "Comando Final 3 – Paradox 2018 Torrent" iam para `pagina-sem-ano`
 * com o ano escrito na ficha (medido, 2026-09-28). É campo rotulado pelo site,
 * a mesma confiança do parêntese; o ano SOLTO no título continua não valendo
 * ("Blade Runner 2049"). O rótulo precisa vir logo antes do número (só tags,
 * espaço e `:` no meio): "lançamento" na sinopse não é ficha.
 */
export function fichaYear(html: string): number | null {
  const match = FICHA_YEAR_RE.exec(String(html || ''));
  return match ? Number(match[1]) : null;
}

// `em`/`i` porque o BLUDV escreve "<strong><em>Lançamento:</em></strong> 2022":
// sem eles o ano da ficha não era lido e a página ia para `pagina-sem-ano`
// (medido em 2026-09-29: 39 de 80 páginas do BLUDV só têm o ano ali). `option`
// NÃO entra: o menu do site lista "<option>Lançamento</option><option>1918",
// que não é ficha.
const FICHA_TAG = String.raw`(?:<\/?(?:b|strong|span|a|em|i)\b[^>]*>\s*)*`;
const FICHA_YEAR_RE = new RegExp(
  String.raw`(?:Ano\s+de\s+)?Lan(?:[çc]|&ccedil;)amento\s*${FICHA_TAG}:?\s*${FICHA_TAG}((?:19|20)\d{2})\b`,
  'i',
);

/**
 * Leitura completa do `<h1>`: nome, ano (parêntese; sem ele, a ficha) e o texto
 * cru. Quando o nome TERMINA no ano declarado ("Comando Final 3 – Paradox 2018
 * Torrent" com a ficha em 2018), o número sai — ele é o ano da página, não parte
 * do nome. Só quando sobra nome antes dele: "1984 (1984)" continua "1984", e um
 * número diferente do ano ("Blade Runner 2049" de 2017) nunca é tocado.
 */
export function readWorkTitle(html: string): { title: string; year: number | null; raw: string } {
  const raw = h1Text(html);
  const split = splitParenYear(raw);
  const year = split.year ?? fichaYear(html);
  let title = cleanWorkName(split.rest);
  if (year != null) {
    const trimmed = title.replace(new RegExp(String.raw`\s+${year}$`), '').trim();
    if (trimmed) title = trimmed;
  }
  return { title, year, raw };
}

/** Nome da obra: o texto (já sem o ano) com a vitrine fora. */
export function cleanWorkName(text: string): string {
  let title = String(text || '');
  for (const re of NOISE_RES) title = title.replace(re, ' ');
  for (const re of NOISE_CAPS_RES) title = title.replace(re, ' ');
  // O colapso de espaço vem ANTES das regras de borda: a limpeza deixa cauda de
  // espaços ("Contra o Tempo e   "), e `\s+e$` não casaria com "e" seguido de
  // espaço. Depois das bordas, colapsa de novo (o `trim` do conector abre espaço).
  title = title.replace(ORPHAN_SEP_RE, ' ').replace(/\s+/g, ' ').trim();
  return title.replace(TRAILING_CONNECTOR_RE, '').trim().replace(EDGE_SEP_RE, '').replace(/\s+/g, ' ').trim();
}
