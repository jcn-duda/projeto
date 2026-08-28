// Catálogo durável da conta AllDebrid + limpador BR com prova.
//
// Cobre as fases do `src/utils/catalog.ts`: o upsert que preserva
// `first_seen_at`, o tombstone de sumidos e a reabertura, o plano de
// deduplicação (T1/T2), a escolha do sobrevivente (protegido vence), as
// guardas do executor de deletes, a limpeza de estrangeiro provado e a
// auditoria de arquivos. Tudo roda SEM rede: o SQLite abre um arquivo
// temporário e o cache (ledger/davail/mag) fica vazio → disponibilidade
// 'unknown'.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import config from '../src/config.js';
import * as catalog from '../src/utils/catalog.js';
import * as held from '../src/debrid/protected.js';
import * as releaseIndex from '../src/utils/release-index.js';
import type { AllDebridMagnetRow } from '../src/debrid/alldebrid.js';

// Banco isolado por teste: o módulo abre lazy; o primeiro `open(tmp)` define
// o banco, e `resetForTests()` fecha/esquece o path para o próximo open.
const FRESH = () => fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));

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

test('scan grava, preserva first_seen_at e tomba o sumido; service_id que volta reabre', () => {
  scan(ACCOUNT, [
    magnet({ id: '1', hash: HASH_A, filename: 'Filme 2024 Dublado 1080p' }),
    magnet({ id: '2', hash: HASH_B, filename: 'Outro 2024 Legendado 720p' }),
  ]);
  const firstSeen = catalog.row(ACCOUNT, '1')!.firstSeenAt;
  assert.ok(firstSeen > 0);

  // Re-scan do mesmo service_id: atualiza campos, mas NÃO regride first_seen.
  scan(ACCOUNT, [magnet({ id: '1', hash: HASH_A, filename: 'A 2024 Dublado 1080p', size: 123456 })]);
  assert.equal(catalog.row(ACCOUNT, '1')!.firstSeenAt, firstSeen, 'first_seen_at preservado');
  assert.equal(catalog.row(ACCOUNT, '1')!.size, 123456, 'os demais campos atualizam');

  // '1' saiu da conta: tombstone. '2' continua vivo.
  scan(ACCOUNT, [magnet({ id: '2', hash: HASH_B, filename: 'Outro 2024 Legendado 720p' })]);
  assert.ok(catalog.row(ACCOUNT, '1')!.deletedAt > 0, 'o sumido é tombstonado');
  assert.equal(catalog.row(ACCOUNT, '1')!.deleteReason, 'ausente da conta');
  assert.equal(catalog.row(ACCOUNT, '2')!.deletedAt, 0, 'o presente continua vivo');

  // O MESMO service_id voltou à conta: reabre (deleted_at=0) e mantém first_seen.
  scan(ACCOUNT, [
    magnet({ id: '1', hash: HASH_A, filename: 'A 2024 Dublado 1080p' }),
    magnet({ id: '2', hash: HASH_B, filename: 'Outro 2024 Legendado 720p' }),
  ]);
  assert.equal(catalog.row(ACCOUNT, '1')!.deletedAt, 0, 'reaberto: limpa o tombstone');
  assert.equal(catalog.row(ACCOUNT, '1')!.firstSeenAt, firstSeen, 'reabertura preserva first_seen');
});

test('scan associa o índice reverso e o relatório separa obra conhecida/desconhecida', () => {
  releaseIndex.record('tt9000001', {}, [
    { title: 'Filme 2024 Dublado 1080p', infoHash: HASH_A, seeders: 4, size: 1024, indexer: 'test', isBr: true },
  ]);
  const r = scan(ACCOUNT, [
    magnet({ id: '1', hash: HASH_A, filename: 'Filme 2024 Dublado 1080p' }),
    magnet({ id: '2', hash: HASH_B, filename: 'Não Existe Nenhuma 2020 720p' }),
  ]);
  assert.equal(r.works.known, 1, 'o magnet com obra resolvida conta como conhecido');
  assert.equal(r.works.unknown, 1, 'o magnet sem obra no índice é desconhecido');
  assert.equal(r.unresolvedHashes, 1);
  assert.equal(catalog.row(ACCOUNT, '1')!.imdbId, 'tt9000001');
});

