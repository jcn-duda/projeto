// Rodada 2: checagem ligada; o caminho search() do jackett é testado com fetch falso.
import { test } from 'node:test';
import assert from 'node:assert';

import config from '../src/config.js';
import jackett from '../src/providers/jackett.js';
import * as cache from '../src/utils/cache.js';
import * as indexerStatus from '../src/providers/indexer-status.js';
import { isSafeDownloadUrl } from '../src/utils/net-safety.js';

// jackett.search(query, type, indexers, { fallbackQuery, matchContext }) é o
// caminho real da busca, testado com fetch falso: config e fetch global são
// trocados e restaurados em finally. Sem rede, sem servidor.

const HASH = 'a'.repeat(40);
const MAGNET = 'magnet:?xt=urn:btih:' + HASH + '&dn=Release';

test('Link de download bloqueia SSRF para destinos locais literais (IPv4, IPv6, ULA, Link-Local, IPv4-Mapped)', () => {
  // --- Protocolos não autorizados ---
  assert.equal(isSafeDownloadUrl('file:///etc/passwd'), false);
  assert.equal(isSafeDownloadUrl('gopher://127.0.0.1/'), false);
  assert.equal(isSafeDownloadUrl('ftp://tracker.org/file'), false);
  assert.equal(isSafeDownloadUrl('javascript:alert(1)'), false);

  // --- Hostname localhost / FQDN ---
  assert.equal(isSafeDownloadUrl('http://localhost:8080/test'), false);
  assert.equal(isSafeDownloadUrl('http://sub.localhost:8080/test'), false);
  assert.equal(isSafeDownloadUrl('http://localhost.:8080/test'), false);
  assert.equal(isSafeDownloadUrl('http://sub.localhost.:8080/test'), false);

  // --- IPv4 Privado, Loopback, Link-Local, CGNAT, Multicast, Broadcast ---
  assert.equal(isSafeDownloadUrl('http://127.0.0.1:9117/api'), false);
  assert.equal(isSafeDownloadUrl('http://127.1.2.3/test'), false);
  assert.equal(isSafeDownloadUrl('http://10.0.0.1:8080/torrents'), false);
  assert.equal(isSafeDownloadUrl('http://172.16.0.1/download'), false);
  assert.equal(isSafeDownloadUrl('http://172.31.255.254/download'), false);
  assert.equal(isSafeDownloadUrl('http://192.168.1.10/file'), false);
  assert.equal(isSafeDownloadUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isSafeDownloadUrl('http://0.0.0.0:7000/api'), false);
  assert.equal(isSafeDownloadUrl('http://100.64.0.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://100.127.255.254/test'), false);
  assert.equal(isSafeDownloadUrl('http://192.0.2.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://198.51.100.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://203.0.113.1/test'), false);
  assert.equal(isSafeDownloadUrl('http://224.0.0.1/multicast'), false);
  assert.equal(isSafeDownloadUrl('http://239.255.255.250/multicast'), false);
  assert.equal(isSafeDownloadUrl('http://240.0.0.1/reserved'), false);
  assert.equal(isSafeDownloadUrl('http://255.255.255.255/broadcast'), false);

  // --- IPv6 Não-especificado ---
  assert.equal(isSafeDownloadUrl('http://[::]/file.torrent'), false);
  assert.equal(isSafeDownloadUrl('http://[0:0:0:0:0:0:0:0]/file'), false);

  // --- IPv6 Loopback ---
  assert.equal(isSafeDownloadUrl('http://[::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[0:0:0:0:0:0:0:1]:8080/api'), false);

  // --- IPv4-Mapped IPv6 (notação decimal e hexadecimal normalizada) ---
  assert.equal(isSafeDownloadUrl('http://[::ffff:127.0.0.1]:9117/api'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:7f00:1]/api'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:169.254.169.254]/meta'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:a9fe:a9fe]/meta'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:10.0.0.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:a00:1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:192.168.1.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:c0a8:101]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:172.16.0.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:ac10:1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:0.0.0.0]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[::ffff:100.64.0.1]/test'), false);

  // --- NAT64 e 6to4 Privados ---
  assert.equal(isSafeDownloadUrl('http://[64:ff9b::127.0.0.1]/test'), false);
  assert.equal(isSafeDownloadUrl('http://[2002:7f00:1::1]/test'), false);

  // --- IPv6 Unique Local Address (ULA fc00::/7) ---
  assert.equal(isSafeDownloadUrl('http://[fc00::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[fd12:3456:789a::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/file'), false);

  // --- IPv6 Link-Local Unicast (fe80::/10) ---
  assert.equal(isSafeDownloadUrl('http://[fe80::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[fe80::200:5efe:127.0.0.1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/file'), false);

  // --- IPv6 Site-Local e Multicast ---
  assert.equal(isSafeDownloadUrl('http://[fec0::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[ff02::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[ffff::1]/file'), false);

  // --- IPv6 Documentação e Discard ---
  assert.equal(isSafeDownloadUrl('http://[2001:db8::1]/file'), false);
  assert.equal(isSafeDownloadUrl('http://[100::1]/file'), false);

  // --- Endpoints públicos legítimos permitidos ---
  assert.equal(isSafeDownloadUrl('https://tracker.example/download'), true);
  assert.equal(isSafeDownloadUrl('https://tracker.example.com/download.torrent'), true);
  assert.equal(isSafeDownloadUrl('http://tracker.example.org:8080/download'), true);
  assert.equal(isSafeDownloadUrl('http://93.184.216.34/file.torrent'), true);
  assert.equal(isSafeDownloadUrl('http://8.8.8.8/dns'), true);
  assert.equal(isSafeDownloadUrl('http://1.1.1.1/dns'), true);
  assert.equal(isSafeDownloadUrl('http://172.32.0.1/download'), true);
  assert.equal(isSafeDownloadUrl('http://192.169.1.1/download'), true);
  assert.equal(isSafeDownloadUrl('http://100.128.0.1/download'), true);
  assert.equal(isSafeDownloadUrl('http://[2606:4700:4700::1111]/dns'), true);
  assert.equal(isSafeDownloadUrl('http://[2001:4860:4860::8888]/dns'), true);
  assert.equal(isSafeDownloadUrl('http://[::ffff:8.8.8.8]/file'), true);
  assert.equal(isSafeDownloadUrl('http://[::ffff:1.1.1.1]/file'), true);
  assert.equal(isSafeDownloadUrl('http://[64:ff9b::8.8.8.8]/file'), true);

  // --- allowPrivate flag ---
  assert.equal(isSafeDownloadUrl('http://127.0.0.1:9117/api', true), true);
  assert.equal(isSafeDownloadUrl('http://[::1]/file', true), true);
  assert.equal(isSafeDownloadUrl('http://192.168.1.1/file', true), true);
  assert.equal(isSafeDownloadUrl('http://[fe80::1]/file', true), true);
  assert.equal(isSafeDownloadUrl('file:///etc/passwd', true), false);
});

