// Índice de releases por obra (`idx:v1`): a peça que faz o addon virar
// servidor. Cobertura do módulo: escrita idempotente com dedupe por hash,
// fallback de lookup (episódio → temporada → obra), exclusão do inventário da
// conta, kill-switches e status para o painel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import { prefix } from '../src/utils/cache-keys.js';
import { record, lookup, status, markMissing, isMissing, markFileEvidence, fileEvidence, isPartial, clearPartial, markLied } from '../src/utils/release-index.js';

const release = (hash: string, extra: any = {}) => ({
  title: `Filme Teste 1080p DUAL ${hash.slice(0, 4)}`,
  infoHash: hash,
  seeders: 12,
  size: 1024 * 1024 * 1024,
  indexer: 'testindexer',
  isBr: true,
  ...extra,
});

test('record grava por obra e lookup devolve as releases', () => {
  const hash = 'a'.repeat(40);
  const added = record('tt9000001', {}, [release(hash)]);
  assert.ok(added > 0);
  const out = lookup('tt9000001');
  assert.equal(out.length, 1);
  assert.equal(out[0].hash, hash);
  assert.equal(out[0].isBr, true);
  // Chave certa no cache: idx:v1:<imdbId>, sem config nem credencial.
  assert.ok(cache.get(`${prefix('idx')}tt9000001`));
});

test('record é idempotente e deduplica por hash', () => {
  const hash = 'b'.repeat(40);
  record('tt9000002', {}, [release(hash)]);
  const addedAgain = record('tt9000002', {}, [release(hash), release('c'.repeat(40))]);
  assert.equal(addedAgain, 1, 'só o hash NOVO conta como crescimento');
  const out = lookup('tt9000002');
  assert.equal(out.length, 2, 'mesmo hash não duplica');
});

test('lookup de série cai do episódio para a temporada (pack cobre episódio)', () => {
  record('tt9000003', { season: 2 }, [
    release('d'.repeat(40), { title: 'Serie Teste 2ª Temporada Completa DUBLADO' }),
  ]);
  const out = lookup('tt9000003', { season: 2, episode: 5 });
  assert.equal(out.length, 1, 'a chave da temporada cobre o episódio pedido');
  assert.equal(lookup('tt9000003').length, 0, 'sem locação nenhuma não mistura séries na obra-mãe');
});

test('item de inventário da conta NÃO entra no índice', () => {
  // O índice guarda o que EXISTE publicamente; o que está pronto em qual conta
  // é davail/mag, escopados. Vazar inventário seria cruzar contas.
  record('tt9000004', {}, [{ ...release('e'.repeat(40)), fromAccount: true }]);
  assert.equal(lookup('tt9000004').length, 0);
});

test('item sem hash não vira índice', () => {
  record('tt9000005', {}, [{ title: 'Sem Hash 1080p' }]);
  assert.equal(lookup('tt9000005').length, 0);
});

test('flag dublado segue a mesma regra do toStremioStream', () => {
  // Fora dos sites BR, DUAL/PT explícito no título vale; sem marca, não.
  record('tt9000010', {}, [
    { ...release('aa'.repeat(20), { isBr: false }), title: 'Test Title 2024 1080p DUBLADO' },
    { ...release('bb'.repeat(20), { isBr: false }), title: 'Test Title 2024 1080p' },
  ]);
  const out = lookup('tt9000010');
  const byHash = new Map(out.map((r) => [r.hash, r]));
  assert.equal(byHash.get('aa'.repeat(20))?.dubbed, true, 'PT explícito marca dublado');
  assert.equal(byHash.get('bb'.repeat(20))?.dubbed, false, 'sem marca não vale como dublado');
});

test('RELEASE_INDEX=false desliga escrita e leitura', async () => {
  const original = config.releaseIndex.enabled;
  try {
    config.releaseIndex.enabled = false;
    record('tt9000006', {}, [release('f'.repeat(40))]);
    assert.equal(cache.get(`${prefix('idx')}tt9000006`), null);
    assert.deepEqual(lookup('tt9000006'), []);
  } finally {
    config.releaseIndex.enabled = original;
  }
});

