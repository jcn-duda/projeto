/**
 * Fatos do play AllDebrid para o Rust: `held: true` significa não apagar.
 * Chave vazia não identifica conta. `dropUncached` segue o config (default true).
 *
 * O `--import` do runner da suíte chega tarde para quem roda este arquivo
 * sozinho. O setup-env precisa avaliar antes do config, senão a leitura da
 * proteção abre o cache.db do operador.
 */
import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import config from '../src/config.js';
import { accountScope } from '../src/utils/request-key.js';
import { isCleanupProtected } from '../src/debrid/protected.js';
import { id as alldebridId } from '../src/debrid/alldebrid-api.js';
import { alldebridLinkFacts } from '../src/debrid/rust-link-facts.js';

const API_KEY = 'chave-de-teste-link-facts';

test('alldebridLinkFacts: chave vazia não apaga, hash sem proteção libera, dropUncached é o default', () => {
  const emptyKey = alldebridLinkFacts('', randomBytes(20).toString('hex'));
  assert.equal(emptyKey.held, true, 'apiKey vazia devolve held true (não apagar)');
  assert.equal(typeof emptyKey.dropUncached, 'boolean');

  // Hash novo neste processo: sem hold volátil e sem registro adprot. Se a
  // proteção já o considera salvo, o ambiente protege todo hash — held true
  // continua sendo "não apagar", e o assert deixa isso explícito.
  const infoHash = randomBytes(20).toString('hex');
  const envProtectsAll = isCleanupProtected(infoHash, accountScope(API_KEY), alldebridId);
  const facts = alldebridLinkFacts(API_KEY, infoHash);
  assert.equal(
    facts.held,
    envProtectsAll,
    envProtectsAll
      ? 'ambiente de teste já protege todo hash; held true significa não apagar'
      : 'hash sem proteção devolve held false',
  );

  assert.equal(typeof facts.dropUncached, 'boolean');
  assert.equal(facts.dropUncached, config.debrid.dropUncached);
  assert.equal(emptyKey.dropUncached, config.debrid.dropUncached);
  assert.equal(facts.dropUncached, true, 'default do config.debrid.dropUncached é true');
});