function fakeResponse(body: unknown, { status = 200, location = null }: { status?: number; location?: string | null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: any) => (String(name).toLowerCase() === 'location' ? location : null) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

type FakeResponse = ReturnType<typeof fakeResponse>;

interface FetchCall {
  url: string;
  init: any;
  started: number;
  finished?: number;
  promise?: Promise<FakeResponse>;
}

// O dublê é função E acumula estado: chamadas capturadas, o `handler` que cada
// teste instala e os filtros que contam só as buscas Torznab (/results).
interface JackettFetch {
  (url: unknown, init?: any): Promise<FakeResponse>;
  calls: FetchCall[];
  handler?: (call: FetchCall) => FakeResponse | Promise<FakeResponse>;
  searchCalls(): (string | null)[];
  protectorCalls(): string[];
}

function makeFetch(): JackettFetch {
  const calls: FetchCall[] = [];
  const fetchImpl: JackettFetch = (url, init = {}) => {
    const call: FetchCall = { url: String(url), init, started: Date.now() };
    calls.push(call);
    const promise = (async () => {
      try {
        return fetchImpl.handler ? await fetchImpl.handler(call) : fakeResponse({ Results: [] });
      } finally {
        call.finished = Date.now();
      }
    })();
    call.promise = promise;
    return promise;
  };
  fetchImpl.calls = calls;
  // Só as chamadas de busca Torznab (/results) contam como tentativas de query;
  // o resto são saltos de protetor de link.
  fetchImpl.searchCalls = () =>
    calls.filter((c) => c.url.includes('/results')).map((c) => new URL(c.url).searchParams.get('Query'));
  fetchImpl.protectorCalls = () => calls.filter((c) => !c.url.includes('/results')).map((c) => c.url);
  return fetchImpl;
}

async function withJackett(fetchImpl: any, fn: any) {
  const realFetch = globalThis.fetch;
  const saved = { url: config.jackett.url, apiKey: config.jackett.apiKey };
  config.jackett.url = 'http://jackett.test';
  config.jackett.apiKey = 'test-key';
  globalThis.fetch = fetchImpl as unknown as typeof globalThis.fetch;
  cache.clear();
  try {
    return await fn();
  } finally {
    cache.clear();
    globalThis.fetch = realFetch;
    config.jackett.url = saved.url;
    config.jackett.apiKey = saved.apiKey;
  }
}

const SERIES_CTX = {
  names: ['Joker', 'Coringa'],
  year: 2019,
  isSeries: true,
  season: 1,
  episode: 1,
};

// Contexto do caso de recall BR (tt0084726): pt-BR romano é o que o addon
// busca de verdade; a release BR "numerada" usa o algarismo arábico.
const TREK_CTX = {
  names: ['Jornada nas Estrelas II: A Ira de Khan', 'Star Trek II: The Wrath of Khan'],
  year: 1982,
  isSeries: false,
  season: null,
  episode: null,
};
const TREK_PT = 'Jornada nas Estrelas II: A Ira de Khan 1982';
const TREK_VARIANT = 'Jornada nas Estrelas 2: A Ira de Khan 1982';

test('primary PT 200 com zero relevante dispara fallback original e entrega a fonte certa', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === 'Coringa') {
        // 200 válido, mas tudo lixo: o filtro estrito descarta e o fallback corre.
        return fakeResponse({ Results: [
          { Title: 'Missão: Impossível – Efeito Coringa 1080p', Seeders: 1, Link: 'http://protector.test/lixo' },
        ] });
      }
      return fakeResponse({ Results: [
        { Title: 'Joker 2019 1080p WEB-DL', Seeders: 10, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Coringa S01E01', 'series', ['bludv-cardigann'], {
      fallbackQuery: 'Joker S01E01',
      matchContext: SERIES_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), ['Coringa', 'Joker']);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Joker 2019 1080p WEB-DL');
    // O lixo da primária nem chegou a pagar protetor de link.
    assert.equal(fetchImpl.protectorCalls().includes('http://protector.test/lixo'), false);
  });
});

