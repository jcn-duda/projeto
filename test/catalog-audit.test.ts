import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import config from '../src/config.js';
import * as catalog from '../src/utils/catalog.js';
import * as held from '../src/debrid/protected.js';
import * as releaseIndex from '../src/utils/release-index.js';
import type { AllDebridMagnetRow } from '../src/debrid/alldebrid.js';

const FRESH = () => fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-audit-test-'));
beforeEach(() => {
  catalog.resetForTests();
  catalog.open(FRESH());
});
const ACCOUNT = 'conta-de-teste';
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
function magnet(over: Partial<AllDebridMagnetRow> & { id: string | number; hash: string; filename: string }): AllDebridMagnetRow {
  return {
    id: over.id,
    hash: over.hash,
    filename: over.filename,
    size: over.size ?? 0,
    status: over.status ?? 'Ready',
    ready: over.ready ?? true,
    uploadDate: over.uploadDate ?? Math.floor(Date.now() / 1000) * 1000,
  };
}
function scan(account: string, list: AllDebridMagnetRow[]) {
  return catalog.scan({ adapterId: 'alldebrid', account, magnets: list, ctx: { adapterId: null, apiKey: '' } });
}

test('rowsNeedingAudit pula quem já tem fileEvidence', () => {
  scan(ACCOUNT, [
    magnet({ id: '1', hash: HASH_A, filename: 'Filme 2024 Dublado 1080p' }), // bucket dub → não fraco
    magnet({ id: '2', hash: HASH_B, filename: 'Some English Movie 2020 1080p x264' }), // bucket lixo → fraco
    magnet({ id: '3', hash: 'c'.repeat(40), filename: 'Outro 2022 Dual 720p' }), // bucket dual → fraco
  ]);
  // '2' já foi auditado (evidência de arquivo): não pode voltar à fila.
  releaseIndex.markFileEvidence(HASH_B, { a: 'Dual', q: '720p', n: 'Some English 2020.mkv' });
  const needing = catalog.rowsNeedingAudit(ACCOUNT, 10);
  const ids = needing.map((n) => String(n.serviceId));
  assert.ok(!ids.includes('2'), 'quem já tem evidência é pulado');
  assert.ok(ids.includes('3'), 'o dual entra na fila');
});

test('noteAudit atualiza a prova: path DUBLADO → pt_proof; -RARBG → foreign_proof', () => {
  scan(ACCOUNT, [
    magnet({ id: '1', hash: HASH_A, filename: 'Some English Movie 2020 1080p' }),
    magnet({ id: '2', hash: HASH_B, filename: 'Another Foreign 2021 1080p' }),
  ]);
  catalog.noteAudit(ACCOUNT, '1', HASH_A, [{ path: 'dir/Filme.DUBLADO.mkv' }]);
  assert.equal(catalog.row(ACCOUNT, '1')!.ptProof, 'arquivo', 'path com DUBLADO absolve com prova de arquivo');
  assert.equal(catalog.row(ACCOUNT, '1')!.foreignProof, '');

  catalog.noteAudit(ACCOUNT, '2', HASH_B, [{ path: 'dir/Movie.2021.RARBG.mkv' }]);
  assert.equal(catalog.row(ACCOUNT, '2')!.foreignProof, 'cena', 'path com -RARBG condena com marca de cena');
  assert.equal(catalog.row(ACCOUNT, '2')!.ptProof, '');
});

// ---------------------------------------------------------------------------
// Regressões do marcador durável `audited_at` (a fila que não drenava).
// ---------------------------------------------------------------------------

