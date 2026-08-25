import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import { applyDebrid } from '../src/providers/debrid-pipeline.js';
import type { Stream } from '../types/domain.js';

process.env.CACHE_PERSIST = 'false';

/**
 * O ⚡ no Real-Debrid.
 *
 * O RD aposentou o /torrents/instantAvailability, então `checkCached` devolve
 * vazio e a resposta sempre cai no caminho `known: false`. Só que o que já está
 * PRONTO na conta toca na hora — é ⚡ legítimo, e o único que sobrou. O
 * inventário já era lido, mas alimentava só o autofetch: a lista inteira saía
 * [RD download] mesmo com o arquivo baixado na conta do usuário.
 *
 * `known` continua false de propósito: a conta responde pelo que ELA tem, não
 * pelo cache global do serviço, então o corte do cachedOnly não ganha base para
 * descartar o resto.
 */

const KEY = 'chave-rd-raio';
const NA_CONTA = 'a'.repeat(40);
const FORA = 'b'.repeat(40);

function stream(infoHash: string, title: string): Stream {
  return { name: 'Power', title, infoHash, sources: [] } as unknown as Stream;
}

/** Roda o applyDebrid como se a requisicao viesse da config selada informada. */
function comConfig(extra: Record<string, unknown>, streams: Stream[]) {
  const seg = Buffer.from(JSON.stringify({ ds: 'realdebrid', dk: KEY, ...extra }), 'utf8').toString('base64url');
  return runtime.run({ opts: runtime.decode(seg), encoded: seg } as any, () => applyDebrid(streams));
}

function semeiaInventario() {
  cache.set(
    `${prefix('dinv')}realdebrid:${accountScope(KEY)}`,
    [{ title: 'Filme Pronto 1080p.mkv', infoHash: NA_CONTA, size: 100 }],
    600,
  );
}

test('item pronto na conta do Real-Debrid sai com ⚡; o resto segue download', async () => {
  semeiaInventario();
  const out = await comConfig({ dc: false }, [
    stream(NA_CONTA, 'Filme Pronto 1080p'),
    stream(FORA, 'Outro Filme 1080p'),
  ]);
  const nomes = out.map((s: Stream) => String(s.name || ''));
  assert.equal(out.length, 2, 'sem cachedOnly nada e descartado');
  assert.match(nomes[0], /⚡/, 'o que esta pronto na conta merece o raio');
  assert.doesNotMatch(nomes[1], /⚡/, 'o que nao esta na conta nao pode fingir play instantaneo');
});

/**
 * "Sem raio nao aparece": com cachedOnly ligado o corte tambem vale no caminho
 * `known: false` do Real-Debrid. So roda porque o inventario da conta
 * respondeu — e conhecimento COMPLETO sobre o que toca na hora.
 */
test('cachedOnly esconde quem nao tem ⚡ mesmo com known false', async () => {
  semeiaInventario();
  const out = await comConfig({ dc: true, bu: false }, [
    stream(NA_CONTA, 'Filme Pronto 1080p'),
    stream(FORA, 'Outro Filme 1080p'),
  ]);
  assert.equal(out.length, 1, 'so sobra o que toca na hora');
  assert.match(String(out[0].name || ''), /⚡/);
  // O viaDebrid troca o infoHash por uma URL de /resolve: a identidade do que
  // sobrou se confere pelo hash dentro dela.
  assert.match(String(out[0].url || ''), new RegExp(NA_CONTA));
});

/**
 * Guarda-corpo: memo de inventario FRIO nao pode acionar o corte. Sem esta
 * trava, cachedOnly com conjunto vazio apagaria a lista inteira.
 */
test('cachedOnly nao corta nada quando o inventario esta frio', async () => {
  cache.forget(`${prefix('dinv')}realdebrid:${accountScope(KEY)}`);
  const out = await comConfig({ dc: true }, [
    stream(NA_CONTA, 'Filme Pronto 1080p'),
    stream(FORA, 'Outro Filme 1080p'),
  ]);
  assert.equal(out.length, 2, 'memo frio nao e prova de ausencia');
});