test('planDedup T1: mesmo hash com 2 service_ids vivos', () => {
  scan(ACCOUNT, [
    magnet({ id: '10', hash: HASH_A, filename: 'Filme 2024 Dublado 1080p', uploadDate: 1000 }),
    magnet({ id: '11', hash: HASH_A, filename: 'Filme 2024 Dublado 1080p', uploadDate: 2000 }),
  ]);
  const { t1 } = catalog.planDedup(ACCOUNT);
  assert.equal(t1.length, 1, 'um grupo por hash');
  assert.equal(t1[0].keep.serviceId, '10', 'sobrevivente: o upload mais antigo');
  assert.equal(t1[0].kill.length, 1);
});

test('planDedup T2: filenames iguais após normalização e tamanhos na tolerância 0,5% (caso real)', () => {
  // Caso real do operador: dois "Devoradores de Estrelas 2026 … DUAL 5.1", ids
  // 713999816 e 713999501, sizes 3.357.116.179 e 3.357.118.139 — DIFERENÇA DE
  // 1.960 BYTES (0,00006%). Nome idêntico após normalização (um com pontos, o
  // outro com espaços), mesma release resubida com metadado divergindo; a UI
  // da AllDebrid arredonda ambos para "3.13 GB". Antes da tolerância, o T2 por
  // (nome, size exato) nunca pegava essa duplicata.
  scan(ACCOUNT, [
    magnet({ id: '713999816', hash: 'd'.repeat(40), filename: 'Devoradores.de.Estrelas.2026.Dual.5.1', size: 3357118139, uploadDate: 3000 }),
    magnet({ id: '713999501', hash: 'e'.repeat(40), filename: 'Devoradores de Estrelas 2026 Dual 5.1', size: 3357116179, uploadDate: 1000 }),
  ]);
  const { t1, t2 } = catalog.planDedup(ACCOUNT);
  assert.equal(t1.length, 0, 'não é T1: os hashes são diferentes');
  assert.equal(t2.length, 1, 'mesmo nome normalizado + tamanho perto (0,00006%) = 1 grupo T2');
  assert.equal(t2[0].kill.length, 1, 'o sobrevivente é o mais antigo; a resubida vira kill');
  const ids = t2.flatMap((g) => [g.keep.serviceId, ...g.kill.map((k) => k.serviceId)]);
  assert.ok(ids.includes('713999816') && ids.includes('713999501'), 'as duas reproduções entram no grupo');
});

test('planDedup T2 NÃO agrupa tamanhos fora da tolerância (10% apartados)', () => {
  // Controle: mesmo nome normalizado, mas tamanhos 10% apartados — cada um é
  // um cluster de tamanho 1, então nenhum grupo T2 é formado.
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Devoradores de Estrelas 2026 Dual 5.1', size: 3357116179, uploadDate: 1000 }),
    magnet({ id: '2', hash: '2b'.repeat(20), filename: 'Devoradores.de.Estrelas.2026.Dual.5.1', size: 3692827797, uploadDate: 2000 }),
  ]);
  const { t2 } = catalog.planDedup(ACCOUNT);
  assert.equal(t2.length, 0, '10% fora da tolerância: clusters de tamanho 1 = nenhum grupo');
});

test('sobrevivente do dedup em T2 é o protegido mesmo sendo o mais novo', () => {
  const orig = config.debrid.autoFetchProtectBr;
  config.debrid.autoFetchProtectBr = true;
  // hashes DIFERENTES (T2), mesmo arquivo+size: só o hash retido é protegido, e
  // mesmo assim o plano precisa elegê-lo sobrevivente.
  const newerHash = 'f'.repeat(40);
  const olderHash = 'g'.repeat(40);
  try {
    scan(ACCOUNT, [
      magnet({ id: '1', hash: newerHash, filename: 'Devoradores de Estrelas 2026 Dual 5.1', size: 3362762342, uploadDate: 10000 }),
      magnet({ id: '2', hash: olderHash, filename: 'Devoradores.de.Estrelas.2026.Dual.5.1', size: 3362762342, uploadDate: 1000 }),
    ]);
    // O MAIS NOVO é o retido (autofetch).
    held.protectBr('alldebrid', ACCOUNT, newerHash);
    assert.equal(held.isCleanupProtected(newerHash, ACCOUNT, 'alldebrid'), true, 'precondição: protegido');
    assert.equal(held.isCleanupProtected(olderHash, ACCOUNT, 'alldebrid'), false, 'o outro não é');

    const { t2 } = catalog.planDedup(ACCOUNT);
    assert.equal(t2.length, 1, 'um grupo T2 por arquivo normalizado + size');
    assert.equal(t2[0].keep.hash, newerHash, 'o protegido vence mesmo sendo o mais novo');
    assert.equal(t2[0].kill[0].hash, olderHash);
  } finally {
    held.unprotect('alldebrid', ACCOUNT, newerHash);
    config.debrid.autoFetchProtectBr = orig;
  }
});