test('HTTP erro na primary NÃO dispara o fallback', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse(null, { status: 500 });
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Coringa S01E01', 'series', ['bludv-cardigann'], {
      fallbackQuery: 'Joker S01E01',
      matchContext: SERIES_CTX,
    });
    // Erro de servidor sobe como falha do indexer; nada de segunda tentativa.
    assert.deepEqual(fetchImpl.searchCalls(), ['Coringa']);
    assert.deepEqual(items, []);
  });
});

test('fallback é sequencial e cabe no orçamento restante, sem duas tentativas no ar', async () => {
  const fetchImpl = makeFetch();
  const seen: Array<string | null> = [];
  let releasePrimary: any;
  const primaryGate = new Promise((resolve) => { releasePrimary = resolve; });
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return originalTimeout(ms); };

  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      seen.push(query);
      if (query === 'Coringa') return primaryGate.then(() => fakeResponse({ Results: [] }));
      return fakeResponse({ Results: [{ Title: 'Joker 2019 1080p', Seeders: 5, MagnetUri: MAGNET }] });
    }
    return fakeResponse(null, { status: 404 });
  };

  try {
    await withJackett(fetchImpl, async () => {
      const search = jackett.search('Coringa S01E01', 'series', ['bludv-cardigann'], {
        fallbackQuery: 'Joker S01E01',
        matchContext: SERIES_CTX,
      });
      // Primary ainda em voo: o fallback não pode ter começado (nada de Promise
      // paralela dentro do deadline).
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(seen, ['Coringa']);
      releasePrimary();
      const items = await search;
      assert.deepEqual(seen, ['Coringa', 'Joker']);
      assert.equal(items.length, 1);
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  // O fallback é a ÚNICA segunda chamada de busca, e recebe menos tempo que a
  // primary: o deadline é absoluto e o que sobrou é o que ele usa.
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[1] < timeouts[0], 'fallback usa só o orçamento restante');
});