test('teto de releases por obra corta as mais antigas', () => {
  const originalMax = config.releaseIndex.maxReleases;
  try {
    config.releaseIndex.maxReleases = 3;
    const items = ['1', '2', '3', '4'].map((n) => release(n.repeat(40)));
    record('tt9000007', {}, items);
    const out = lookup('tt9000007');
    assert.equal(out.length, 3, 'a obra não cresce sem teto');
  } finally {
    config.releaseIndex.maxReleases = originalMax;
  }
});

test('status expõe entradas e cota para o painel', () => {
  const st = status() as any;
  assert.equal(typeof st.entries, 'number');
  assert.equal(st.maxEntries, 2000);
  assert.equal(st.enabled, true);
});

// --- Roteamento por destino declarado ---------------------------------------
//
// A coleta de um episódio arrasta releases de outros (o Jackett casa por NOME,
// não por episódio). Medido no índice real antes desta regra: 328 de 659
// releases (50%) estavam sob chave que não casavam — envenenando duas vezes,
// porque ocupavam as vagas do teto que pertenciam ao episódio pedido E davam
// cobertura falsa ao gate que decide servir do índice.

const serieRel = (hash: string, title: string, extra: any = {}) => ({
  title,
  infoHash: hash,
  seeders: 9,
  size: 1024 ** 3,
  indexer: 'globaltracker',
  ...extra,
});

test('release de OUTRO episódio vai para a chave dela, não para a da busca', () => {
  const alvo = 'd'.repeat(40);
  const forasteira = 'e'.repeat(40);
  record('tt9000100', { season: 4, episode: 7 }, [
    serieRel(alvo, 'True Detective S04E07 1080p WEB-DL'),
    serieRel(forasteira, 'True.Detective.S03E07.The.Final.Country.1080p'),
  ]);

  const pedida = lookup('tt9000100', { season: 4, episode: 7 }).map((r) => r.hash);
  assert.deepEqual(pedida, [alvo], 'a chave do episódio pedido só tem o episódio pedido');

  // Roteada, não descartada: a consulta já foi paga e vira cobertura de graça.
  const dela = lookup('tt9000100', { season: 3, episode: 7 }).map((r) => r.hash);
  assert.deepEqual(dela, [forasteira], 'a forasteira está indexada no episódio DELA');
});

test('pack de temporada vai para a chave da temporada e serve qualquer episódio dela', () => {
  const pack = 'f'.repeat(40);
  record('tt9000101', { season: 2, episode: 1 }, [
    serieRel(pack, 'True Detective 2ª Temporada (2015) [1080p DUBLADO 22.41 GB]', { isBr: true }),
  ]);
  assert.ok(cache.get(`${prefix('idx')}tt9000101:S2`), 'gravou na chave da temporada');
  assert.ok(!cache.get(`${prefix('idx')}tt9000101:S2E1`), 'não sujou a chave do episódio');
  // O lookup lê episódio → temporada → obra, então o pack continua alcançável.
  for (const ep of [1, 5, 8]) {
    assert.equal(lookup('tt9000101', { season: 2, episode: ep }).length, 1, `pack alcança E${ep}`);
  }
});

test('pack multi-episódio (E01-E02) também cai na temporada, não num episódio só', () => {
  const pack = '1'.repeat(40);
  record('tt9000102', { season: 1, episode: 5 }, [serieRel(pack, 'True.Detective.S01E01-E02.1080p')]);
  assert.ok(cache.get(`${prefix('idx')}tt9000102:S1`));
  assert.ok(!cache.get(`${prefix('idx')}tt9000102:S1E1`));
});

test('série completa / faixa de temporadas vai para a chave da OBRA', () => {
  const completa = '2'.repeat(40);
  record('tt9000103', { season: 3, episode: 4 }, [
    serieRel(completa, 'Game of Thrones 1ª até 8ª Temporada Completa Dublada e Dual', { isBr: true }),
  ]);
  assert.ok(cache.get(`${prefix('idx')}tt9000103`), 'chave da obra cobre qualquer temporada');
  assert.ok(!cache.get(`${prefix('idx')}tt9000103:S3E4`));
  assert.equal(lookup('tt9000103', { season: 7, episode: 2 }).length, 1, 'alcança temporada distante');
});

