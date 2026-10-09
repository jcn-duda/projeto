// Remontagem do nome do vencedor do dedupe (herança BR/áudio/fonte).
// Extraído de `stream-ranking.ts` pelo orçamento de 400 linhas.
import { audioFromTitle, sourceFromTitle, editionFromTitle } from './audio-quality.js';
import { streamDisplayName } from './search-names.js';

/**
 * Reescreve a linha do vencedor BR quando o perdedor traz metadados melhores.
 * Origem e áudio pertencem ao post vencedor; só o post BR pode aproveitar o
 * título scene do perdedor, porque ele costuma ser esparso nesses campos.
 *
 * Fonte e corte saem do mesmo texto, pela mesma razão do áudio: reconstruir sem
 * eles apagava o "BluRay"/"Extended" que o rótulo já mostrava, e duas releases
 * do mesmo filme voltavam a ficar indistinguíveis depois do merge. Vale nos
 * dois modos: em `full` o texto é a release, em `compact` é o resumo — que
 * carrega os mesmos termos.
 */
export function relabel(stream: any, { isBr, dubbedFrom }: { isBr?: boolean; dubbedFrom?: any }) {
  const [title = '', stats = ''] = String(stream.name || '').split('\n');
  const seeders = Number(String(stats).match(/👤\s*(\d+)/)?.[1] || stream._seeders || 0);
  const borrowedTitle = isBr ? dubbedFrom : '';
  const audio = audioFromTitle(title) || audioFromTitle(borrowedTitle);
  // Mesma precedência de search-names: magnet CAM vence título limpo.
  const titleSource = sourceFromTitle(title);
  const magnetSource = sourceFromTitle(stream._magnetDn || '');
  const source = (magnetSource === 'CAM' && titleSource !== 'CAM')
    ? magnetSource
    : (titleSource || magnetSource || sourceFromTitle(borrowedTitle));
  return streamDisplayName({
    title,
    quality: stream._quality,
    audio,
    source,
    edition: editionFromTitle(title) || editionFromTitle(borrowedTitle),
    tracker: stream._tracker,
    isBr,
    seeders,
    // Remontar o nome não pode apagar o selo 📦/~N de quem é foto salva.
    fromFallback: Boolean(stream._fromFallback || stream._fromSnapshot),
  });
}