test('pré-filtro com matchContext rejeita a spin-off antes de pagar o protetor', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Rick And Morty The Anime S01E02 1080p', Seeders: 1, Link: 'http://protector.test/anime' },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Rick and Morty S01E02', 'series', ['bludv-cardigann'], {
      matchContext: {
        names: ['Rick and Morty', 'Rick e Morty'],
        year: 2024,
        isSeries: true,
        season: 1,
        episode: 2,
      },
    });
    assert.equal(fetchImpl.protectorCalls().includes('http://protector.test/anime'), false);
    assert.deepEqual(items, []);
  });
});

test('candidatos duplicados com o mesmo downloadUrl geram um único fetch do protetor', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Fallout 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', Seeders: 1, Link: 'http://protector.test/mesma' },
        { Title: 'Fallout 1ª Temporada (2024) WEB-DL [1080p DUBLADO] [opção 2]', Seeders: 1, Link: 'http://protector.test/mesma' },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Fallout S01E01', 'series', ['bludv-cardigann'], {
      matchContext: { names: ['Fallout'], year: 2024, isSeries: true, season: 1, episode: 1 },
    });
    const hits = fetchImpl.protectorCalls().filter((u) => u === 'http://protector.test/mesma');
    assert.equal(hits.length, 1);
    assert.equal(items.length, 1);
  });
});

test('magnet resolvido pelo protetor é reutilizado do cache em buscas subsequentes', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador (1987) 1080p DUBLADO', Seeders: 1, Link: 'http://protector.test/predador1987' },
      ] });
    }
    return fakeResponse(null, { location: MAGNET });
  };

  await withJackett(fetchImpl, async () => {
    const items1 = await jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
      matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
    });
    assert.equal(items1.length, 1);
    assert.equal(items1[0].magnet, MAGNET);
    assert.equal(fetchImpl.protectorCalls().filter((u) => u === 'http://protector.test/predador1987').length, 1);

    // Segunda busca: o protetor não deve ser chamado de novo
    const items2 = await jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
      matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
    });
    assert.equal(items2.length, 1);
    assert.equal(items2[0].magnet, MAGNET);
    assert.equal(fetchImpl.protectorCalls().filter((u) => u === 'http://protector.test/predador1987').length, 1);
  });
});

// --- Cache do resultado bruto (Fase 1 do PLANO_CACHE) ---
// A memoização cobre SÓ a camada de rede (fetchQuery): cascata de fallback e
// resolução de magnets continuam rodando por busca. Com fetch falso dá pra
// contar exatamente quantas consultas Torznab saíram.

test('raw cache: segunda busca da mesma query reusa o bruto sem novo fetch', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador (1987) 1080p DUBLADO', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const run = () => jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
      matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
    });
    const first = await run();
    assert.equal(first.length, 1);
    const second = await run();
    assert.equal(second.length, 1);
    // A raspagem Torznab aconteceu UMA vez; a segunda busca vive do raw.
    assert.deepEqual(fetchImpl.searchCalls(), ['Predador 1987']);
  });
});

test('raw cache: E01 e E02 da mesma temporada compartilham a entrada em indexer BR', async () => {
  // shapeSearchQuery remove SxxEyy nos indexers BR: a chave é por temporada,
  // e é isso que faz a busca tardia de pack ("Nome S01") pagar uma varredura
  // só por temporada em vez de uma por episódio.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Fallout 1ª Temporada (2024) WEB-DL [1080p DUBLADO]', Seeders: 1, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const ctx = { names: ['Fallout'], year: 2024, isSeries: true, season: 1 };
    const e1 = await jackett.search('Fallout S01E01', 'series', ['bludv-cardigann'], {
      matchContext: { ...ctx, episode: 1 },
    });
    const e2 = await jackett.search('Fallout S01E02', 'series', ['bludv-cardigann'], {
      matchContext: { ...ctx, episode: 2 },
    });
    assert.equal(e1.length, 1);
    assert.equal(e2.length, 1);
    // As duas queries moldam para "Fallout": UMA consulta Torznab só.
    assert.deepEqual(fetchImpl.searchCalls(), ['Fallout']);
  });
});

