import { test } from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import * as cache from "../src/utils/cache.js";
import * as metrics from "../src/utils/metrics.js";
import * as rdOracle from "../src/debrid/rd-oracle.js";
import * as rdLedger from "../src/debrid/rd-ledger.js";
import * as realdebrid from "../src/debrid/realdebrid.js";

// Oráculo multi-fonte do CDN Real-Debrid. O CDN pertence ao SERVIZO, non á
// conta; o veredicto é global (ledger), nunca por chave. Estes testes cobren:
// lotes do StremThru respetando maxHashes, parser do Torrentio ( [RD+] / url
// resolve ), hash NÓN listado como desconocido (nunca miss), true de una fonte
// vencendo false da outra, falha de fonte illada, TTL do cache por título,
// kill-switch e escrita ao ledger.
//
// A escrita ao ledger vive no pipeline (debrid-pipeline.ts), non no oráculo;
// o unitario replica ese contrato e a integración (último caso) o exercita ata
// o checkCached do adaptador.

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const H3 = "c".repeat(40);
const H4 = "d".repeat(40);
const H5 = "e".repeat(40);

// Snapshot do estático para restaurar nos afterEach: os testes asollapan no
// config do operador e non poden saír mutados para os demais arquivos.
const ORACLE_SNAPSHOT = { ...config.debrid.rdOracle };
const LEDGER_SNAPSHOT = { ...config.debrid.rdLedger };

// Cache L2 apagado por setup-env.ts (CACHE_PERSIST=false cargado con `--import`),
// así a suíte non abre SQLite de verdad.
test.beforeEach(() => {
  cache.clearNamespace("rdc");
  metrics.reset();
  config.debrid.rdOracle.enabled = true;
  config.debrid.rdOracle.timeoutMs = 800;
  config.debrid.rdOracle.maxHashes = 2;
  config.debrid.rdOracle.stremthruUrl = "";
  config.debrid.rdOracle.stremthruToken = "";
  config.debrid.rdOracle.stremthruStore = "realdebrid";
  config.debrid.rdOracle.torrentio = false;
  config.debrid.rdOracle.torrentioUrl = "https://torrentio.strem.fun";
  config.debrid.rdOracle.torrentioKey = "";
  config.debrid.rdOracle.torrentioTtl = 21600;
  config.debrid.rdLedger.enabled = true;
});
test.afterEach(() => {
  config.debrid.rdOracle.enabled = ORACLE_SNAPSHOT.enabled;
  config.debrid.rdOracle.timeoutMs = ORACLE_SNAPSHOT.timeoutMs;
  config.debrid.rdOracle.maxHashes = ORACLE_SNAPSHOT.maxHashes;
  config.debrid.rdOracle.stremthruUrl = ORACLE_SNAPSHOT.stremthruUrl;
  config.debrid.rdOracle.stremthruToken = ORACLE_SNAPSHOT.stremthruToken;
  config.debrid.rdOracle.stremthruStore = ORACLE_SNAPSHOT.stremthruStore;
  config.debrid.rdOracle.torrentio = ORACLE_SNAPSHOT.torrentio;
  config.debrid.rdOracle.torrentioUrl = ORACLE_SNAPSHOT.torrentioUrl;
  config.debrid.rdOracle.torrentioKey = ORACLE_SNAPSHOT.torrentioKey;
  config.debrid.rdOracle.torrentioTtl = ORACLE_SNAPSHOT.torrentioTtl;
  config.debrid.rdLedger.enabled = LEDGER_SNAPSHOT.enabled;
  config.debrid.rdLedger.hitTtl = LEDGER_SNAPSHOT.hitTtl;
  config.debrid.rdLedger.blockedTtl = LEDGER_SNAPSHOT.blockedTtl;
  config.debrid.rdLedger.missBackoffMs = LEDGER_SNAPSHOT.missBackoffMs;
});

