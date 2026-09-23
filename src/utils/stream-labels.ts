/**
 * Rótulos da coluna estreita do Stremio. Extraído de `audio-quality.ts` pela
 * catraca de 400 linhas para dar lugar ao termo fraco do overlay Jev
 * (`weakGenericDubOnly`): é o bloco mais autocontido de lá — só formata texto,
 * não conhece áudio, credencial nem config.
 */

const TRACKER_LABEL_MAX = 14;

/**
 * Nome da fonte para a coluna estreita: o TLD não ajuda a reconhecer o site e,
 * passando de TRACKER_LABEL_MAX, o rótulo empurra o seeder para fora.
 *
 * A escada existe porque cortar seco parte a palavra no meio ("kickasstorrents"
 * virava "kickasstorrent"), e nome truncado assim é pior que nome curto: o
 * usuário lê como se fosse outra fonte.
 */
function compactTracker(tracker = '') {
  let label = String(tracker).trim().replace(/(?:\.[a-z]{2,})+$/i, '');
  if (label.length <= TRACKER_LABEL_MAX) return label;

  // Todos esses sites repetem "torrent(s)" no nome — é a parte que menos
  // identifica ("ComandoTorrents" → "Comando", como o Torrentio exibe).
  const withoutSuffix = label.replace(/[\s_-]*torrents?$/i, '');
  if (withoutSuffix.length >= 4) label = withoutSuffix;
  if (label.length <= TRACKER_LABEL_MAX) return label;

  // Última fronteira que ainda cabe: separador ou transição camelCase
  // ("NerdFilmesTorrent" → "NerdFilmes"). Sobrando menos de 4 chars o corte
  // não identifica mais nada, e aí o corte seco é menos ruim.
  const window = label.slice(0, TRACKER_LABEL_MAX + 1);
  const boundaries = [...window.matchAll(/[\s_-]+|(?<=[a-z0-9])(?=[A-Z])/g)]
    .map((m) => m.index)
    .filter((index) => index >= 4);
  if (boundaries.length) return label.slice(0, boundaries[boundaries.length - 1]);

  return label.slice(0, TRACKER_LABEL_MAX);
}

export { compactTracker, TRACKER_LABEL_MAX };
