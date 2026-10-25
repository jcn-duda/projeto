// Mico Leão Dublado V2 no Node: só o card virtual da /configure. A busca ao
// vivo é do gateway nativo (`adom-search`) e a descoberta/captura é do raspador
// (`adom-crawl`) — o `search` TS (fetch, breaker, captura do banco) saiu com a
// T2-L4, quando o último chamador de `captureItems` deixou o src.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const { catalogEntry, MICO_ID } = await import('../src/providers/mico.js');

test('card: entra no catálogo como BR e virtual', () => {
  const saved = config.mico.enabled;
  config.mico.enabled = true;
  try {
    const card = catalogEntry();
    assert.ok(card, 'card presente com MICO_ENABLED=true');
    assert.equal(card.id, MICO_ID);
    assert.equal(card.language, 'pt-BR');
    assert.equal(card.isBr, true);
    assert.equal(card.virtual, true, 'card virtual fica fora da prova de vida do Jackett');
  } finally {
    config.mico.enabled = saved;
  }
});

test('MICO_ENABLED=false: o card some do catálogo', () => {
  const saved = config.mico.enabled;
  config.mico.enabled = false;
  try {
    assert.equal(catalogEntry(), null);
  } finally {
    config.mico.enabled = saved;
  }
});