test('fila drena sem depender de fileEvidence: magnet de só .srt não re-visita', () => {
  // O defeito real: `recordFileEvidence` só grava quando há arquivo de VÍDEO;
  // um torrent de só .srt/.nfo/.rar tem fileEvidence null para sempre, e o
  // marcador retomável antigo era exatamente `fileEvidence` — a linha voltava
  // para `rowsNeedingAudit` em toda rodada (medido: 1674 auditorias, sem dreno).
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Some English Movie 2020 1080p' }), // bucket lixo → fraco
    magnet({ id: '2', hash: '2b'.repeat(20), filename: 'Outro 2022 Dual 720p' }),           // bucket dual → fraco
  ]);
  const antes = catalog.rowsNeedingAudit(ACCOUNT).map((n) => String(n.serviceId));
  assert.ok(antes.includes('1') && antes.includes('2'), 'precondição: as duas linhas fracas estão na fila');

  // Isola o marcador NOVO: não grava fileEvidence (nenhum vídeo), só o marcador
  // durável. O caminho .srt não absolve nem condena — provas seguem vazias,
  // mas a linha sai da fila por `audited_at > 0`.
  catalog.noteAudit(ACCOUNT, '1', '1a'.repeat(20), [{ path: 'Subs/Foo.srt' }]);
  catalog.markAudited(ACCOUNT, '2');
  const depois = catalog.rowsNeedingAudit(ACCOUNT).map((n) => String(n.serviceId));
  assert.ok(!depois.includes('1'), 'auditoria sem vídeo ainda drena a linha 1 (marker durável)');
  assert.ok(!depois.includes('2'), 'markAudited drena a linha 2');
});

test('markAudited não muda classificação nem re-data auditado_at', () => {
  // Linha com prova e balde conhecidos: markAudited é só o carimbo "já vi".
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'Filme 2024 Dublado 1080p' })]);
  const pre = catalog.row(ACCOUNT, '1')!;
  catalog.markAudited(ACCOUNT, '1');
  const pos = catalog.row(ACCOUNT, '1')!;
  assert.equal(pos.bucket, pre.bucket, 'bucket não muda');
  assert.equal(pos.foreignProof, pre.foreignProof, 'foreign_proof não muda');
  assert.equal(pos.ptProof, pre.ptProof, 'pt_proof não muda');
  assert.ok(pos.auditedAt > 0, 'auditedAt carimbado');

  catalog.markAudited(ACCOUNT, '1');
  assert.equal(catalog.row(ACCOUNT, '1')!.auditedAt, pos.auditedAt, 'segunda chamada é no-op (não re-data)');
});

test('rowsNeedingAudit ignora não-prontos e lista prontos', () => {
  // AllDebrid só lista arquivos em Ready: um magnet Downloading não é alvo de
  // auditoria (nem de limpeza) — e seria re-visitado quando ficasse pronto.
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '3c'.repeat(20), filename: 'Some English Movie 2020 1080p', ready: false, status: 'Downloading' }),
    magnet({ id: '2', hash: '4d'.repeat(20), filename: 'Outro 2022 Dual 720p', ready: true, status: 'Ready' }),
  ]);
  const ids = catalog.rowsNeedingAudit(ACCOUNT).map((n) => String(n.serviceId));
  assert.ok(!ids.includes('1'), 'não-pronto nunca entra na fila');
  assert.ok(ids.includes('2'), 'pronto e fraco entra na fila');
});

test('keptAudited não congela: prova por TÍTULO (pt_proof="titulo") com auditedAt é recalculada no re-scan', () => {
  const h = '77'.repeat(20); // hash próprio, sem fileEvidence de outro teste
  // (a) scan POR TÍTULO absolve pelo TÍTULO (sem arquivos): ptProof='titulo'.
  scan(ACCOUNT, [magnet({ id: '1', hash: h, filename: 'Nome do Filme Dublado 2024 1080p' })]);
  assert.equal(catalog.row(ACCOUNT, '1')!.ptProof, 'titulo', 'precondição: absolvição provisória (só pelo título)');

  // (b) linha marcada auditada (paths vazios → markAudited): auditedAt>0.
  catalog.markAudited(ACCOUNT, '1');
  assert.ok(catalog.row(ACCOUNT, '1')!.auditedAt > 0, 'precondição: audited_at com a prova de título');

  // O BUG a corrigir: o antigo keepAudited (prev.auditedAt>0) congelava a
  // pt_proof='titulo' aqui — um re-scan com título estrangeiro/EN não revogava
  // a falsa absolvição (ex. produzida pelo BR_MARK .org). Nova regra: 'titulo'
  // NÃO é evidência de arquivo; o re-scan recalcula pelo título.
  scan(ACCOUNT, [magnet({ id: '1', hash: h, filename: 'Movie.Foreign.2023.1080p.x264-RARBG' })]);
  const apos = catalog.row(ACCOUNT, '1')!;
  assert.equal(apos.ptProof, '', 'absolvição por título é revogada — não é prova de arquivo');
  assert.equal(apos.foreignProof, 'cena', 'a condenação pelo re-scan de título entra');
  assert.ok(apos.auditedAt > 0, 'auditedAt continua avançando (Math.max)');
});