test('título que não declara nada fica onde a busca o encontrou', () => {
  const mudo = '3'.repeat(40);
  record('tt9000104', { season: 6, episode: 3 }, [serieRel(mudo, 'Serie Sem Marcacao 1080p WEB-DL')]);
  assert.deepEqual(
    lookup('tt9000104', { season: 6, episode: 3 }).map((r) => r.hash),
    [mudo],
    'sem declaração, o contexto da busca é a melhor evidência',
  );
});

test('o teto por chave deixa de ser gasto com episódio alheio', () => {
  // O caso medido: 49 das 60 vagas de um S1E1 eram de outras temporadas, e as
  // releases dubladas do episódio certo eram despejadas por elas.
  const saved = config.releaseIndex.maxReleases;
  config.releaseIndex.maxReleases = 5;
  try {
    const itens = [];
    for (let i = 0; i < 8; i += 1) {
      itens.push(serieRel(String(i).repeat(40), `Serie X S02E0${i + 1} 1080p`));
    }
    itens.push(serieRel('9'.repeat(40), 'Serie X S01E01 1080p DUBLADO', { isBr: true }));
    record('tt9000105', { season: 1, episode: 1 }, itens);
    const doPedido = lookup('tt9000105', { season: 1, episode: 1 });
    assert.equal(doPedido.length, 1, 'a chave pedida guarda só o que é dela');
    assert.equal(doPedido[0].hash, '9'.repeat(40), 'e a dublada do episódio sobrevive ao teto');
  } finally {
    config.releaseIndex.maxReleases = saved;
  }
});

test('filme não é roteado: continua na chave da obra', () => {
  const hash = '4'.repeat(40);
  record('tt9000106', {}, [serieRel(hash, 'Filme Qualquer S02E01 no nome 1080p')]);
  assert.ok(cache.get(`${prefix('idx')}tt9000106`), 'filme ignora marcação de episódio no título');
});

// --- Prova de episódio errado (miss) ------------------------------------------
//
// A evidência é fina: "este hash não serve ESTE episódio". Marca SÓ a chave do
// episódio — nunca a da temporada nem a da obra — porque o mesmo pack pode
// servir todos os outros episódios que promete.

test('markMissing grava só a chave do episódio e isMissing é por episódio', () => {
  const hash = '5'.repeat(40);
  const written = markMissing('tt9000200', { season: 3, episode: 2 }, hash);
  assert.equal(written, 1);
  // Chave exata no cache, com hash em minúsculas.
  assert.ok(cache.get(`${prefix('idx')}miss:tt9000200:S3E2:${hash}`));
  assert.equal(isMissing('tt9000200', { season: 3, episode: 2 }, hash), true);
  // O MESMO hash continua valendo para os outros episódios.
  assert.equal(isMissing('tt9000200', { season: 3, episode: 7 }, hash), false);
  assert.equal(isMissing('tt9000200', { season: 2, episode: 2 }, hash), false);
  // Hash maiúsculo casa com a marca minúscula (infoHash é case-insensitive).
  assert.equal(isMissing('tt9000200', { season: 3, episode: 2 }, hash.toUpperCase()), true);
});

test('markMissing sem temporada ou episódio é no-op', () => {
  const hash = '6'.repeat(40);
  assert.equal(markMissing('tt9000201', { season: 3 }, hash), 0);
  assert.equal(markMissing('tt9000201', { episode: 2 }, hash), 0);
  assert.equal(markMissing('tt9000201', {}, hash), 0);
  assert.equal(isMissing('tt9000201', { season: 3 }, hash), false);
});

test('markMissing/isMissing respeitam as mesmas guardas do markLied', () => {
  const hash = '7'.repeat(40);
  // Sem tt não é obra válida; sem hash não há o que marcar.
  assert.equal(markMissing('9000202', { season: 1, episode: 1 }, hash), 0);
  assert.equal(markMissing('tt9000202', { season: 1, episode: 1 }, ''), 0);
  assert.equal(isMissing('9000202', { season: 1, episode: 1 }, hash), false);
});

