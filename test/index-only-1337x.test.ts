// 1337x vira index-only: fora do caminho da resposta (mesmo selecionado na
// config do usuário), fora das varreduras pt-BR, com a resolução /dl
// preservada e orçamento TOTAL dedicado no colhedor. Medição que motivou:
// busca fria de 12,2–19s (Cloudflare re-resolvido) e redirect /dl/ de
// 1,8–6,5s contra orçamento de 4s por indexer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

import config from '../src/config.js';
import { liveIndexers, ptSweepIndexers } from '../src/providers/search-plan.js';

test('default JACKETT_INDEX_ONLY_INDEXERS inclui 1337x', () => {
  assert.ok(config.jackett.indexOnlyIndexers.includes('1337x'), '1337x é index-only por default');
});

test('a resolução /dl do 1337x permanece em JACKETT_RESOLVE_DOWNLOAD_INDEXERS', () => {
  assert.ok(
    config.jackett.resolveDownloadIndexers.includes('1337x'),
    'o magnet do 1337x continua resolvendo no play/colhedor',
  );
});

test('default do orçamento dedicado do colhedor é 90000ms', () => {
  assert.equal(config.jackett.indexOnlyHarvestTimeout, 90000);
});

test('liveIndexers remove o 1337x do plano ao vivo mesmo quando o usuário o seleciona', () => {
  const selecionados = ['thepiratebay', '1337x', 'bludv-cardigann'];
  const vivos = liveIndexers(selecionados, config.jackett.indexOnlyIndexers);
  assert.ok(!vivos.includes('1337x'), '1337x fica fora da resposta');
  assert.deepEqual(vivos, ['thepiratebay', 'bludv-cardigann'], 'os demais seguem no plano');
  // Todos index-only: nenhum indexer vivo — e o caller NÃO reabre o /all.
  assert.deepEqual(liveIndexers(['1337x'], config.jackett.indexOnlyIndexers), []);
});

test('ptSweepIndexers exclui index-only (mesmo filtro da varredura tardia e do colhedor)', () => {
  const alvos = ptSweepIndexers(
    ['thepiratebay', '1337x', 'bludv-cardigann'],
    ['bludv-cardigann'],
    config.jackett.indexOnlyIndexers,
  );
  assert.deepEqual(alvos, ['thepiratebay'], 'só o global elegível resta');
  // Chamada antiga (sem o 3º parâmetro) preservada.
  assert.deepEqual(
    ptSweepIndexers(['thepiratebay', '1337x'], ['bludv-cardigann']),
    ['thepiratebay', '1337x'],
  );
});
