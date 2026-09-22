// Rodada 2: checagem ligada; o aviso de lista vazia é testado sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStreams, applyNoticeOrigin, findStreams, applyDebrid } from '../src/providers/index.js';
import debrid from '../src/debrid/index.js';
import * as runtime from '../src/runtime.js';
import config from '../src/config.js';
import { originOf } from '../src/app.js';
import type { RawItem, Stream } from '../types/domain.js';

const A = 'a'.repeat(40);

// O aviso só existe para explicar uma lista que ficaria vazia. Os três estados
// são excludentes e a ordem importa: "já mandei baixar" é mais preciso que
// "cortei por cache", que é mais preciso que "ainda não achei".

/**
 * Opções do helper `build`. `season`/`episode` aceitam null de propósito: filme
 * sem candidato não recebe aviso, e é o teste que manda esse estado — o null
 * não é "não informado", é "não é série".
 */
interface BuildOptions {
  season?: number | null;
  episode?: number | null;
  cached?: string[];
  cachedOnly?: boolean;
  publicUrl?: string;
  origin?: string;
}

/**
 * @param {import('../types/domain').RawItem[]} raw
 * @param {BuildOptions} [options]
 */
async function build(raw: RawItem[], { season = 1, episode = 1, cached = [], cachedOnly = true, publicUrl = 'https://addon.teste', origin }: BuildOptions = {}): Promise<Stream[]> {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = publicUrl;
  debrid.checkCached = async () => ({ cached: new Set(cached), known: true });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: cachedOnly,
    autoFetchBr: false,
    // Suites de aviso/EN sem claim: defaults do operador podem ter d:1.
    dubbedOnly: false,
  };
  try {
    // `origin` entra no patch só quando o teste manda: fora de request o store
    // não tem origin, e um `undefined` explícito não deve fingir que há um.
    return await runtime.run(
      { opts: userOpts, encoded: 'segcfg', ...(origin === undefined ? {} : { origin }) },
      async () => {
        // A assinatura do `buildStreams` exige `deadlineAt`/`onDebridResult`,
        // que o caminho de teste não manda: o cast `any` cobre o objeto parcial
        // sem inventar valor nenhum (mesmo contrato do helper de outros testes).
        const streams = await buildStreams(raw, {
          meta: null,
          titles: null,
          season,
          episode,
          isDemo: false,
          searchKey: `aviso-${Math.random()}`,
        } as any);
        // O que o cliente recebe é a lista já fechada pela resposta — é lá que o
        // link do aviso é montado, e é esse contrato que os testes cobram.
        return applyNoticeOrigin(streams);
      });
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
  }
}

// 1080p no título: com QUALITY_FILTER=2160p,1080p,720p no .env do operador,
// "sem resolução" some no sortAndLimit e o aviso virava "procurando a temporada"
// — falso negativo que depende do ambiente, não do contrato do notice.
const episodio = (extra = {}) => ({
  title: 'Lost Girl S01E01 1080p HDTV XviD',
  infoHash: A,
  seeders: 1,
  indexer: 'thepiratebay',
  ...extra,
});

test('série sem nenhum candidato avisa que a temporada está sendo procurada', async () => {
  const streams = await build([]);
  assert.equal(streams.length, 1);
  assert.match(streams[0].name as string, /procurando a temporada/);
  // Não pode parecer tocável: cliente que aceita infoHash tentaria dar play.
  assert.equal(streams[0].url, undefined);
  assert.equal(streams[0].infoHash, undefined);
  assert.ok(streams[0].externalUrl);
});

test('aviso sem origin nenhum não vira item morto na lista', async () => {
  // Sem PUBLIC_URL E sem origin de requisição não existe endereço que o cliente
  // alcance para montar o clique. Emitir o aviso mesmo assim geraria um item
  // morto (sem url, sem infoHash, sem externalUrl) que ocupa a tela e some; a
  // lista vazia deixa o Stremio mostrar a tela nativa de "nada encontrado".
  const streams = await build([], { publicUrl: '' });
  assert.deepEqual(streams, []);
});