test('keepAudited preserva prova de arquivo quando o scan perde a evidência (título nunca vence arquivo)', () => {
  // (a) scan por título: sem evidência, 'Some.Movie…' é unknown (sem prova).
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'Some.Movie.2024.1080p.WEB.x264' })]);
  assert.equal(catalog.row(ACCOUNT, '1')!.ptProof, '', "sem evidência, o título sozinho não grava 'arquivo'");

  // (b) auditoria real mede o .mkv DUBLADO → pt_proof='arquivo', audited_at>0.
  catalog.noteAudit(ACCOUNT, '1', HASH_A, [{ path: 'Filme/Filme DUBLADO 1080p.mkv' }]);
  const aposAudit = catalog.row(ACCOUNT, '1')!;
  assert.equal(aposAudit.ptProof, 'arquivo', 'o path absolve com prova de arquivo');
  const auditedAfter = aposAudit.auditedAt;
  assert.ok(auditedAfter > 0);

  // O teste NÃO gravou fileEvidence de verdade (sem markFileEvidence), então o
  // segundo scan cai em classifyByTitle → título estrangeiro → sem prova. O
  // keepAudited (prev.auditedAt>0 && row.auditedAt===0) preserva o `arquivo`.
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'Some.Movie.2024.1080p.WEB.x264' })]);
  const aposScan = catalog.row(ACCOUNT, '1')!;
  assert.equal(aposScan.ptProof, 'arquivo', 'título nunca vence a prova medida no arquivo');
  assert.equal(aposScan.auditedAt, auditedAfter, 'scan sem evidência não re-data o carimbo');
  const ids = catalog.rowsNeedingAudit(ACCOUNT).map((n) => String(n.serviceId));
  assert.ok(!ids.includes('1'), 'linha absolvida para sempre não volta à fila');
});

test('keepAudited preserva uma CONDENAÇÃO por arquivo (não só absolvição)', () => {
  // Linha fraca (bucket lixo) sem prova, na fila.
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'Some English Movie 2020 1080p' })]);
  assert.equal(catalog.row(ACCOUNT, '1')!.foreignProof, '', 'precondição: sem condenação');

  // noteAudit mede um path que CONDENA (-RARBG): prova de cena, audited_at>0.
  catalog.noteAudit(ACCOUNT, '1', HASH_A, [{ path: 'Movie/Movie.1080p.x264-RARBG.mkv' }]);
  const aposAudit = catalog.row(ACCOUNT, '1')!;
  assert.equal(aposAudit.foreignProof, 'cena', 'o path -RARBG condena com marca de cena');
  assert.ok(aposAudit.auditedAt > 0);

  // Re-scan SEM fileEvidence (teste não gravou) → classifyByTitle no título
  // genérico → unknown → provas vazias. O keepAudited (prev.auditedAt>0 &&
  // row.auditedAt===0) preserva a CONDENAÇÃO medida no arquivo.
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'Some English Movie 2020 1080p' })]);
  const aposScan = catalog.row(ACCOUNT, '1')!;
  assert.equal(aposScan.foreignProof, 'cena', 'título nunca apaga a condenação medida no arquivo');
  assert.equal(aposScan.auditedAt, aposAudit.auditedAt, 'scan sem evidência não re-data o carimbo');
  const ids = catalog.rowsNeedingAudit(ACCOUNT).map((n) => String(n.serviceId));
  assert.ok(!ids.includes('1'), 'linha condenada e auditada não volta à fila');
});

