/**
 * O Rust já classificou o play. Aqui só se grava no índice que a busca lê
 * (`markMissing`, `markMissingSeason`, `markLied`). Sem evidence o chamador
 * manda `index: null` e nada é escrito.
 *
 * A prova de episódio ausente é fina: só aquele S/E daquele hash.
 * `missing-season` é o ramo em que o arquivo não declara episódio nenhum —
 * a temporada daquele hash também fica marcada.
 */
import * as releaseIndex from '../../../../src/utils/release-index.js';

type ResolveLocation = { season: number | null; episode: number | null };

function isImdbId(imdbId: string): boolean {
  return imdbId.startsWith('tt');
}

function finite(value: number | null): value is number {
  return value != null && Number.isFinite(value);
}

export function applyIndexEffect(
  effect: { index: 'missing' | 'missing-season' | 'lied' | null },
  imdbId: string,
  location: ResolveLocation,
  infoHash: string,
): void {
  if (effect.index == null || !isImdbId(imdbId)) return;
  if (effect.index === 'lied') {
    releaseIndex.markLied(imdbId, location, infoHash);
    return;
  }
  if (finite(location.season) && finite(location.episode)) {
    releaseIndex.markMissing(imdbId, location, infoHash);
  }
  if (effect.index === 'missing-season' && finite(location.season)) {
    releaseIndex.markMissingSeason(imdbId, location.season, infoHash);
  }
}
