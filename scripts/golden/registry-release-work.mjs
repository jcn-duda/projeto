/**
 * Entrada de registro do golden de `src/utils/release-work.ts` (roteamento de
 * obra da release). Consumida por `gen-release-work.mjs`.
 *
 * Entrada JSON com `op`:
 * - specificity: título → episodeParseSpecificity(parseTitleSeasonEpisode(título)) (inteiro)
 * - choose: título + dn → campos do parse escolhido (texto)
 * - route: título + dn + request → alvo (`temporada:episódio`, `-` para null)
 * - fits: título + dn + request → releaseFitsRequest (1/0)
 * - targets: título + dn + request + year → lista de alvos (ou `(none)`)
 *
 * `request` pode ser null (equivale a filme). `year` pode ser número, texto,
 * null ou ausente, como no TS. `dn` null ou ausente é o mesmo caso.
 *
 * release-matching.ts NÃO tem entrada aqui: é um barrel de reexports, sem
 * lógica própria; as funções reexportadas moram em release-name-matching.ts,
 * release-title-rules.ts e release-filters.ts.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export default {
  id: 'release-work/routing',
  name: 'releaseWork',
  source: 'src/utils/release-work.ts',
  artifact: 'dist/src/utils/release-work.js',
  corpus: 'scripts/golden/corpus-release-work.json',
  outJsonl: 'rust/golden/release-work.jsonl',
  outManifest: 'rust/golden/release-work.manifest.json',
  resolve: async () => {
    const work = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/release-work.js')).href);
    const episode = await import(pathToFileURL(path.join(REPO, 'dist/src/utils/episode-matching.js')).href);
    const bit = (v) => (v ? '1' : '0');
    const seasonText = (v) => (v === undefined || v === null ? '-' : String(v));
    const targetText = (t) => `${seasonText(t.season ?? null)}:${seasonText(t.episode ?? null)}`;
    const listText = (list) => (list.length === 0 ? '(none)' : list.map(targetText).join(' '));
    const yearOf = (c) => (c.year === undefined ? undefined : c.year);
    return (input) => {
      const c = JSON.parse(input);
      const dn = c.dn ?? undefined;
      const request = c.request ?? { season: null, episode: null };
      switch (c.op) {
        case 'specificity':
          return String(work.episodeParseSpecificity(episode.parseTitleSeasonEpisode(c.title)));
        case 'choose': {
          const p = work.chooseEpisodeParse(c.title, dn);
          return `complete=${bit(p.complete)} seasons=${p.seasons.join(',')} episodes=${p.episodes.join(',')} pack=${bit(p.seasonPack)}`;
        }
        case 'route':
          return targetText(work.routeWorkLocation(request, c.title, dn));
        case 'fits':
          return bit(work.releaseFitsRequest(request, c.title, dn));
        case 'targets':
          return listText(work.releaseWorkTargets(c.title, request, dn, { year: yearOf(c) }));
        default:
          throw new Error(`op desconhecida: ${c.op}`);
      }
    };
  },
};