test('raw cache: resultado acima do teto de itens não é cacheado', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Predador A 1080p DUBLADO', Seeders: 3, MagnetUri: MAGNET },
        { Title: 'Predador B 720p DUBLADO', Seeders: 2, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  const saved = config.rawCache.maxItems;
  // Teto forçado pra baixo: 2 itens estouram sem precisar de 121 resultados.
  config.rawCache.maxItems = 1;
  try {
    await withJackett(fetchImpl, async () => {
      const run = () => jackett.search('Predador 1987', 'movie', ['comandotorrents'], {
        matchContext: { names: ['Predador', 'Predator'], year: 1987, isSeries: false, season: null, episode: null },
      });
      await run();
      await run();
      // Acima do teto o bruto não entra no cache: cada busca paga o fetch.
      assert.equal(fetchImpl.searchCalls().length, 2);
    });
  } finally {
    config.rawCache.maxItems = saved;
  }
});

test('raw cache: vazio é cacheado e a segunda busca não abre fetch', async () => {
  // 200 com zero itens entra com o TTL curto (RAW_CACHE_EMPTY_TTL), não o
  // cheio; aqui o comportamento: o vazio não paga raspagem repetida.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const run = () => jackett.search('Titulo Inexistente 1901', 'movie', ['thepiratebay']);
    assert.deepEqual(await run(), []);
    assert.deepEqual(await run(), []);
    assert.equal(fetchImpl.searchCalls().length, 1, 'o vazio da primeira busca é servido do cache');
  });
});

test('raw cache: hit não registra indexer-status (a medição não aconteceu)', async () => {
  // Regressão da correção 4 do PLANO_CACHE: hit gravando ok:true com ms~0
  // deixaria um indexer caído verde no card pelo TTL inteiro.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  try {
    await withJackett(fetchImpl, async () => {
      const run = () => jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay']);
      await run();
      const before = indexerStatus.get('thepiratebay');
      assert.ok(before, 'a busca ao vivo registra o status');
      // Relógio distinto: checkedAt tem precisão de milissegundo.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await run(); // hit do raw: nenhuma consulta Torznab saiu
      const after = indexerStatus.get('thepiratebay');
      assert.equal(after.checkedAt, before.checkedAt, 'o hit não pode inventar medição');
    });
  } finally {
    indexerStatus.clear();
  }
});

test('tt0084726: variante numérica recupera release BR publicada com algarismo arábico', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      // Query primária em romano: WP devolve 0 (posts de outro filme não casam
      // "Ii" com "2"); só a variante arábica traz a release dublada.
      if (query === TREK_PT) return fakeResponse({ Results: [] });
      if (query === TREK_VARIANT) {
        return fakeResponse({ Results: [
          { Title: 'Jornada nas Estrelas 2 A Ira de Khan 1982 DUBLADO 720p', Seeders: 2, MagnetUri: MAGNET },
        ] });
      }
      return fakeResponse({ Results: [] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      matchContext: TREK_CTX,
    });
    assert.ok(['Jornada nas Estrelas II: A Ira de Khan 1982', TREK_VARIANT].every(
      (q) => fetchImpl.searchCalls().includes(q),
    ), `cadeia deveria seguir primary -> variante, viu ${fetchImpl.searchCalls()}`);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Jornada nas Estrelas 2 A Ira de Khan 1982 DUBLADO 720p');
  });
});

test('primary relevante NÃO abre variante numérica nem fallback original', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada nas Estrelas II A Ira de Khan 1982 Dublado 1080p', Seeders: 5, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT]);
    assert.equal(items.length, 1);
  });
});

test('variante numérica vazia segue para o fallback original', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === TREK_PT) return fakeResponse({ Results: [] });
      if (query === TREK_VARIANT) return fakeResponse({ Results: [] });
      return fakeResponse({ Results: [
        { Title: 'Star Trek II: The Wrath of Khan 1982 DUBLADO 1080p', Seeders: 4, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT, TREK_VARIANT, 'Star Trek II: The Wrath of Khan 1982']);
    assert.equal(items.length, 1);
  });
});

