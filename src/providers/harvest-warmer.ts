// Alimenta o warmer do Real-Debrid com as releases que o colhedor acabou de
// registrar. Extraído do harvestOne (catraca de linhas) para o modo dirigido
// da sonda usar o mesmo score sem duplicar a regra.
import config from '../config.js';
import rdWarmer from './rd-warmer.js';
import { extractInfoHash, looksPtBr, audioFromTitle, explicitPtAudio } from '../utils/format.js';

/** Score do warmer: BR dublado 80 / dublado 40 / resto 5; top-10 por hash. */
export function queueRdWarmForRelevant(relevant: readonly any[]): void {
  if (!config.debrid.rdWarm.enabled || !rdWarmer.rdInPlay() || !relevant.length) return;
  const scoresByHash = new Map<string, number>();
  for (const r of relevant) {
    const title = String(r.title || r.Title || '');
    const hash = String(extractInfoHash(r.infoHash || r.magnet || r.MagnetUri || r.Guid || r.hash) || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) continue;
    const isBr = Boolean(r.isBr) || looksPtBr(title);
    const audio = audioFromTitle(title);
    const dubbed = Boolean(r.dubbed) || ['Dublado', 'Dual', 'Nacional'].includes(String(audio)) || explicitPtAudio(title);
    const score = isBr && dubbed ? 80 : (dubbed ? 40 : 5);
    const existing = scoresByHash.get(hash);
    if (existing === undefined || score > existing) {
      scoresByHash.set(hash, score);
    }
  }
  const topReleases = [...scoresByHash.entries()]
    .map(([hash, score]) => ({ hash, score }))
    .sort((a, b) => b.score - a.score);
  for (const item of topReleases.slice(0, 10)) {
    rdWarmer.enqueue([item.hash], item.score);
  }
}