test('escape hatch: evidência VIVA sobrescreve condenação congelada', () => {
  // Linha condenada+auditada como no teste anterior.
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'Some English Movie 2020 1080p' })]);
  catalog.noteAudit(ACCOUNT, '1', HASH_A, [{ path: 'Movie/Movie.1080p.x264-RARBG.mkv' }]);
  assert.equal(catalog.row(ACCOUNT, '1')!.foreignProof, 'cena', 'precondição: condenada por arquivo');

  // Simula um scan que VÊ evidência real que ABSOLVE: o .mkv é DUBLADO.
  releaseIndex.markFileEvidence(HASH_A, { n: 'Filme/Filme DUBLADO 1080p.mkv', a: 'Dublado', q: '1080p' });
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'filme qualquer 2020 1080p' })]);
  const apos = catalog.row(ACCOUNT, '1')!;
  assert.equal(apos.ptProof, 'arquivo', 'a prova nova (arquivo) absolve');
  assert.equal(apos.foreignProof, '', 'a condenação congelada cede à prova melhor');
  assert.ok(apos.auditedAt > 0, 'este scan viu evidência → keepAudited=false → a prova nova vence');
});

test('markAuditedUnlessCondemned NÃO congela condenação por título com arquivos vazios; unknown drena', () => {
  // Hashes próprios: evidências gravadas com markFileEvidence em OUTROS testes
  // (HASH_A/HASH_B) sobrevivem no módulo e absolveriam o scan por engano.
  const hashCondenado = 'f0'.repeat(20);
  const hashUnknown = 'f1'.repeat(20);

  // Condenado SÓ PELO TÍTULO (-RARBG no nome), ainda não auditado (audited_at=0).
  scan(ACCOUNT, [magnet({ id: '1', hash: hashCondenado, filename: 'Foreign.2024.RARBG.1080p.x264' })]);
  const condenado = catalog.row(ACCOUNT, '1')!;
  assert.equal(condenado.foreignProof, 'cena', 'precondição: título condena por marca de cena');
  assert.equal(condenado.auditedAt, 0, 'precondição: ainda não auditado');
  assert.ok(catalog.rowsNeedingAudit(ACCOUNT).some((n) => String(n.serviceId) === '1'), 'precondição: está na fila');

  // Files vazios + condenação: os arquivos REAIS ainda podem absolver; não congela.
  catalog.markAuditedUnlessCondemned(ACCOUNT, '1');
  assert.equal(catalog.row(ACCOUNT, '1')!.auditedAt, 0, 'condenado não é carimbado com audited_at');
  assert.ok(catalog.rowsNeedingAudit(ACCOUNT).some((n) => String(n.serviceId) === '1'), 'continua na fila (elegível p/ próxima rodada)');

  // Contra-caso: linha unknown (foreignProof=='') com files vazios → drena.
  scan(ACCOUNT, [magnet({ id: '2', hash: hashUnknown, filename: 'Some English Movie 2020 1080p' })]);
  assert.equal(catalog.row(ACCOUNT, '2')!.foreignProof, '', 'precondição: sem condenação');
  catalog.markAuditedUnlessCondemned(ACCOUNT, '2');
  assert.ok(catalog.row(ACCOUNT, '2')!.auditedAt > 0, 'unknown drena: audited_at carimbado');
  assert.ok(!catalog.rowsNeedingAudit(ACCOUNT).some((n) => String(n.serviceId) === '2'), 'some da fila');
});

const _req = createRequire(import.meta.url);
let DatabaseSync: any = null;
try { DatabaseSync = _req('node:sqlite').DatabaseSync; } catch { /* node 20: sem node:sqlite, pula */ }
const migrationTest = DatabaseSync ? test : test.skip;

