import {
  EPISODE_TOKEN,
  LEADING_ARTICLES,
  PACK_WORDS,
  RELEASE_NOISE,
  STOP_AT,
  STRONG_PACK_WORDS,
  NUMERAL_CANON,
  SEQUENCE_WORDS,
  titleTokens,
} from './matching-vocabulary.js';

// Leitura estrutural de tokens: o que é sequência, o que é sobra fora da
// busca, qual trecho nomeia a obra numa release por episódio, se o ano
// contradiz o catálogo. Nada aqui decide relevância sozinho — são as métricas
// puras que `release-title-rules.ts` compõe nos portões matchesName /
// matchesBrTitle / matchesTitleStructure.

/**
 * Números de SEQUÊNCIA (sequel/parte) na parte limpa do título — lógica do
 * pacote BRDUB. "Deadpool" casa "Deadpool 2" em 100% (todos os tokens da busca
 * estão lá) e o ano só denuncia quando a sequência é distante: "Deadpool 2"
 * (2018) contra catálogo 2016 cabia na tolerância de ±2 e entrava na lista.
 *
 * Duas diferenças em relação ao BRDUB, porque aqui o texto é o título da
 * RELEASE (com tags) e não o do post:
 * - a varredura para no ANO além do ruído: "Coringa (2020) 5.1 BluRay" vira
 *   "coringa 2020 5 1 bluray", e sem parar no ano o "5 1" do canal de áudio
 *   viraria sequência 5, matando a release legítima;
 * - o 1 não conta: ele aparece em canal de áudio e em "Parte 1" da obra base,
 *   onde a busca não o traz — barraria o que deveria passar.
 *
 * Sequência também vem batizada, sem número nenhum ("… Ressurge", "… Rises"):
 * as palavras de SEQUENCE_WORDS entram no mesmo conjunto, como string. Quem
 * compara os marcadores (`matchesTitleStructure`) só pergunta se o conjunto do
 * candidato cabe no da busca, então número e palavra convivem sem caso
 * especial — e a palavra que já está no nome procurado ("A Origem") aparece
 * dos dois lados e continua passando.
 */
function extractSequenceMarkers(text: string) {
  const markers = new Set<number | string>();
  for (const raw of titleTokens(text)) {
    if (!raw) continue;
    // A varredura para no ano/ruído de release: o que vem depois
    // ("5.1 Dublado", "2017") não é parte do nome da obra.
    if (/^(?:19|20)\d{2}$/.test(raw)) break;
    if (STOP_AT.has(raw)) break;
    let marker: number | string | null = null;
    // Sequência batizada por palavra ("Ressurge", "Rises") — ver
    // SEQUENCE_WORDS em matching-vocabulary.ts.
    if (SEQUENCE_WORDS.has(raw)) marker = raw;
    else {
      // Sufixo "Nu" de sequência: "Happy Death Day 2U" é a continuação (o
      // "U" é o "you" da cola do título), e sem reconhecer o marcador a
      // dupla direção da matchesTitleStructure nunca engaja no caminho EN.
      // Limpo em 2..19 para não ler leetspeak agressivo.
      const u = /^([2-9]|1[0-9])u$/i.exec(raw);
      const n = u ? Number(u[1]) : /^\d+$/.test(raw) ? Number(raw) : NUMERAL_CANON[raw];
      if (n >= 2 && n <= 19) marker = n;
    }
    if (marker !== null) markers.add(marker);
  }
  return markers;
}

/**
 * Quanto do título do candidato está DENTRO da busca, ignorando ruído de
 * release, empacotamento e ano. 1 = o título não acrescenta nada; perto de 0 =
 * é outra obra que só começa com o mesmo nome.
 */