test('aviso usa o origin da requisição quando não há PUBLIC_URL', async () => {
  // O caso do print/LAN: aparelho acessa o addon por http://192.168.0.23:7000 e
  // a instância não tem PUBLIC_URL. O origin da requisição é um endereço que o
  // cliente alcança, então é o destino honesto do clique do aviso.
  const streams = await build([], { publicUrl: '', origin: 'http://192.168.0.23:7000' });
  assert.equal(streams.length, 1);
  assert.match(streams[0].name as string, /procurando a temporada/);
  assert.equal(streams[0].externalUrl, 'http://192.168.0.23:7000/segcfg/configure');
});

test('PUBLIC_URL tem precedência sobre o origin da requisição', async () => {
  const streams = await build([], { publicUrl: 'https://publico.com', origin: 'http://192.168.0.23:7000' });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].externalUrl, 'https://publico.com/segcfg/configure');
});

// --- Play /resolve: host na resposta, path relativo no cache ---

/** Bake de play via applyDebrid (URL relativa) + egressão applyNoticeOrigin. */
async function bakeResolve(opts: { publicUrl?: string; origin?: string } = {}): Promise<{ baked: Stream; delivered: Stream[] }> {
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  const { publicUrl = '', origin } = opts;
  config.debrid.publicUrl = publicUrl;
  debrid.checkCached = async () => ({ cached: new Set([A]), known: true });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: true,
    autoFetchBr: false,
  };
  const input: Stream = {
    name: '1080p\nTorrentio',
    title: 'Filme 1080p',
    infoHash: A,
    sources: ['tracker:test'],
  };
  try {
    const baked = (await runtime.run(
      { opts: userOpts, encoded: 'segcfg', ...(origin === undefined ? {} : { origin }) },
      () => applyDebrid([input], { searchKey: `resolve-bake-${Math.random()}` } as any),
    )) as Stream[];
    assert.equal(baked.length, 1);
    const delivered = runtime.run(
      { opts: userOpts, encoded: 'segcfg', ...(origin === undefined ? {} : { origin }) },
      () => applyNoticeOrigin(baked),
    ) as unknown as Stream[];
    return { baked: baked[0], delivered };
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
  }
}

test('viaDebrid bakeia /resolve relativo (sem host) e a egressão injeta o origin', async () => {
  const { baked, delivered } = await bakeResolve({ publicUrl: '', origin: 'http://192.168.0.23:7000' });
  assert.match(baked.url as string, new RegExp(`^/segcfg/resolve/${A}\\?sig=[a-f0-9]{64}$`));
  assert.doesNotMatch(baked.url as string, /^https?:\/\//);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].url, `http://192.168.0.23:7000${baked.url}`);
});

test('mesma lista cacheada: origin LAN vs localhost → hosts diferentes no play', async () => {
  // Entrada relativa compartilhada (como o cache guarda depois do bake).
  const relative = `/segcfg/resolve/${A}?s=1&e=2&sig=${'ab'.repeat(32)}`;
  const cached: Stream[] = [{ name: '[PM⚡] 1080p', url: relative }];
  const userOpts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'k' };
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = '';
  try {
    const naTv = runtime.run(
      { opts: userOpts, encoded: 'segcfg', origin: 'http://192.168.0.23:7000' },
      () => applyNoticeOrigin(cached),
    ) as unknown as Stream[];
    const noLocal = runtime.run(
      { opts: userOpts, encoded: 'segcfg', origin: 'http://127.0.0.1:7000' },
      () => applyNoticeOrigin(cached),
    ) as unknown as Stream[];
    assert.equal(naTv[0].url, `http://192.168.0.23:7000${relative}`);
    assert.equal(noLocal[0].url, `http://127.0.0.1:7000${relative}`);
  } finally {
    config.debrid.publicUrl = originalPublicUrl;
  }
});

test('PUBLIC_URL canônico vence o Host no play /resolve', async () => {
  const { delivered } = await bakeResolve({
    publicUrl: 'https://publico.com',
    origin: 'http://192.168.0.23:7000',
  });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].url as string, new RegExp(`^https://publico\\.com/segcfg/resolve/${A}\\?sig=`));
});

