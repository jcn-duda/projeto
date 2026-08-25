import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/runtime.js';
import * as cache from '../src/utils/cache.js';
import { prefix } from '../src/utils/cache-keys.js';
import { accountScope } from '../src/utils/request-key.js';
import { buildStreams } from '../src/providers/index.js';
import { looksPtBr } from '../src/utils/format.js';
import type { Stream } from '../types/domain.js';

process.env.CACHE_PERSIST = 'false';

/**
 * Reprodução do caso medido em produção (2026-08-25): o usuário instala com
 * Real-Debrid + cachedOnly ("sem raio não aparece") e o filme PRONTO na conta
 * ("Mestres do Universo 1987 BluRay 1080p X264 DUAL 2.0") some da lista — a
 * resposta sai com o aviso "Nenhuma fonte pronta — N resultado(s) fora do
 * cache", mesmo com o inventário quente e o hash do item dentro dele.
 *
 * A instalação real: dc=1, q1=2 (teto por qualidade), b=3, bf=1, d=1, a=1.
 * Os indexers globais devolvem 1080p com muito mais seeders que o item da
 * conta (seeders: 1, porque conta não tem swarm).
 */

const KEY = 'chave-rd-repro';
const NA_CONTA = '7'.repeat(40);

const runWith = <T>(patch: object, fn: () => unknown) => runtime.run(patch, fn) as Promise<T>;

function optsUsuario(extra: Record<string, unknown> = {}) {
  return {
    ...runtime.defaults(),
    debridService: 'realdebrid',
    debridApiKey: KEY,
    debridCachedOnly: true,
    showUncachedBr: false,
    autoFetchBr: false,
    max1080p: 2,
    maxResults: 40,
    qualities: ['2160p', '1080p', '720p'],
    minSeeders: 1,
    brReservedSlots: 3,
    brFirst: true,
    dubbedOnly: true,
    preferDubbed: true,
    ...extra,
  };
}

function semeiaInventario() {
  cache.set(
    `${prefix('dinv')}realdebrid:${accountScope(KEY)}`,
    [{ title: 'Mestres do Universo 1987 BluRay 1080p X264 DUAL 2.0', infoHash: NA_CONTA, size: 8_500_000_000, id: '99' }],
    600,
  );
}

const META = { name: 'Masters of the Universe', year: '1987' };
const TITLES = { pt: 'Mestres do Universo', original: 'Masters of the Universe', year: '1987' };

function busca(raw: any[], extra: Record<string, unknown> = {}) {
  return runWith<Stream[]>(
    { opts: optsUsuario(extra), encoded: `seg-${Math.random()}` },
    () => buildStreams(raw, {
      meta: META,
      titles: TITLES,
      season: null,
      episode: null,
      isDemo: false,
      searchKey: `repro-${Math.random()}`,
    } as any),
  );
}

test('repro: item pronto da conta sobrevive ao POOL com balde 1080p cheio', async () => {
  cache.clear();
  semeiaInventario();
  const tituloConta = 'Mestres do Universo 1987 BluRay 1080p X264 DUAL 2.0';
  // Espelho da produção: 30+ releases globais 1080p com mais seeders que o
  // item da conta (que não tem swarm). Sem o instant do inventário, o item
  // fica na posição ~30 do balde e o round-robin (alvo 2×4=8) nunca chega
  // nele — morre no pool de candidatos, antes do debrid.
  const globais: any[] = [];
  const grupos = ['GROUP', 'RARBG', 'YIFY', 'SPARKS', 'AMIABLE', 'DRONES'];
  for (let i = 0; i < 30; i += 1) {
    globais.push({
      title: `Masters of the Universe 1987 1080p BluRay x264-${grupos[i % grupos.length]}${i}`,
      infoHash: `${(i + 2).toString(16).padStart(2, '0')}${'c'.repeat(38)}`,
      seeders: 20 + i * 7,
      size: 5_000_000_000 + i * 100_000_000,
      indexer: i % 2 ? 'yts' : 'thepiratebay',
      tracker: i % 2 ? 'YTS' : 'The Pirate Bay',
    });
  }
  const raw = [
    {
      title: tituloConta,
      infoHash: NA_CONTA,
      seeders: 1,
      size: 8_500_000_000,
      indexer: 'debrid',
      tracker: 'Real-Debrid',
      // account.search calcula isBr por looksPtBr — "DUAL" sem PT explícito
      // NÃO é BR, igualzinho à produção.
      isBr: looksPtBr(tituloConta),
      fromAccount: true,
    },
    ...globais,
  ];
  const streams = await busca(raw);
  const comRaio = streams.filter((s) => /⚡/.test(String(s.name || '')));
  assert.ok(
    comRaio.some((s) => String(s.url || '').includes(NA_CONTA)),
    `o item pronto da conta tem que sair com ⚡; saiu: ${JSON.stringify(streams.map((s) => (s.name || '').split('\n')[0]))}`,
  );
});

test('repro (mínimo): só o item da conta, sem concorrentes', async () => {
  cache.clear();
  semeiaInventario();
  const tituloConta = 'Mestres do Universo 1987 BluRay 1080p X264 DUAL 2.0';
  const raw = [
    {
      title: tituloConta,
      infoHash: NA_CONTA,
      seeders: 1,
      size: 8_500_000_000,
      indexer: 'debrid',
      tracker: 'Real-Debrid',
      isBr: looksPtBr(tituloConta),
      fromAccount: true,
    },
  ];
  const streams = await busca(raw);
  assert.equal(streams.length, 1, `esperava o item da conta; saiu: ${JSON.stringify(streams.map((s) => ({ n: (s.name || '').split('\n')[0], t: (s.title || '').slice(0, 80) })))}`);
  assert.match(String(streams[0].name || ''), /⚡/);
});
