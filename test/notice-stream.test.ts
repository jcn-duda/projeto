// Rodada 2: checagem ligada; o aviso de lista vazia é testado sem rede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStreams, applyNoticeOrigin, findStreams } from '../src/providers/index.js';
import { hasExplicitForeignAudio } from '../src/utils/format.js';
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
      }) as Promise<Stream[]>;
  } finally {
    debrid.checkCached = originalCheck;
    config.debrid.publicUrl = originalPublicUrl;
  }
}

const episodio = (extra = {}) => ({
  title: 'Lost Girl S01E01 HDTV XviD',
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
    const req = (host) => ({ get: () => host, protocol: 'http' });
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

// Gatilho da busca tardia de pack: a saúde do episódio é seeders E idioma.
// Medido em Lost Girl S01E01 — um "FRENCH HDTV" de 12 seeders passava do piso
// sozinho e desligava o pack, deixando a lista em francês, holandês e 272p.
test('release estrangeira não conta como candidato saudável', () => {
  const saudavel = (title, seeders) =>
    seeders >= config.search.packMinSeeders && !hasExplicitForeignAudio(title);

  assert.equal(saudavel('Lost Girl S01E01 FRENCH HDTV XviD-Scaph', 12), false);
  assert.equal(saudavel('Lost Girl S01E01 VOSTFR HDTV', 30), false);
  // MULTI e DUAL carregam a faixa original: continuam valendo como saudáveis.
  assert.equal(saudavel('Lost Girl S01E01 MULTI 1080p', 12), true);
  assert.equal(saudavel('Lost Girl S01E01 DUAL 1080p', 12), true);
  // Marca PT tem precedência sobre a lista de idiomas.
  assert.equal(saudavel('Lost Girl S01E01 1080p Dublado FRENCH', 12), true);
  // Sem marca de idioma, quem manda é o piso de seeders.
  assert.equal(saudavel('Lost Girl S01E01 720p HDTV', 12), true);
  assert.equal(saudavel('Lost Girl S01E01 720p HDTV', 1), false);
});

// --- Aviso de deadline: busca que estoura o prazo devolve o quarto texto ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
