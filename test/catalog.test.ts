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

test('planDedup T2: item que cruza a tolerância abre o próximo cluster (não se perde)', () => {
  // Regressão: o ítem que dispara o corte entrava como `cluster = []` e se
  // perdia — o segundo par (na fronteira do corte) sumia do plano. Quatro
  // magnets, mesmo nome normalizado (quatro grafias de separador distintas),
  // sizes formando DOIS pares 0,5%-apartados e ~100% apartados entre pares:
  // espera-se EXATAMENTE 2 grupos T2. Grafias SEM ponto final para não casar
  // com o strip de extensão do `filenameNormalized` (o " 5.1" do caso real
  // estaria ancorado; aqui o foco é só o cluster, não o igualador de nomes).
  scan(ACCOUNT, [
    magnet({ id: '104', hash: '3c'.repeat(20), filename: 'Devaradores de Estrelas 2026 Dual', size: 1_000_000_000, uploadDate: 1000 }),
    magnet({ id: '103', hash: '3b'.repeat(20), filename: 'Devaradores-de-Estrelas-2026-dual', size: 1_000_001_000, uploadDate: 2000 }),
    magnet({ id: '102', hash: '3a'.repeat(20), filename: 'Devaradores [de Estrelas] 2026 DUAL', size: 2_000_000_000, uploadDate: 3000 }),
    magnet({ id: '101', hash: '30'.repeat(20), filename: 'Devaradores_de_Estrelas_2026_Dual', size: 2_000_001_000, uploadDate: 4000 }),
  ]);
  const { t2 } = catalog.planDedup(ACCOUNT);
  assert.equal(t2.length, 2, 'dois clusters por tolerância 0,5% contra o menor de cada cluster');
  const memberIds = new Set(t2.flatMap((g) => [String(g.keep.serviceId), ...g.kill.map((k) => String(k.serviceId))]));
  assert.equal(memberIds.size, 4, 'os 4 magnets entram no plano (nenhum se perde)');
  assert.ok(memberIds.has('101') && memberIds.has('102'), 'o segundo par (C e D) não pode sumir');
  for (const g of t2) {
    assert.equal(g.kill.length, 1, 'cada grupo tem keep + 1 kill');
  }
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