// O dublé de fetch precisa de json() E text(): checkStremThru lée json(), e
// algúns callers podense esperar text(). Molde do debrid-rd-probe.test.
function jsonOk(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

function mockFetch(handler: (url: URL, init?: RequestInit) => any) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => new AbortController().signal;
  const urls: URL[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
  return {
    urls,
    restore() {
      globalThis.fetch = realFetch;
      AbortSignal.timeout = realTimeout;
    },
  };
}

function stremthruItems(query: string) {
  return query.split(",").map((h) => ({ hash: h, status: "uncached" }));
}

test("1. lote do StremThru respeta maxHashes: 5 hashes a 2 → 3 chamadas", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.maxHashes = 2;
  const hashes = [H1, H2, H3, H4, H5];
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") {
      return jsonOk({ data: { items: stremthruItems(url.searchParams.get("hash") || "") } });
    }
    return jsonOk({}, 404);
  });
  try {
    const result = await rdOracle.check({ hashes, type: "movie", id: "tt1", timeoutMs: 800 });
    const calls = mock.urls.filter((u) => u.pathname === "/v0/store/torz/check");
    assert.equal(calls.length, 3, "2+2+1 lotes");
    assert.deepEqual(calls.map((u) => (u.searchParams.get("hash") || "").split(",")), [
      [H1, H2],
      [H3, H4],
      [H5],
    ]);
    // StremThru enumera os pedidos: item presente 'uncached' é miss autoritativo.
    assert.equal(result.size, 5);
  } finally {
    mock.restore();
  }
});

test("2. parser Torrent re recognised [RD+] e extrai hash de infoHash", async () => {
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch(() => jsonOk({ streams: [{ name: "[RD+] Filme 2026 nrgb 4", infoHash: H1 }] }));
  try {
    const result = await rdOracle.check({ hashes: [H1], type: "movie", id: "tt2", timeoutMs: 800 }, "chave");
    assert.equal(result.get(H1), true, "[RD+] ao inicio = cacheado");
  } finally {
    mock.restore();
  }
});

test("3. parser extrai hash de url de resolve (40-hex no path)", async () => {
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch(() => jsonOk({ streams: [{ name: "Fonte Sin RD", url: `https://rd.example/d/${H2}` }] }));
  try {
    const result = await rdOracle.check({ hashes: [H2], type: "movie", id: "tt3", timeoutMs: 800 }, "chave");
    assert.equal(result.get(H2), false, "listado sen [RD+] = miss autoritativo");
  } finally {
    mock.restore();
  }
});

test("4. hash NÃO listado polo Torrent fica desconocido (ausente do Map)", async () => {
  config.debrid.rdOracle.torrentio = true;
  const hash = H3;
  const another = H4;
  const mock = mockFetch(() => jsonOk({ streams: [{ name: "[RD+] Algo", infoHash: another }] }));
  try {
    const result = await rdOracle.check({ hashes: [hash], type: "movie", id: "tt3", timeoutMs: 800 }, "chave");
    assert.equal(result.has(hash), false, "pedido pero no listado → unknown, nunca miss");
  } finally {
    mock.restore();
  }
});

test("5. true de una fonte vence false da outra (StremThru cached vs Torrent sin marcar)", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") {
      return jsonOk({ data: { items: [{ hash: H1, status: "cached" }] } });
    }
    return jsonOk({ streams: [{ name: "Sin RD", infoHash: H1 }] });
  });
  try {
    const result = await rdOracle.check({ hashes: [H1], type: "movie", id: "tt4", timeoutMs: 800 }, "chave");
    assert.equal(result.get(H1), true, "evidencia positiva vence");
  } finally {
    mock.restore();
  }
});

test("6. falha de una fonte non tumba a outra (allSettled)", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") {
      return jsonOk({ data: { items: [{ hash: H1, status: "cached" }] } });
    }
    throw new Error("torrent cae: timeout/rede");
  });
  try {
    const result = await rdOracle.check({ hashes: [H1], type: "movie", id: "tt5", timeoutMs: 800 }, "chave");
    assert.equal(result.get(H1), true, "StremThru segue de pé co TorrentSt caído");
  } finally {
    mock.restore();
  }
});

test("7. resultado do oráculo grava ledger: hit e miss autoritativo", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") {
      return jsonOk({
        data: { items: [{ hash: H1, status: "cached" }, { hash: H2, status: "not_cached" }] },
      });
    }
    return jsonOk({}, 404);
  });
  try {
    const verdicts = await rdOracle.check({ hashes: [H1, H2], type: "movie", id: "tt6", timeoutMs: 800 }, "chave");
    assert.equal(verdicts.get(H1), true);
    assert.equal(verdicts.get(H2), false);
    // Este bucle é o que fai o pipeline (debrid-pipeline.ts) tras check().
    const hitsArr: string[] = [];
    for (const [hash, cached] of verdicts) {
      if (cached) hitsArr.push(String(hash));
      else rdLedger.noteMiss(hash);
    }
    if (hitsArr.length) rdLedger.noteHit(hitsArr);
    assert.equal(rdLedger.peek(H1), "hit");
    assert.equal(rdLedger.peek(H2), "miss");
  } finally {
    mock.restore();
  }
});