function titlePrecision(tokens: string[], wanted: Iterable<string>) {
  const want = new Set(wanted);
  const significant = tokens.filter(
    (w) =>
      !RELEASE_NOISE.has(w) &&
      !PACK_WORDS.has(w) &&
      // STRONG_PACK_WORDS ("filmografia", "colecao", "trilogia", …) descreve
      // EMPACOTAMENTO, não um nome de obra — "FILMOGRAFIA COMPLETA <Série>"
      // é a mesma obra em pack, e sem este filtro "filmografia" contava como
      // token fora do universo e derrubava a precisão de um pack legítimo.
      !STRONG_PACK_WORDS.has(w) &&
      !EPISODE_TOKEN.test(w) &&
      !/^\d+$/.test(w), // número solto é temporada, ano ou tamanho
  );
  // Título que só tem ruído não contradiz nada.
  if (significant.length === 0) return 1;
  return significant.filter((w) => want.has(w)).length / significant.length;
}

/**
 * Trecho que nomeia a OBRA numa release por episódio. O nome do episódio vem
 * depois de SxxEyy e não pode contar como obra estranha; no formato inverso do
 * RedeTorrent, o marcador vem antes do nome e costuma se repetir depois dele.
 */
function episodeWorkTokens(tokens: string[]) {
  const markers: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (
      /^(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})$/.test(tokens[i]) ||
      (/^t\d{1,2}$/.test(tokens[i]) && /^e\d{1,3}$/.test(tokens[i + 1] || ''))
    ) markers.push(i);
  }
  if (!markers.length) return null;
  if (markers[0] > 0) return tokens.slice(0, markers[0]);
  let end = markers.length > 1 ? markers[1] : tokens.length;
  // Com um único marcador à esquerda, o grupo da release vem depois do nome:
  // "S01E02 From 1080p WEBRip x264-EVOLVE". Parar no primeiro ruído técnico
  // mantém "From" como obra sem aceitar "Rick and Morty The Anime" — nesse
  // caso os tokens extras ficam antes de 1080p e continuam sendo medidos.
  if (markers.length === 1) {
    const noiseAt = tokens.findIndex((token: string, index: number) => index > 0 && STOP_AT.has(token));
    if (noiseAt > 0) end = noiseAt;
  }
  return tokens.slice(1, end);
}

/**
 * O ano do título contradiz o ano do catálogo? Definição ÚNICA da regra de
 * ano, com tolerância por tipo (mesma lógica do pacote BRDUB, calibrada
 * contra casos reais): filme aceita ±2 — o ano do post BR costuma ser o do
 * lançamento nacional — e condena com um ÚNICO ano contraditório; série só
 * condena quando TODOS os anos do título são anteriores à estreia −2, porque
 * o ano do post de série é o da temporada ("Fallout 2ª Temporada (2025)"
 * contra catálogo 2024 passa). Dois ou mais anos em FILME deixam o campo
 * ambíguo ("Blade Runner 2049 (2017)") e a checagem é pulada; em série
 * basta um ano recente para liberar. Sem ano no catálogo nada é cortado.
 */
function yearContradicts(tokens: string[], year: number | string | null, isSeries: boolean) {
  const catalogYear = Number(String(year || '').match(/(?:19|20)\d{2}/)?.[0] || 0);
  if (!catalogYear) return false;
  const years = tokens.filter((t) => /^(?:19|20)\d{2}$/.test(t)).map(Number);
  if (isSeries) return years.length > 0 && years.every((y) => y < catalogYear - 2);
  return years.length === 1 && Math.abs(years[0] - catalogYear) > 2;
}

// Primeiro token relevante do título: pula ruído curto, artigo, empacotamento
// e marcador de episódio. Cai no primeiro token quando nada sobrevive — a
// regra de prefixo precisa de UM ponto de comparação dos dois lados.
function firstSignificantToken(arr: string[]): string | undefined {
  return arr.find(
    (w) =>
      w.length > 2 &&
      !LEADING_ARTICLES.has(w) &&
      !PACK_WORDS.has(w) &&
      !EPISODE_TOKEN.test(w),
  ) || arr[0];
}

export {
  extractSequenceMarkers,
  titlePrecision,
  episodeWorkTokens,
  yearContradicts,
  firstSignificantToken,
};
