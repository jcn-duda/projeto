// Índice de releases por obra (`idx:v1`): a peça que faz o addon virar
// servidor. Cobertura do módulo: escrita idempotente com dedupe por hash,
// fallback de lookup (episódio → temporada → obra), exclusão do inventário da
// conta, kill-switches e status para o painel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import config from '../src/config.js';
import { prefix } from '../src/utils/cache-keys.js';
import { record, lookup, status } from '../src/utils/release-index.js';

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
  assert.equal(st.maxEntries, 4000);
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