migrationTest('migração: ADD COLUMN audited_at marca linhas pt_proof=arquivo e sobrevive; fila pula migrantes', () => {
  const oldPath = path.join(FRESH(), 'old-schema.db');
  const db = new DatabaseSync(oldPath);
  db.exec(`
    CREATE TABLE magnet (
      adapter TEXT NOT NULL, account TEXT NOT NULL, service_id TEXT NOT NULL,
      hash TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '', ready INTEGER NOT NULL DEFAULT 0,
      uploaded_at INTEGER NOT NULL DEFAULT 0,
      bucket TEXT NOT NULL DEFAULT '', audio TEXT NOT NULL DEFAULT '',
      foreign_proof TEXT NOT NULL DEFAULT '', pt_proof TEXT NOT NULL DEFAULT '',
      imdb_id TEXT NOT NULL DEFAULT '', work_title TEXT NOT NULL DEFAULT '',
      work_is_br INTEGER NOT NULL DEFAULT 0, work_dubbed INTEGER NOT NULL DEFAULT 0,
      work_lied INTEGER NOT NULL DEFAULT 0, season INTEGER, episode INTEGER,
      cached TEXT NOT NULL DEFAULT 'unknown', cached_at INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER NOT NULL DEFAULT 0, delete_reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (adapter, account, service_id)
    );
  `);
  const agora = Math.floor(Date.now());
  db.prepare('INSERT INTO magnet (adapter, account, service_id, hash, filename, ready, bucket, pt_proof, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('alldebrid', ACCOUNT, '1', HASH_A, 'Some.Movie.2024.1080p.WEB.x264', 1, 'duv', 'arquivo', agora);
  db.prepare('INSERT INTO magnet (adapter, account, service_id, hash, filename, ready, bucket, last_seen_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('alldebrid', ACCOUNT, '2', '8b'.repeat(20), 'Another Foreign 2021 1080p', 1, 'lixo', agora);
  db.close();

  // Reabre o banco ANTIGO pelo engine do catálogo: a migração roda no open.
  catalog.close();
  catalog.open(oldPath);

  const migrado = catalog.row(ACCOUNT, '1')!;
  assert.equal(migrado.ptProof, 'arquivo', 'pt_proof preservada');
  assert.equal(migrado.auditedAt, agora, 'linha provada por arquivo migra com audited_at = last_seen_at');
  const naoMigrado = catalog.row(ACCOUNT, '2')!;
  assert.equal(naoMigrado.auditedAt, 0, 'linha sem prova de arquivo NÃO recebe audited_at na migração');

  const fila = catalog.rowsNeedingAudit(ACCOUNT).map((n) => String(n.serviceId));
  assert.ok(!fila.includes('1'), 'migrante provado (audited_at>0) fica fora da fila');
  assert.ok(fila.includes('2'), 'linha que a migração não carimbou continua na fila');
});
// ---------------------------------------------------------------------------
// requeueAudit: reabrir a fila quando a evidência de arquivo expirou.
// ---------------------------------------------------------------------------

test('requeueAudit devolve à fila só quem perdeu a evidência de arquivo', () => {
  // `upsertRow` guarda `auditedAt` com Math.max — o carimbo nunca regride. Quem
  // foi auditado e depois perdeu o `fileEvidence` (TTL de 30 dias do índice)
  // ficava fora da fila para sempre, e uma correção do classificador não o
  // alcançava. Quem AINDA tem evidência não precisa de rede: o scan já
  // reclassifica de graça.
  scan(ACCOUNT, [
    magnet({ id: "1", hash: "e1".repeat(20), filename: "Some English Movie 2020 1080p" }),
    magnet({ id: "2", hash: "e2".repeat(20), filename: "Outro 2022 Dual 720p" }),
  ]);
  releaseIndex.markFileEvidence("e2".repeat(20), { a: "Dual", q: "720p", n: "Outro.2022.mkv" });
  catalog.markAudited(ACCOUNT, '1');
  catalog.markAudited(ACCOUNT, '2');
  assert.equal(catalog.rowsNeedingAudit(ACCOUNT).length, 0, 'precondição: fila drenada');

  const res = catalog.requeueAudit(ACCOUNT, 'alldebrid');
  assert.equal(res.requeued, 1, 'só a linha sem evidência volta');
  assert.equal(res.keptWithEvidence, 1, 'a linha com evidência viva é preservada');
  const fila = catalog.rowsNeedingAudit(ACCOUNT).map((n) => String(n.serviceId));
  assert.deepEqual(fila, ['1']);
});

test('requeueAudit NÃO apaga as provas já medidas em arquivo', () => {
  // Limpar a prova junto abriria uma janela em que a linha volta a valer só
  // pelo TÍTULO — e título condena o que o arquivo tinha absolvido. A prova só
  // pode ser substituída por uma leitura NOVA.
  scan(ACCOUNT, [magnet({ id: "1", hash: "e3".repeat(20), filename: "Some English Movie 2020 1080p" })]);
  catalog.noteAudit(ACCOUNT, "1", "e3".repeat(20), [{ path: 'dir/Filme.DUBLADO.mkv' }]);
  assert.equal(catalog.row(ACCOUNT, '1')!.ptProof, 'arquivo', 'precondição: absolvido por arquivo');

  catalog.requeueAudit(ACCOUNT, 'alldebrid');
  const linha = catalog.row(ACCOUNT, '1')!;
  assert.equal(linha.ptProof, 'arquivo', 'a absolvição medida sobrevive ao reenfileiramento');
  assert.equal(linha.deletedAt, 0);
});

test('requeueAudit respeita o teto', () => {
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Some English Movie 2020 1080p' }),
    magnet({ id: '2', hash: '2b'.repeat(20), filename: 'Another English 2021 1080p' }),
    magnet({ id: '3', hash: '3c'.repeat(20), filename: 'Third English 2022 1080p' }),
  ]);
  for (const id of ['1', '2', '3']) catalog.markAudited(ACCOUNT, id);
  const res = catalog.requeueAudit(ACCOUNT, 'alldebrid', { limit: 2 });
  assert.equal(res.requeued, 2, 'para no teto');
  assert.equal(catalog.rowsNeedingAudit(ACCOUNT).length, 2);
});