test('rewrite de /resolve preserva a query (sig intacto) e aceita absoluto legado', async () => {
  const sig = 'cd'.repeat(32);
  const legacy = `http://10.0.0.5:7000/segcfg/resolve/${A}?w=%7B%22d%22%3A1%7D&sig=${sig}`;
  const userOpts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'k' };
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = '';
  try {
    const out = runtime.run(
      { opts: userOpts, encoded: 'segcfg', origin: 'http://192.168.0.23:7000' },
      () => applyNoticeOrigin([{ name: '[PM⚡]', url: legacy }]),
    ) as unknown as Stream[];
    assert.equal(out.length, 1);
    assert.equal(
      out[0].url,
      `http://192.168.0.23:7000/segcfg/resolve/${A}?w=%7B%22d%22%3A1%7D&sig=${sig}`,
    );
    assert.equal(new URL(out[0].url as string).searchParams.get('sig'), sig);
  } finally {
    config.debrid.publicUrl = originalPublicUrl;
  }
});

test('resolve-url sem base é descartado (espelha o aviso sem link)', () => {
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = '';
  try {
    const out = runtime.run(
      { opts: runtime.defaults(), encoded: 'segcfg' },
      () => applyNoticeOrigin([{ name: '[PM⚡]', url: `/segcfg/resolve/${A}?sig=1` }]),
    ) as unknown as Stream[];
    assert.deepEqual(out, []);
  } finally {
    config.debrid.publicUrl = originalPublicUrl;
  }
});

test('o cache guarda o TEXTO do aviso, nunca o link de um cliente', async () => {
  // `streamsCacheKey` não carrega o origin, então a lista do buildStreams é
  // compartilhada entre aparelhos. Se o link fosse montado lá, a TV que chama
  // 192.168.0.23 deixaria esse endereço para o celular que chama pelo domínio —
  // e um `Host` forjado envenenaria a entrada para o próximo cliente.
  const originalCheck = debrid.checkCached;
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = '';
  debrid.checkCached = async () => ({ cached: new Set(), known: true });
  const userOpts = {
    ...runtime.defaults(),
    debridService: 'premiumize',
    debridApiKey: 'chave-fake',
    debridCachedOnly: true,
    autoFetchBr: false,
  };
  try {
    const cacheado = await (runtime.run(
      { opts: userOpts, encoded: 'segcfg', origin: 'http://192.168.0.23:7000' },
      () => buildStreams([], {
        meta: null, titles: null, season: 1, episode: 1, isDemo: false,
        searchKey: `aviso-cache-${Math.random()}`,
      } as any),
    ) as Promise<Stream[]>);
    // É isto que vai para o cache: marca interna e texto, sem endereço nenhum.
    assert.equal(cacheado.length, 1);
    assert.equal(cacheado[0].notice, true);
    assert.equal(cacheado[0].externalUrl, undefined);

    // A MESMA entrada cacheada, servida a dois aparelhos, dá o link de cada um.
    const naTv = runtime.run({ opts: userOpts, encoded: 'segcfg', origin: 'http://192.168.0.23:7000' },
      () => applyNoticeOrigin(cacheado)) as unknown as Stream[];
    const noCelular = runtime.run({ opts: userOpts, encoded: 'segcfg', origin: 'https://meu.dominio' },
      () => applyNoticeOrigin(cacheado)) as unknown as Stream[];
    assert.equal(naTv[0].externalUrl, 'http://192.168.0.23:7000/segcfg/configure');
    assert.equal(noCelular[0].externalUrl, 'https://meu.dominio/segcfg/configure');
    // A marca interna não vaza para o objeto que o Stremio recebe.
    assert.equal(naTv[0].notice, undefined);
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
  }
});

test('originOf só aceita hostname/porta válidos (host é input do cliente)', () => {
  const originalPublicUrl = config.debrid.publicUrl;
  config.debrid.publicUrl = '';
  try {
    const req = (host: any) => ({ get: () => host, protocol: 'http' });
    // Barra e caminho no host não casam o regex: não propaga lixo no externalUrl.
    assert.equal(originOf(req('exemplo.com/evil')), null);
    assert.equal(originOf(req(null)), null);
    assert.equal(originOf(req('192.168.0.23:7000')), 'http://192.168.0.23:7000');
    // IPv6 entre colchetes também é aceito.
    assert.equal(originOf(req('[2001:db8::1]:7000')), 'http://[2001:db8::1]:7000');
  } finally {
    config.debrid.publicUrl = originalPublicUrl;
  }
});

test('filme sem candidato NÃO recebe aviso: não há busca de pack para prometer', async () => {
  const streams = await build([], { season: null, episode: null });
  assert.deepEqual(streams, []);
});