test('RELEASE_INDEX=false também desliga a prova de miss', () => {
  const original = config.releaseIndex.enabled;
  const hash = '8'.repeat(40);
  try {
    config.releaseIndex.enabled = false;
    assert.equal(markMissing('tt9000203', { season: 1, episode: 1 }, hash), 0);
    assert.equal(isMissing('tt9000203', { season: 1, episode: 1 }, hash), false);
  } finally {
    config.releaseIndex.enabled = original;
  }
});

test('prova pelo arquivo: áudio e resolução reais por hash', () => {
  // "BR" na listagem é a nacionalidade do INDEXER, não o áudio, e a resolução
  // do post mente: medido no True Detective S03E03, duas fontes RedeTorrent
  // com rótulo idêntico "1080p BR" — uma "H264-METCON" (inglês) e uma "DUAL"
  // (dublada, e o arquivo é 720p apesar do post dizer 1080p).
  const dub = '4014bd0d914c1fffc58921a0e079d01f4a7e0644';
  const eng = 'fd01ca97a24acb6a7ed9810859348c3cf258d1e4';
  assert.equal(fileEvidence(dub), null, 'sem prova antes de qualquer play');

  markFileEvidence(dub, { a: 'Dual', q: '720p', n: 'True.Detective.S03E03.720p.WEB-DL.DUAL.mkv' });
  markFileEvidence(eng, { a: '', e: 1, q: '1080p', n: 'True.Detective.S03E03.1080p.WEB.H264-METCON.mkv' });

  assert.equal(fileEvidence(dub)!.a, 'Dual', 'guarda o RÓTULO do arquivo; quem combina com a origem BR é o toStremioStream');
  assert.equal(fileEvidence(dub)!.q, '720p', 'a resolução vem do arquivo, não do post');
  assert.equal(fileEvidence(eng)!.e, 1, 'release de cena reconhecida é a prova negativa');
  // Por hash e sem escopo de conta: o conteúdo do torrent é o mesmo para todos.
  assert.equal(fileEvidence('0'.repeat(40)), null, 'hash sem prova continua sem veredito');
});

// --- Registro parcial (Etapa 5) ----------------------------------------------
//
// A colheita interrompida (teto horário ou preempção por tráfego) grava o que
// já veio com a marca `partial`: o fast-path da busca não pode servir uma obra
// que ainda está pela metade. Gravação completa seguinte limpa — last-write-wins.

test('Etapa 5: record { partial: true } marca e isPartial espelha as três chaves do lookup', () => {
  // Marca na chave da TEMPORADA (pack de temporada): a busca do episódio lê a
  // temporada primeiro, então a vê.
  record('tt9000300', { season: 2 }, [serieRel('a2'.repeat(20), 'Serie Teste 2ª Temporada (2024) DUBLADO', { isBr: true })], { partial: true });
  assert.equal(isPartial('tt9000300', { season: 2, episode: 5 }), true, 'S2 alcança a busca de S2E5');
  // Marca na RAÍZ (obra inteira): qualquer temporada/episódio a enxerga pelo
  // último degrau do lookup.
  record('tt9000300', {}, [release('a3'.repeat(20), { title: 'Filme Teste 1080p DUBLADO' })], { partial: true });
  assert.equal(isPartial('tt9000300', { season: 7, episode: 2 }), true, 'a raiz alcança temporada distante (S7E2)');
  assert.equal(isPartial('tt9000300'), true, 'a raiz marca a obra inteira');
});

