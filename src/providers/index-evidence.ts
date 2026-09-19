// Fusão de evidência por hash no enriquecimento do índice (caso Mortuary,
// tt0087746): o mesmo infoHash pode existir no `raw` com snapshot velho
// (Torrentio, seeders=0) e a coleta ao vivo trazê-lo saudável (TPB, seeders=3).
// Descartar a cópia conhecida congelava a evidência ruim e o filtro de
// min-seeders removia a release antes do Chupim avaliá-la.
//
// Preservamos o MELHOR estado observado — só o número sobe, via SUBSTITUIÇÃO
// POR CLONE do elemento no array (a referência original nunca é mutada): todos
// os demais metadados do vencedor permanecem idênticos. Origem e áudio
// pertencem ao post que já venceu (nada de _br/_dubbed do perdedor; quando as
// duas cópias coexistem como streams, o dedupeByHash do ranking funde
// `_seeders` pelo teto).
import { extractInfoHash } from '../utils/format.js';

export function fuseIndexEnrichment(rawItems: any[], liveItems: any[]): { fresh: any[]; fused: number } {
  const seedersOf = (item: any) => Number(item?.seeders ?? item?.Seeders ?? 0) || 0;
  const known = new Map<string, any>();
  for (const item of rawItems) {
    const h = String(extractInfoHash(item.infoHash || item.magnet) || '').toLowerCase();
    if (h && !known.has(h)) known.set(h, item);
  }
  const fresh: any[] = [];
  let fused = 0;
  for (const item of liveItems) {
    const h = String(extractInfoHash(item.infoHash || item.magnet) || '').toLowerCase();
    if (!h) continue;
    const prior = known.get(h);
    if (!prior) {
      known.set(h, item);
      fresh.push(item);
    } else if (seedersOf(item) > seedersOf(prior)) {
      // O finish/record/Chupim leem o lote `rawItems`: o elemento é trocado por
      // um clone com o seeders melhor — mesmo objeto de contrato, sem efeitos
      // colaterais em quem guardou a referência antiga.
      const idx = rawItems.indexOf(prior);
      if (idx !== -1) rawItems[idx] = { ...prior, seeders: seedersOf(item) };
      fused += 1;
    }
  }
  return { fresh, fused };
}