test('candidato cortado pelo cachedOnly avisa quantos ficaram de fora', async () => {
  const streams = await build([episodio()]);
  assert.equal(streams.length, 1);
  assert.match(streams[0].name as string, /1 resultado\(s\) fora do cache/);
});

test('com fonte tocável não há aviso nenhum', async () => {
  const streams = await build([episodio()], { cached: [A] });
  assert.equal(streams.length, 1);
  assert.doesNotMatch(streams[0].name as string, /procurando a temporada|fora do cache/);
});



// --- Aviso de deadline: busca que estoura o prazo devolve o quarto texto ---

const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

// Sem rede de verdade (mesmo padrão do swr-streams): o stub atrasa o bastante
// para o deadline de 1 ms vencer a coleta sempre. Sem ele, o doSearch em
// background tocaria Cinemeta/TMDB reais a cada execução da suíte.
const STUB_DELAY_MS = 200;
const realFetch = global.fetch;
function installFetchStub() {
  global.fetch = async () => {
    await sleep(STUB_DELAY_MS);
    return new Response('', { status: 404, statusText: 'Not Found' });
  };
}

/**
 * Contexto de requisição para teste de deadline: provider demo (sem Jackett),
 * sem debrid, fetch stub que nunca resolve rápido o suficiente para o prazo
 * mínimo. Usa id único para não dividir cacheKey nem inFlight com vizinhos.
 */
function deadlineRequest(fn: () => unknown): Promise<any> {
  const testOpts = {
    ...runtime.defaults(),
    providers: ['demo'],
    debridService: '',
    debridApiKey: '',
  };
  return runtime.run({ opts: testOpts, encoded: 'deadlinetest' }, fn) as Promise<any>;
}

test('série que estoura o prazo devolve aviso "Procurando fontes"', async () => {
  const originalDeadline = config.replyDeadline;
  // 1 ms: o timer dispara antes de qualquer rede responder. O fetch stub do
  // swr-streams serve como referência — aqui basta o prazo mínimo.
  config.replyDeadline = 1;
  const id = `tt${Date.now()}1`;
  installFetchStub();
  try {
    const result = await deadlineRequest(() => findStreams({ type: 'series', id }));
    assert.equal(result.partial, true, 'deve ser parcial');
    assert.equal(result.streams.length, 1, 'deve ter 1 aviso');
    assert.equal(result.streams[0].notice, true);
    assert.match(result.streams[0].name, /Procurando fontes/);
    // O link vem do applyNoticeOrigin na resposta, não do fallback.
    assert.equal(result.streams[0].externalUrl, undefined);
    assert.equal(result.streams[0].url, undefined);
    assert.equal(result.streams[0].infoHash, undefined);
    // Deixa o doSearch em background assentar com o stub ainda no ar.
    await sleep(STUB_DELAY_MS * 2);
  } finally {
    config.replyDeadline = originalDeadline;
    global.fetch = realFetch;
  }
});

test('filme que estoura o prazo também devolve o aviso de deadline', async () => {
  const originalDeadline = config.replyDeadline;
  config.replyDeadline = 1;
  const id = `tt${Date.now()}2`;
  installFetchStub();
  try {
    const result = await deadlineRequest(() => findStreams({ type: 'movie', id }));
    assert.equal(result.partial, true);
    assert.equal(result.streams.length, 1);
    assert.match(result.streams[0].name, /Procurando fontes/);
    assert.equal(result.streams[0].notice, true);
    await sleep(STUB_DELAY_MS * 2);
  } finally {
    config.replyDeadline = originalDeadline;
    global.fetch = realFetch;
  }
});

test('kill-switch SEARCH_NOTICE_STREAM=false restaura fallback vazio no deadline', async () => {
  const originalDeadline = config.replyDeadline;
  const originalNotice = config.search.noticeStream;
  config.replyDeadline = 1;
  config.search.noticeStream = false;
  const id = `tt${Date.now()}3`;
  installFetchStub();
  try {
    const result = await deadlineRequest(() => findStreams({ type: 'series', id }));
    assert.equal(result.partial, true);
    assert.deepEqual(result.streams, [], 'kill-switch deve devolver lista vazia');
    await sleep(STUB_DELAY_MS * 2);
  } finally {
    config.replyDeadline = originalDeadline;
    config.search.noticeStream = originalNotice;
    global.fetch = realFetch;
  }
});
