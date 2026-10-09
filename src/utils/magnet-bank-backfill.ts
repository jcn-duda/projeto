// Preenche `dubbed`/`quality` do acervo que nasceu sem eles (2026-09-30): a
// captura copiava os campos do item cru do Jackett, que não os traz, e as duas
// colunas ficaram vazias em 182 mil magnets. A captura agora classifica pelo
// título (`inputFromItem`); isto cobre o que já estava gravado e o que chega
// por import de export antigo.
//
// Idempotente SEM marcador: o trabalho é `quality = ''`, e todo registro
// preenchido ganha qualidade não vazia (no mínimo "sem resolução"). Conexão
// própria no mesmo arquivo (WAL admite o leitor/escritor ao lado do motor),
// lotes de uma transação e a vez devolvida ao event loop entre eles — medido
// no import: no volume do Windows um lote grande travava o processo.
import { createRequire } from 'node:module';
import { qualityFromTitle } from './audio-quality.js';
import { classifiedDubbed } from './magnet-bank-merge.js';

const _require = createRequire(import.meta.url);

interface Row { rid: number; hash: string; title: string; is_br: number; dubbed: number }

export async function backfillClassification(dbPath: string, batch = 500): Promise<{ updated: number; ok: boolean }> {
  let db: any;
  try {
    const { DatabaseSync } = _require('node:sqlite');
    db = new DatabaseSync(dbPath);
  } catch {
    return { updated: 0, ok: false };
  }
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // Índice PARCIAL das pendentes: sem ele o SELECT varre a tabela inteira a
    // cada boot, mesmo com quase nada a fazer — no volume do Windows (330 MB)
    // o processo ficou ~5 min em I/O síncrono e sem responder nem o manifest
    // para classificar 16 magnets (2026-10-01). Com ele: 0 ms; criá-lo varre
    // uma vez só (274 ms em disco nativo) e ele só guarda as linhas vazias.
    db.exec("CREATE INDEX IF NOT EXISTS magnet_quality_pending ON magnet (quality) WHERE quality = ''");
    const select = db.prepare(
      "SELECT rowid AS rid, hash, title, is_br, dubbed FROM magnet WHERE quality = '' AND rowid > ? ORDER BY rowid LIMIT ?",
    );
    const update = db.prepare('UPDATE magnet SET dubbed = ?, quality = ? WHERE hash = ?');
    let last = 0;
    let updated = 0;
    for (;;) {
      const rows = select.all(last, batch) as Row[];
      if (rows.length === 0) break;
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          last = row.rid;
          const title = String(row.title || '');
          // `dubbed` só sobe (mesma regra do merge): nunca apaga uma marca.
          const dubbed = row.dubbed || classifiedDubbed(title, Boolean(row.is_br)) ? 1 : 0;
          update.run(dubbed, qualityFromTitle(title), row.hash);
          updated += 1;
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* transação já quebrada */ }
        throw err;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { updated, ok: true };
  } finally {
    db.close();
  }
}