test('kill ativo (download em curso) não sai do plano', () => {
  scan(ACCOUNT, [
    magnet({ id: '1', hash: HASH_A, filename: 'Filme 2024 1080p', uploadDate: 1000 }),
    magnet({ id: '2', hash: HASH_A, filename: 'Filme 2024 1080p', uploadDate: 2000 }),
    magnet({ id: '3', hash: HASH_A, filename: 'Filme 2024 1080p', uploadDate: 3000, status: 'Downloading', ready: false }),
  ]);
  const { t1 } = catalog.planDedup(ACCOUNT);
  assert.equal(t1.length, 1);
  const killed = t1[0].kill.map((k) => k.serviceId);
  assert.ok(!killed.includes('3'), 'estado ativo nunca é kill');
  assert.ok(killed.includes('2'));
  // O grupo nunca zera: continue vivo o keep + o ativo.
  assert.equal(new Set([t1[0].keep.serviceId, '3']).size, 2, 'o ativo permanece no domínio');
});

test('applyDeletions: só o que o executor remove vira tombstone; falha fica viva', async () => {
  scan(ACCOUNT, [
    magnet({ id: '1', hash: HASH_A, filename: 'Filme 2024 Dublado 1080p' }),
    magnet({ id: '2', hash: HASH_B, filename: 'Outro 2024 720p' }),
  ]);
  const res = await catalog.applyDeletions(
    ACCOUNT,
    'alldebrid',
    [
      { serviceId: '1', hash: HASH_A, reason: 'duplicado' },
      { serviceId: '2', hash: HASH_B, reason: 'duplicado' },
    ],
    async (ids) => {
      const okAc = ids.filter((id) => String(id) === '1').length;
      const falhas = okAc < ids.length ? [{ message: 'falhou ao remover o magnet 2' }] : [];
      return { ok: okAc, falhas };
    },
  );
  assert.equal(res.ok, 1);
  assert.equal(res.falhas, 1);
  assert.ok(catalog.row(ACCOUNT, '1')!.deletedAt > 0, 'o aceito virou tombstone');
  assert.equal(catalog.row(ACCOUNT, '2')!.deletedAt, 0, 'o recusado CONTINUA VIVO');
  assert.equal(catalog.report(ACCOUNT).magnets, 1, 'só o vivo conta no relatório');
});

test('planForeignCleanup: condenado jovem, protegido, sem prova e teto max', () => {
  const velho = Math.floor(Date.now() / 1000) * 1000 - 20 * 24 * 3600 * 1000; // 20 dias
  const jovem = Math.floor(Date.now() / 1000) * 1000 - 60_000; // 1 min
  const heldHash = '3c'.repeat(20);
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Movie.2020.TRUEFRENCH.1080p.x264', uploadDate: velho }),
    magnet({ id: '2', hash: '2b'.repeat(20), filename: 'Foreign.2024.RARBG.1080p.x264', uploadDate: jovem }),
    magnet({ id: '3', hash: heldHash, filename: 'Other.2019.RARBG.720p.x264', uploadDate: velho }),
    magnet({ id: '4', hash: '4d'.repeat(20), filename: 'Nome do Filme Dublado 1080p' }),
  ]);
  held.hold(heldHash, 3600, ACCOUNT);
  try {
    const { targets, skipped } = catalog.planForeignCleanup(ACCOUNT, 'alldebrid', {
      minAgeMs: 7 * 24 * 3600 * 1000,
      max: 10,
    });
    assert.equal(targets.length, 1, 'só o estrangeiro VELHO e solto é alvo');
    assert.equal(targets[0].serviceId, '1');
    assert.equal(skipped.young, 1, 'referentes ao candidato jovem');
    assert.equal(skipped.protected, 1, 'o held poupa um; nenhum protegido é alvo');
    assert.equal(skipped.notCondemned, 1, 'o dublado sem prova conta como não-condenado');
  } finally {
    held.release(heldHash, ACCOUNT);
  }
});

test('planForeignCleanup respeita o teto max', () => {
  const velho = Math.floor(Date.now() / 1000) * 1000 - 30 * 24 * 3600 * 1000;
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Movie.2020.TRULEF.1080p.x264', uploadDate: velho }),
    magnet({ id: '2', hash: '2b'.repeat(20), filename: 'Foreign.2021.RARBG.1080p.x264', uploadDate: velho }),
    magnet({ id: '3', hash: '3c'.repeat(20), filename: 'Other.2019.RARBG.1080p.x264', uploadDate: velho }),
  ]);
  const { targets } = catalog.planForeignCleanup(ACCOUNT, 'alldebrid', { minAgeMs: 7 * 24 * 3600 * 1000, max: 2 });
  assert.equal(targets.length, 2, 'o corte pega só os 2 mais antigos');
});