test("8. Segunda busca do mesmo título non repite Torrent (TTL no cache)", async () => {
  config.debrid.rdOracle.torrentio = true;
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return jsonOk({ streams: [{ name: "[RD+] Filme", infoHash: H1 }] });
  });
  try {
    const q = { hashes: [H1], type: "movie" as const, id: "tt7", timeoutMs: 800 };
    await rdOracle.check(q, "chave");
    await rdOracle.check(q, "chave");
    assert.equal(calls, 1, "2ª busca da mesma obra non repite TorrentSt");
  } finally {
    mock.restore();
  }
});

test("9. kill-switch DEBRID_RD_ORACLE=false: zero fetch, available() false", async () => {
  config.debrid.rdOracle.enabled = false;
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.torrentio = true;
  let fetches = 0;
  const mock = mockFetch(() => {
    fetches += 1;
    return jsonOk({});
  });
  try {
    assert.equal(rdOracle.available(), false);
    const result = await rdOracle.check({ hashes: [H1], type: "movie", id: "tt11", timeoutMs: 800 }, "chave");
    assert.equal(result.size, 0);
    assert.equal(fetches, 0, "nin unha chamada co oráculo apagado");
  } finally {
    mock.restore();
  }
});

test("10. integración mínima: oracle+ledger → checkCached do RD known=true e cached", async () => {
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch(() => jsonOk({ streams: [{ name: "[RD+] Filme", infoHash: H1 }] }));
  try {
    const verdicts = await rdOracle.check({ hashes: [H1], type: "movie" as const, id: "tt12", timeoutMs: 800 }, "chave");
    assert.equal(verdicts.get(H1), true);
    rdLedger.noteHit([H1]);
    const res = await realdebrid.checkCached("chave", [H1]);
    assert.equal(res.complete, true, "known=true: hash con evidencia");
    assert.ok(res.cached.has(H1), "hash cacheado está presente");
  } finally {
    mock.restore();
  }
});

test("11. dedupe contra ledger: hashes con estado fresco non van á rede", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  rdLedger.noteHit([H1]);
  rdLedger.noteMiss(H2);
  let networkHashes: string[] = [];
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") {
      networkHashes = (url.searchParams.get("hash") || "").split(",");
      return jsonOk({ data: { items: [{ hash: H3, status: "cached" }] } });
    }
    return jsonOk({}, 404);
  });
  try {
    const result = await rdOracle.check({ hashes: [H1, H2, H3], type: "movie", id: "tt13", timeoutMs: 800 });
    assert.deepEqual(networkHashes, [H3], "só o unknown H3 foi consultado na rede");
    assert.equal(result.get(H1), true, "H1 veio do ledger como hit");
    assert.equal(result.get(H2), false, "H2 veio do ledger como miss");
    assert.equal(result.get(H3), true, "H3 veio da rede como cached");
  } finally {
    mock.restore();
  }
});

test("12. headers StremThru levan só X-StremThru-Store-Authorization", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.stremthruToken = "meu-token";
  let capturedHeaders: any = null;
  const mock = mockFetch((url, init) => {
    capturedHeaders = init?.headers;
    return jsonOk({ data: { items: [{ hash: H1, status: "cached" }] } });
  });
  try {
    await rdOracle.check({ hashes: [H1], type: "movie", id: "tt14", timeoutMs: 800 });
    assert.ok(capturedHeaders);
    assert.equal(capturedHeaders["X-StremThru-Store-Authorization"], "Bearer meu-token");
    assert.equal(capturedHeaders["Authorization"], undefined, "Authorization cru non debe enviarse");
  } finally {
    mock.restore();
  }
});

test("13. cache por título do Torrentio serializa como Array para L2", async () => {
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch(() => jsonOk({ streams: [{ name: "[RD+] Filme", infoHash: H1 }, { name: "Filme", infoHash: H2 }] }));
  try {
    await rdOracle.check({ hashes: [H1, H2], type: "movie", id: "tt15", timeoutMs: 800 }, "chave");
    const rawInCache = cache.get("rdc:v1:trt:movie:tt15");
    assert.ok(Array.isArray(rawInCache), "debe gardarse como Array no cache para serializar a L2");
    // Segunda chamada recupera do cache convertido a Map
    const result2 = await rdOracle.check({ hashes: [H1, H2], type: "movie", id: "tt15", timeoutMs: 800 }, "chave");
    assert.equal(result2.get(H1), true);
    assert.equal(result2.get(H2), false);
  } finally {
    mock.restore();
  }
});