// ---------------------------------------------------------------------------
// Escolha manual: quando as regras automáticas não liberam.
// ---------------------------------------------------------------------------

test('listForReview ordena por tamanho (maiores primeiro) e filtra por balde', () => {
  scan(ACCOUNT, [
    magnet({ id: '1', hash: 'm1'.repeat(20), filename: 'Some English Movie 2020 1080p', size: 1_000 }),
    magnet({ id: '2', hash: 'm2'.repeat(20), filename: 'Another English 2021 1080p', size: 9_000 }),
    magnet({ id: '3', hash: 'm3'.repeat(20), filename: 'Filme 2024 Dublado 1080p', size: 5_000 }),
  ]);
  const todos = catalog.listForReview(ACCOUNT, 'alldebrid');
  assert.deepEqual(todos.map((r) => r.serviceId), ['2', '3', '1'], 'maiores primeiro');

  const soDub = catalog.listForReview(ACCOUNT, 'alldebrid', { bucket: 'dub' });
  assert.deepEqual(soDub.map((r) => r.serviceId), ['3'], 'o filtro de balde vale');
  assert.equal(soDub[0].bucket, 'dub');
});

test('planManualDeletion aceita o que o operador marcou e pula download em curso', () => {
  // A escolha explícita é a autorização: não há trava de idade nem exigência de
  // condenação. A ÚNICA guarda é `active` — download em curso não aparece como
  // tal no título, e apagá-lo joga fora trabalho que o operador não podia ver.
  scan(ACCOUNT, [
    magnet({ id: '1', hash: 'n1'.repeat(20), filename: 'Filme 2024 Dublado 1080p', size: 10 }),
    magnet({ id: '2', hash: 'n2'.repeat(20), filename: 'Baixando 2024 1080p', size: 10, status: 'Downloading', ready: false }),
  ]);
  const plano = catalog.planManualDeletion(ACCOUNT, 'alldebrid', ['1', '2', '999']);
  assert.deepEqual(plano.targets.map((t) => String(t.serviceId)), ['1'], 'só o que dá para apagar');
  assert.equal(plano.targets[0].reason, 'manual');
  assert.equal(plano.skipped.active, 1, 'o download em curso é pulado');
  assert.equal(plano.skipped.missing, 1, 'id inexistente é ignorado');
});

test('planManualDeletion apaga BR e condenado por igual: a regra não filtra a escolha', () => {
  scan(ACCOUNT, [magnet({ id: '1', hash: 'n3'.repeat(20), filename: 'Filme 2024 Dublado 1080p', size: 10 })]);
  assert.equal(catalog.row(ACCOUNT, '1')!.bucket, 'dub', 'precondição: é BR dublado, que a limpeza automática nunca tocaria');
  const plano = catalog.planManualDeletion(ACCOUNT, 'alldebrid', ['1']);
  assert.equal(plano.targets.length, 1, 'a escolha do operador vence a classificação');
});