test('planDedup T2 não agrupa tamanho desconhecido (size 0 colidiria tudo)', () => {
  // Dois magnets distintos, mesmo nome normalizado e size 0 (fonte que não
  // publica tamanho): "mesma release" NÃO está provada — o grupo não existe.
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Devoradores de Estrelas 2026 Dual 5.1', size: 0, uploadDate: 1000 }),
    magnet({ id: '2', hash: '2b'.repeat(20), filename: 'Devoradores.de.Estrelas.2026.Dual.5.1', size: 0, uploadDate: 2000 }),
  ]);
  const { t2 } = catalog.planDedup(ACCOUNT);
  assert.equal(t2.length, 0, 'size desconhecido não prova duplicata');
});

test('planForeignCleanup exclui o acervo que já era do usuário (knownBefore)', () => {
  const velho = Math.floor(Date.now() / 1000) * 1000 - 30 * 24 * 3600 * 1000;
  const doUsuario = '9e'.repeat(20);
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Movie.2020.TRUEFRENCH.1080p.x264', uploadDate: velho }),
    magnet({ id: '2', hash: doUsuario, filename: 'Foreign.2021.RARBG.1080p.x264', uploadDate: velho }),
  ]);
  const { targets, skipped } = catalog.planForeignCleanup(ACCOUNT, 'alldebrid', {
    minAgeMs: 7 * 24 * 3600 * 1000,
    max: 10,
    knownHashes: [doUsuario],
  });
  assert.equal(targets.length, 1, 'só o hash solto é alvo');
  assert.equal(targets[0].hash, '1a'.repeat(20));
  assert.equal(skipped.known, 1, 'o do usuário é contado como conhecido');
});

test('planForeignCleanup: includeKnown inclui o acervo do operador e a flag known vem no target', () => {
  const velho = Math.floor(Date.now() / 1000) * 1000 - 30 * 24 * 3600 * 1000;
  const doOperador = 'ac'.repeat(20);
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1a'.repeat(20), filename: 'Movie.2020.TRUEFRENCH.1080p.x264', uploadDate: velho }),
    magnet({ id: '2', hash: doOperador, filename: 'Foreign.2021.RARBG.1080p.x264', uploadDate: velho }),
  ]);
  const { targets, skipped } = catalog.planForeignCleanup(ACCOUNT, 'alldebrid', {
    minAgeMs: 7 * 24 * 3600 * 1000,
    max: 10,
    knownHashes: [doOperador],
    includeKnown: true,
  });
  assert.equal(targets.length, 2, 'com includeKnown, o preexistente também é alvo');
  assert.equal(skipped.known, 0, 'guarda desligada: skipped.known não conta');
  const doOperadorTarget = targets.find((t) => String(t.hash) === doOperador);
  assert.ok(doOperadorTarget && doOperadorTarget.known === true, 'a flag known vem verdadeira no target preexistente');
  const solto = targets.find((t) => String(t.hash) === '1a'.repeat(20));
  assert.ok(solto && solto.known === false, 'o hash fora do snapshot fica known:false');
});

test('scan: magnet READY na conta é ⚡ mesmo sem evidência quieta (AllDebrid)', () => {
  // Sem ctx de operador (adapterId null), o releaseStatus quieto devolveria
  // 'unknown' para tudo — mas para a AllDebrid o que importa é o `ready` NA
  // CONTA, que é exatamente o ⚡ que o play usa (o inventário-como-fonte marca
  // esses com ⚡). O não-ready cai no veredito do releaseStatus: sem evidência,
  // 'unknown'. O ready da conta NÃO depende de ter/snapshot quente.
  scan(ACCOUNT, [
    magnet({ id: '1', hash: '1'.repeat(40), filename: 'Pronto 2024 Dublado 1080p', ready: true }),
    magnet({ id: '2', hash: '2'.repeat(40), filename: 'Frio 2024 Legendado 720p', ready: false }),
  ]);
  assert.equal(catalog.row(ACCOUNT, '1')!.cached, 'hit', 'ready na conta = tocável agora');
  assert.equal(catalog.row(ACCOUNT, '2')!.cached, 'unknown', 'não-ready: veredito do releaseStatus quieto (sem evidência)');
});

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
  assert.ok(!ids.includes('1'), 'não-pronto NUNCA entra na fila');
  assert.ok(ids.includes('2'), 'pronto e fraco entra na fila');
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