test('prazo esgotado impede a variante numérica (sem chamada extra)', async () => {
  const fetchImpl = makeFetch();
  const savedTimeout = config.jackett.brIndexerTimeout;
  config.jackett.brIndexerTimeout = 1; // orçamento exaurido ainda na primária
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };
  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
        variantQuery: TREK_VARIANT,
        fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
        matchContext: TREK_CTX,
      });
      // Sem orçamento sobrando, a cadeia para na primária: nem variante, nem fallback.
      assert.deepEqual(items, []);
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT]);
  } finally {
    config.jackett.brIndexerTimeout = savedTimeout;
  }
});

test('dedupe pós-shape: variante que moldagem reduz ao primário não abre chamada', async () => {
  // Com um bare-title, "batTitleIndexers" não está em jogo aqui; simulamos duas
  // queries que moldam para o MESMO texto: a plain primary e uma variante igual.
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) return fakeResponse({ Results: [] });
    return fakeResponse(null, { status: 404 });
  };
  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      // Variante é literalmente igual à query já enviada: shapedSeen dedup.
      variantQuery: TREK_PT,
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT]);
    assert.deepEqual(items, []);
  });
});

test('falha HTTP na variante opcional não derruba a primária nem impede fallback original', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      const query = new URL(call.url).searchParams.get('Query');
      if (query === TREK_PT) return fakeResponse({ Results: [] });
      if (query === TREK_VARIANT) return fakeResponse(null, { status: 503 });
      return fakeResponse({ Results: [
        { Title: 'Star Trek II: The Wrath of Khan 1982 DUBLADO 1080p', Seeders: 4, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search(TREK_PT, 'movie', ['bludv-cardigann'], {
      variantQuery: TREK_VARIANT,
      fallbackQuery: 'Star Trek II: The Wrath of Khan 1982',
      matchContext: TREK_CTX,
    });
    assert.deepEqual(fetchImpl.searchCalls(), [TREK_PT, TREK_VARIANT, 'Star Trek II: The Wrath of Khan 1982']);
    assert.equal(items.length, 1);
  });
});

// A varredura pt-BR é a única coisa que consulta um indexer com circuit
// breaker aberto: roda fora do orçamento da resposta, e o dublado raro mora
// justamente no indexer recém-derrubado. O breaker é um atalho de busca AO
// VIVO — a varredura o ignora de propósito. `recordStatus:false` continua
// valendo: a falha dela não pode poluir o card de status.

test('search normal pula indexer com breaker aberto', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  // 3 falhas seguidas abrem o circuito (default breakerFailures=3).
  for (let i = 0; i < config.jackett.breakerFailures; i += 1) {
    indexerStatus.record('thepiratebay', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
  }
  try {
    await withJackett(fetchImpl, async () => {
      await jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay']);
      // Pula o indexer com breaker aberto: zero chamadas de busca.
      assert.deepEqual(fetchImpl.searchCalls(), []);
    });
  } finally {
    indexerStatus.clear();
  }
});

test('search com ignoreBreaker:true consulta indexer com breaker aberto', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  for (let i = 0; i < config.jackett.breakerFailures; i += 1) {
    indexerStatus.record('thepiratebay', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
  }
  try {
    await withJackett(fetchImpl, async () => {
      const items = await jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay'], {
        ignoreBreaker: true,
        recordStatus: false,
      });
      // Mesmo com breaker aberto, a varredura consulta — foi o que o caso
      // Star Trek I mostrou: kickasstorrents-to (único que respondia à
      // query longa) tinha acabado de ser tirado do ar pela busca anterior.
      assert.deepEqual(fetchImpl.searchCalls(), ['Jornada nas Estrelas 1979']);
      assert.equal(items.length, 1);
    });
  } finally {
    indexerStatus.clear();
  }
});

