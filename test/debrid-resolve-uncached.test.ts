// @ts-nocheck — rodada 1: checagem suspensa para fechar o portão do src;
// remover arquivo a arquivo na rodada 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';
import * as runtime from '../src/runtime.js';
import debrid from '../src/debrid/index.js';
import { applyDebrid } from '../src/providers/index.js';

process.env.CACHE_PERSIST = 'false';


const CACHEADO = 'a'.repeat(40);
const FRIO = 'b'.repeat(40);

/**
 * O sintoma que originou isto: num título sem NADA em cache, a busca vinha
 * cheia e a tela do cliente mostrava "Nenhum stream disponível". O addon estava
 * certo — devolvia torrent puro (infoHash, sem `url`) para o não-cacheado —, mas
 * cliente que só toca URL descarta esses streams, e a lista inteira sumia.
 *
 * `resolveUncached` é a saída opt-in: o não-cacheado também sai pelo /resolve.
 * Default off de propósito, porque isso escreve na conta do usuário no play.
 */
async function run({ resolveUncached, cached }) {
  const originalResolve = config.debrid.resolveUncached;
  const originalPublicUrl = config.debrid.publicUrl;
  const originalCheck = debrid.checkCached;

  config.debrid.resolveUncached = resolveUncached;
  config.debrid.publicUrl = 'http://addon.test';
  debrid.checkCached = async () => ({ cached: new Set(cached), known: true });

  const opts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-resolve-uncached',
    debridCachedOnly: false,
    autoFetchBr: false,
  };

  try {
    return await runtime.run({ opts, encoded: 'cfg' }, () =>
      applyDebrid(
        [
          { infoHash: CACHEADO, name: 'Release 1080p', title: 'Release 1080p' },
          { infoHash: FRIO, name: 'Release 720p', title: 'Release 720p' },
        ],
        { searchKey: `busca-${resolveUncached}` },
      ),
    );
  } finally {
    config.debrid.resolveUncached = originalResolve;
    config.debrid.publicUrl = originalPublicUrl;
    debrid.checkCached = originalCheck;
  }
}

test('padrão (off): o não-cacheado sai como torrent puro, sem url', async () => {
  const streams = await run({ resolveUncached: false, cached: [CACHEADO] });

  const quente = streams.find((s) => /1080p/.test(s.name));
  const frio = streams.find((s) => /720p/.test(s.name));

  assert.match(quente.url, /\/resolve\//, 'cacheado continua passando pelo /resolve');
  assert.equal(frio.url, undefined, 'sem cache não ganha url: é o contrato antigo');
  assert.equal(frio.infoHash, FRIO, 'e o hash continua lá para quem toca torrent');
});

test('resolveUncached: o frio também sai pelo /resolve, marcado como download', async () => {
  const streams = await run({ resolveUncached: true, cached: [CACHEADO] });

  const quente = streams.find((s) => /1080p/.test(s.name));
  const frio = streams.find((s) => /720p/.test(s.name));

  assert.match(frio.url, /\/resolve\//, 'o frio ganha url e para de sumir em cliente que só toca URL');
  assert.equal(frio.infoHash, undefined, 'stream resolvido não leva infoHash junto');
  // O ⚡ é promessa de play imediato: só o que está em cache pode carregá-lo.
  assert.ok(/⚡/.test(quente.name), 'cacheado mantém o raio');
  assert.ok(!/⚡/.test(frio.name), 'o frio NÃO pode ganhar raio: ele ainda vai baixar');
});

test('título sem nada em cache: com a trava ligada a lista inteira é jogável por URL', async () => {
  const streams = await run({ resolveUncached: true, cached: [] });

  assert.equal(streams.length, 2, 'nenhum stream é perdido');
  assert.ok(
    streams.every((s) => /\/resolve\//.test(s.url || '')),
    'era exatamente este o caso que chegava vazio na tela do cliente',
  );
});