test('Etapa 5: gravação completa limpa o flag e a marca de S2E5 não vaza para S2E7', () => {
  const hash = 'b1'.repeat(20);
  record('tt9000301', { season: 2, episode: 5 }, [serieRel(hash, 'Serie Teste S02E05 DUBLADO')], { partial: true });
  assert.equal(isPartial('tt9000301', { season: 2, episode: 5 }), true, 'parcial marca o episódio');

  // Gravação default (completa) reescreve a MESMA chave sem o flag.
  record('tt9000301', { season: 2, episode: 5 }, [serieRel(hash, 'Serie Teste S02E05 DUBLADO')]);
  assert.equal(isPartial('tt9000301', { season: 2, episode: 5 }), false, 'completa limpa o flag (last-write-wins)');

  // Granularidade: o parcial de S2E7 bloqueia S2E7 mas deixa S2E5 limpo.
  record('tt9000301', { season: 2, episode: 7 }, [serieRel('b2'.repeat(20), 'Serie Teste S02E07 DUBLADO')], { partial: true });
  assert.equal(isPartial('tt9000301', { season: 2, episode: 7 }), true, 'S2E7 parcial bloqueia S2E7');
  assert.equal(isPartial('tt9000301', { season: 2, episode: 5 }), false, 'S2E7 não vaza para S2E5');
});

test('Etapa 5: markLied preserva o flag parcial', () => {
  const hash = 'c1'.repeat(20);
  record('tt9000302', { season: 3, episode: 1 }, [serieRel(hash, 'Serie Teste S03E01 DUBLADO')], { partial: true });
  markLied('tt9000302', { season: 3, episode: 1 }, hash);
  assert.equal(isPartial('tt9000302', { season: 3, episode: 1 }), true, 'prova de mentira não apaga a marca parcial');
});

test('Etapa 5: markMissing não cria entrada parcial — isPartial segue false', () => {
  const hash = 'd1'.repeat(20);
  markMissing('tt9000303', { season: 2, episode: 8 }, hash);
  assert.equal(isMissing('tt9000303', { season: 2, episode: 8 }, hash), true, 'a prova de miss existe na chave própria');
  assert.equal(isPartial('tt9000303', { season: 2, episode: 8 }), false, 'miss não é entrada idx nem marca parcial');
});

test('Etapa 5: desligado e obra inválida são false; lote vazio não grava', async () => {
  const original = config.releaseIndex.enabled;
  try {
    assert.equal(isPartial('9000304', { season: 1 }), false, 'sem tt não é obra válida');
    record('tt9000304', { season: 2 }, [], { partial: true });
    assert.equal(isPartial('tt9000304', { season: 2 }), false, 'lote vazio não grava nem marca');
    config.releaseIndex.enabled = false;
    assert.equal(isPartial('tt9000304', { season: 2 }), false, 'RELEASE_INDEX=false desliga a leitura');
  } finally {
    config.releaseIndex.enabled = original;
  }
});

test('clearPartial limpa partial em todas as chaves da obra sem apagar releases', () => {
  // Série semeada grava partial na raiz; episódio enxerga pelo degrau final do
  // isPartial — clearPartial precisa limpar a obra inteira (não só a location).
  record('tt9000310', {}, [serieRel('e1'.repeat(20), 'Serie Semeada 1ª Temporada DUBLADO', { isBr: true })], { partial: true });
  record('tt9000310', { season: 1, episode: 1 }, [serieRel('e2'.repeat(20), 'Serie Semeada S01E01 DUBLADO')], { partial: true });
  assert.equal(isPartial('tt9000310', { season: 1, episode: 1 }), true, 'raiz+episódio parciais bloqueiam');

  const cleared = clearPartial('tt9000310', { season: 1, episode: 1 });
  assert.ok(cleared >= 2, `limpou ao menos raiz e episódio (cleared=${cleared})`);
  assert.equal(isPartial('tt9000310', { season: 1, episode: 1 }), false, 'fast-path liberado após clearPartial');
  assert.equal(lookup('tt9000310', { season: 1, episode: 1 }).length >= 1, true, 'releases preservadas');

  // Prefixo estrito: tt9000310 não pode limpar tt90003101.
  record('tt90003101', {}, [release('e3'.repeat(20), { title: 'Outra Obra 1080p DUBLADO' })], { partial: true });
  clearPartial('tt9000310');
  assert.equal(isPartial('tt90003101'), true, 'obra com id prefixo-irmão permanece parcial');
});
