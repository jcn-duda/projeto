// Banco de magnets vivo — ENGINE DE MEMÓRIA (fallback quando `node:sqlite`
// não existe ou a abertura falha). Extraída de `magnet-bank-rows.ts` pela
// catraca de 400 linhas: a engine implementa os MESMOS verbos da SQL, então o
// consumidor (fallback, status, busca do painel) não sabe qual está ativa.
//
// O hook de falha de escrita entra como PARÂMETRO (não importado) para não
// criar dependência circular com o módulo de abertura.
import type { Engine } from './magnet-bank-rows.js';
import type { MagnetRow, SourceRow, WorkRow, IndexerStat } from './magnet-bank-schema.js';

export function memoryEngine(consumeFailNextWrite: () => boolean): Engine {
  const magnets = new Map<string, MagnetRow>();
  const sources = new Map<string, SourceRow>();
  const works = new Map<string, WorkRow>();
  const h = (hash: string) => String(hash || '').toLowerCase();
  const sourceKey = (hash: string, indexer: string) => `${h(hash)}\u0000${String(indexer || '')}`;
  const workKey = (hash: string, imdb: string, season: number, episode: number) =>
    `${h(hash)}\u0000${String(imdb || '')}\u0000${season}\u0000${episode}`;
  return {
    kind: 'memory',
    getMagnet(hash) { return magnets.get(h(hash)) || null; },
    getSource(hash, indexer) { return sources.get(sourceKey(hash, indexer)) || null; },
    getWork(hash, imdb, season, episode) { return works.get(workKey(hash, imdb, season, episode)) || null; },
    listSources(hash) {
      const prefix = `${h(hash)}\u0000`;
      const out: SourceRow[] = [];
      for (const [k, row] of sources) if (k.startsWith(prefix)) out.push(row);
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out;
    },
    listWorks(hash) {
      const prefix = `${h(hash)}\u0000`;
      const out: WorkRow[] = [];
      for (const [k, row] of works) if (k.startsWith(prefix)) out.push(row);
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out;
    },
    listWorksByObra(imdb, season, episode, limit) {
      const out: WorkRow[] = [];
      for (const row of works.values()) {
        if (row.imdb === String(imdb || '') && row.season === season && row.episode === episode) out.push(row);
      }
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out.slice(0, limit);
    },
    listSourcesByIndexer(indexer, limit) {
      const out: SourceRow[] = [];
      for (const row of sources.values()) if (row.indexer === String(indexer || '')) out.push(row);
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out.slice(0, limit);
    },
    listMagnetsMany(hashes) {
      const set = new Set(hashes.map((x) => h(x)).filter(Boolean));
      const out: MagnetRow[] = [];
      for (const key of set) { const row = magnets.get(key); if (row) out.push(row); }
      return out;
    },
    listSourcesMany(hashes) {
      const set = new Set(hashes.map((x) => h(x)).filter(Boolean));
      const out: SourceRow[] = [];
      for (const row of sources.values()) if (set.has(h(row.hash))) out.push(row);
      return out;
    },
    listWorksMany(hashes) {
      const set = new Set(hashes.map((x) => h(x)).filter(Boolean));
      const out: WorkRow[] = [];
      for (const row of works.values()) if (set.has(h(row.hash))) out.push(row);
      return out;
    },
    listRecentMagnets(limit) {
      const out = [...magnets.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      return out.slice(0, limit);
    },
    searchMagnetsByTitle(variants, limit) {
      // `.includes` é LITERAL: `%`/`_`/`\` não têm semântica de curinga aqui —
      // mesma leitura do SQL, que escapa os três com `ESCAPE '\'`. Aplicar o
      // `toLowerCase` do JS (Unicode) sobre as MESMAS variantes de caixa que a
      // fachada manda ao SQL faz o acento casar nos dois (`Épico` × `épico`).
      const needles = variants.map((v) => String(v || '').toLowerCase()).filter(Boolean);
      if (needles.length === 0) return [];
      const out: MagnetRow[] = [];
      for (const row of magnets.values()) {
        const title = String(row.title || '').toLowerCase();
        if (needles.some((needle) => title.includes(needle))) out.push(row);
      }
      out.sort((a, b) => b.lastSeen - a.lastSeen);
      return out.slice(0, limit);
    },
    stats() {
      let lastSeen = 0;
      for (const row of magnets.values()) if (row.lastSeen > lastSeen) lastSeen = row.lastSeen;
      const buckets = new Map<string, { hashes: Set<string>; sources: number; lastSeen: number }>();
      for (const row of sources.values()) {
        if (row.lastSeen > lastSeen) lastSeen = row.lastSeen;
        const indexer = String(row.indexer || '');
        let bucket = buckets.get(indexer);
        if (!bucket) {
          bucket = { hashes: new Set(), sources: 0, lastSeen: 0 };
          buckets.set(indexer, bucket);
        }
        bucket.hashes.add(h(row.hash));
        bucket.sources += 1;
        if (row.lastSeen > bucket.lastSeen) bucket.lastSeen = row.lastSeen;
      }
      const byIndexer: IndexerStat[] = [...buckets.entries()].map(([indexer, bucket]) => ({
        indexer,
        hashes: bucket.hashes.size,
        sources: bucket.sources,
        lastSeen: bucket.lastSeen,
      }));
      // Mesma ordenação da SQL (lastSeen desc, id asc) para o painel não mudar
      // de layout quando a engine cai para memória.
      byIndexer.sort((a, b) => (b.lastSeen - a.lastSeen) || a.indexer.localeCompare(b.indexer));
      return { magnets: magnets.size, sources: sources.size, works: works.size, lastSeen, byIndexer };
    },
    writeBatch(batch) {
      if (consumeFailNextWrite()) throw new Error('falha de escrita injetada (teste)');
      for (const row of batch.magnets) magnets.set(h(row.hash), row);
      for (const row of batch.sources) sources.set(sourceKey(row.hash, row.indexer), row);
      for (const row of batch.works) works.set(workKey(row.hash, row.imdb, row.season, row.episode), row);
      return batch.magnets.length + batch.sources.length + batch.works.length;
    },
    countMagnets() { return magnets.size; },
    countSources() { return sources.size; },
    countWorks() { return works.size; },
    clearRows() { magnets.clear(); sources.clear(); works.clear(); },
    closeEngine() { magnets.clear(); sources.clear(); works.clear(); },
  };
}