test('search com ignoreBreaker:true e recordStatus:false não atualiza o card', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = (call) => {
    if (call.url.includes('/results')) {
      return fakeResponse({ Results: [
        { Title: 'Jornada Nas Estrelas 1979 Dublado 1080p', Seeders: 3, MagnetUri: MAGNET },
      ] });
    }
    return fakeResponse(null, { status: 404 });
  };
  // Estado inicial conhecido: 1 falha (não abre o circuito).
  indexerStatus.record('thepiratebay', { ok: false, results: 0, ms: 100, budgetMs: 4000 });
  const before = indexerStatus.get('thepiratebay');
  try {
    await withJackett(fetchImpl, async () => {
      await jackett.search('Jornada nas Estrelas 1979', 'movie', ['thepiratebay'], {
        ignoreBreaker: true,
        recordStatus: false,
      });
      const after = indexerStatus.get('thepiratebay');
      // recordStatus:false impede que o sucesso da varredura limpe o
      // failStreak: o card de status continua refletindo a busca ao vivo.
      assert.equal(after.failStreak, before.failStreak);
    });
  } finally {
    indexerStatus.clear();
  }
});

// --- Categoria na URL: o TPB some com ela, os outros não ---
//
// "Star Trek Beyond" com Category[]=2000 devolve 0 no thepiratebay e 100 sem
// categoria; a mesma query COM ano devolve 19 dos dois jeitos. Quem paga é a
// varredura pt-BR e o bare title, que saem sem ano. A consulta do TPB passa a
// sair sem categoria e o filtro de tipo roda sobre o `Category` da resposta.

const BEYOND_CTX = {
  names: ['Beyond Re-Animator'],
  year: 2003,
  isSeries: false,
  season: null,
  episode: null,
};

function categoryParams(fetchImpl: JackettFetch) {
  return fetchImpl.calls
    .filter((c) => c.url.includes('/results'))
    .map((c) => new URL(c.url).searchParams.getAll('Category[]'));
}

test('thepiratebay consulta SEM Category[] e filtra o tipo na resposta', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({ Results: [
    { Title: 'Beyond Re-Animator 2003 1080p BluRay', Seeders: 9, MagnetUri: MAGNET, Category: [2040, 100207] },
    { Title: 'Beyond Re-Animator 2003 720p WEB', Seeders: 5, MagnetUri: MAGNET, Category: [2000, 100201] },
    // TV/Other no meio da resposta: é o que o Category[] filtrava no servidor.
    { Title: 'Beyond Re-Animator 2003 TV Rip', Seeders: 3, MagnetUri: MAGNET, Category: [5050, 100206] },
    // Sem categoria nenhuma passa: metadado ausente não pode custar release.
    { Title: 'Beyond Re-Animator 2003 DVDRip', Seeders: 1, MagnetUri: MAGNET },
  ] });

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Beyond Re-Animator', 'movie', ['thepiratebay'], {
      matchContext: BEYOND_CTX,
    });
    assert.deepEqual(categoryParams(fetchImpl), [[]]);
    assert.deepEqual(items.map((i: any) => i.title).sort(), [
      'Beyond Re-Animator 2003 1080p BluRay',
      'Beyond Re-Animator 2003 720p WEB',
      'Beyond Re-Animator 2003 DVDRip',
    ]);
  });
});

test('indexer normal continua mandando Category[] na URL', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({ Results: [
    // Categoria de TV chegando de um indexer que já filtrou no servidor: sem
    // isenção não há filtro local, e o item continua entrando como antes.
    { Title: 'Beyond Re-Animator 2003 1080p BluRay', Seeders: 9, MagnetUri: MAGNET, Category: [5050] },
  ] });

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Beyond Re-Animator', 'movie', ['therarbg'], {
      matchContext: BEYOND_CTX,
    });
    assert.deepEqual(categoryParams(fetchImpl), [['2000']]);
    assert.equal(items.length, 1);
  });
});

test('série no thepiratebay filtra pelo balde 5000', async () => {
  const fetchImpl = makeFetch();
  fetchImpl.handler = () => fakeResponse({ Results: [
    { Title: 'Joker S01E01 1080p WEB-DL', Seeders: 9, MagnetUri: MAGNET, Category: [5040] },
    { Title: 'Joker 2019 1080p BluRay', Seeders: 9, MagnetUri: MAGNET, Category: [2040] },
  ] });

  await withJackett(fetchImpl, async () => {
    const items = await jackett.search('Joker S01E01', 'series', ['thepiratebay'], {
      matchContext: SERIES_CTX,
    });
    assert.deepEqual(categoryParams(fetchImpl), [[]]);
    assert.deepEqual(items.map((i: any) => i.title), ['Joker S01E01 1080p WEB-DL']);
  });
});