/**
 * O ⚡ que APRENDE.
 *
 * O Real-Debrid não responde mais pelo cache global dele, então o inventário da
 * conta cobria só o que o usuário já tinha baixado. Mas todo play que dá certo
 * já grava `magnetdb.markAlive` — o addon sabia, e usava esse histórico só para
 * ORDENAR, nunca para rotular. Ligado no ⚡, o raio cresce sozinho: o que você
 * tocou uma vez volta marcado nas próximas buscas.
 */
test('hash com play comprovado nesta conta volta com ⚡ pelo histórico', async () => {
  const magnetdb = await import('../src/utils/magnetdb.js');
  cache.forget(`${prefix('dinv')}realdebrid:${accountScope(KEY)}`);
  magnetdb.markAlive('realdebrid', KEY, [FORA]);

  const out = await comConfig({ dc: false }, [
    stream(NA_CONTA, 'Nunca Tocado 1080p'),
    stream(FORA, 'Ja Tocou Antes 1080p'),
  ]);

  const nomes = out.map((s: Stream) => String(s.name || ''));
  assert.doesNotMatch(nomes[0], /⚡/, 'sem inventario e sem historico, nao ha o que prometer');
  assert.match(nomes[1], /⚡/, 'o que ja tocou nesta conta merece o raio');
});

/**
 * Guarda-corpo: onde a checagem de cache FUNCIONA (AllDebrid), ela é a
 * autoridade. Sobrepor a resposta dela com memória de 7 dias atrás produziria
 * ⚡ falso justamente onde existe informação melhor.
 */
test('histórico não inventa ⚡ em adaptador que sabe checar cache', async () => {
  const magnetdb = await import('../src/utils/magnetdb.js');
  const alldebrid = await import('../src/debrid/alldebrid.js');
  assert.equal(alldebrid.cacheCheck, true, 'premissa do teste: a AllDebrid checa cache');

  magnetdb.markAlive('alldebrid', KEY, [FORA]);
  const seg = Buffer.from(JSON.stringify({ ds: 'alldebrid', dk: KEY, dc: false }), 'utf8').toString('base64url');

  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  // A conta responde que NADA esta em cache. O historico nao pode contradizer.
  globalThis.fetch = (async () => ({
    ok: true, status: 200,
    async json() { return { status: 'success', data: { magnets: [] } }; },
  })) as unknown as typeof globalThis.fetch;

  try {
    const out = await runtime.run(
      { opts: runtime.decode(seg), encoded: seg } as any,
      () => applyDebrid([stream(FORA, 'Ja Tocou Antes 1080p')]),
    );
    for (const s of out) {
      assert.doesNotMatch(String(s.name || ''), /⚡/, 'a checagem real manda; historico nao sobrepoe');
    }
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});

/**
 * 429 do debrid não é defeito do torrent: trocar de fonte não resolve e ainda
 * piora o limite. Antes caía no 502 "falha ao resolver" genérico, que empurra
 * o usuário a exatamente a atitude errada.
 */
test('json() classifica 429 como RateLimitError, separado de bloqueio', async () => {
  const { json, isRateLimitError, isBlockedError } = await import('../src/debrid/common.js');
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  globalThis.fetch = (async () => ({
    ok: false, status: 429,
    async text() { return '{"error":"too_many_requests","error_code":34}'; },
  })) as unknown as typeof globalThis.fetch;
  try {
    const err = await json('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', { method: 'POST' })
      .then(() => null, (e: any) => e);
    assert.ok(isRateLimitError(err), 'tem que ser RateLimitError');
    assert.ok(!isBlockedError(err), 'limite de taxa nao e bloqueio de conteudo');
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  }
});
