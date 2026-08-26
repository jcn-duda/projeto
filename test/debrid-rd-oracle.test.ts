import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import config from "../src/config.js";
import * as cache from "../src/utils/cache.js";
import * as metrics from "../src/utils/metrics.js";
import * as rdOracle from "../src/debrid/rd-oracle.js";
import * as rdLedger from "../src/debrid/rd-ledger.js";
import * as realdebrid from "../src/debrid/realdebrid.js";

// Fixtures reais capturados em 2026-08-26 (evidência do contrato ao vivo).
const TORRENTIO_FIX = JSON.parse(
  readFileSync(new URL("./fixtures/rd-oracle-torrentio-2026-08-26.json", import.meta.url), "utf8"),
);
const STREMTHRU_FIX = JSON.parse(
  readFileSync(new URL("./fixtures/rd-oracle-stremthru-2026-08-26.json", import.meta.url), "utf8"),
);
// Hash cacheado no fixture do Torrentio (stream `[RD+]`, depois do token no path).
const FIX_H1 = TORRENTIO_FIX.streams[0].url.match(/[a-f0-9]{40}/gi)[1].toLowerCase();
// Hash do stream `[RD download]` — NÃO está no conjunto pedido nesses testes.
const FIX_OTHER = TORRENTIO_FIX.streams[1].url.match(/[a-f0-9]{40}/gi)[1].toLowerCase();

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
  cache.clearNamespace("rdt");
  cache.clearNamespace("rdq");
  metrics.reset();
  config.debrid.rdOracle.enabled = true;
  config.debrid.rdOracle.timeoutMs = 800;
  config.debrid.rdOracle.maxHashes = 2;
  config.debrid.rdOracle.stremthruUrl = "";
  config.debrid.rdOracle.stremthruToken = "teste-token";
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

test("7. fixture real Torrentio: segmento em TEXTO (realdebrid=<key>), hash após o token, [RD+] hit e [RD download] fora do conjunto = unknown", async () => {
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch((url) => {
    // O segmento de config viaja cru, nunca base64url.
    assert.match(
      url.pathname,
      /^\/realdebrid=chave\/stream\//,
      `segmento em texto puro: ${url.pathname}`,
    );
    assert.ok(!url.pathname.includes("cmVhbGRlYnJpZD0"), "não pode ser base64url");
    return jsonOk(TORRENTIO_FIX);
  });
  try {
    const result = await rdOracle.check({ hashes: [FIX_H1], type: "movie", id: "tt20", timeoutMs: 800 }, "chave");
    assert.equal(result.get(FIX_H1), true, "escolheu o hash pedido (não o token) e [RD+] = cacheado");
    // O stream `[RD download]` tem hash FORA do conjunto pedido -> nunca é ecoado.
    assert.equal(result.has(FIX_OTHER), false, "hash de outro conjunto não é miss nem hit");
  } finally {
    mock.restore();
  }
});

test("7b. fixture real StremThru: item 'cached' => true; item presente sem cached => false (miss autoritativo)", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  const cachedHash = STREMTHRU_FIX.data.items[0].hash.toLowerCase();
  const unknownHash = STREMTHRU_FIX.data.items[1].hash.toLowerCase();
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") return jsonOk(STREMTHRU_FIX);
    return jsonOk({}, 404);
  });
  try {
    const result = await rdOracle.check({ hashes: [cachedHash, unknownHash], type: "movie", id: "tt21", timeoutMs: 800 }, "chave");
    assert.equal(result.get(cachedHash), true, "status cached = hit");
    assert.equal(result.get(unknownHash), false, "item presente sem cached = miss autoritativo");
  } finally {
    mock.restore();
  }
});

test("7c. StremThru: token vazio usa a apiKey efetiva da instalação (Bearer)", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.stremthruToken = "";
  let auth: any = null;
  const mock = mockFetch((url, init) => {
    auth = (init?.headers as any)?.["X-StremThru-Store-Authorization"];
    return jsonOk({ data: { items: [{ hash: H1, status: "cached" }] } });
  });
  try {
    await rdOracle.check({ hashes: [H1], type: "movie", id: "tt24", timeoutMs: 800 }, "chave-inst");
    assert.equal(auth, "Bearer chave-inst", "vazio usa a apiKey da instalação");
  } finally {
    mock.restore();
  }
});

test("7d. Torrentio: [RD+] exato é hit; [RD] e [RD download] são miss autoritativo", async () => {
  config.debrid.rdOracle.torrentio = true;
  const mock = mockFetch(() =>
    jsonOk({
      streams: [
        { name: "[RD+] A", infoHash: H1 },
        { name: "[RD] B", infoHash: H2 },
        { name: "[RD download] C", infoHash: H3 },
      ],
    }),
  );
  try {
    const result = await rdOracle.check({ hashes: [H1, H2, H3], type: "movie", id: "tt25", timeoutMs: 800 }, "chave");
    assert.equal(result.get(H1), true, "[RD+] = hit");
    assert.equal(result.get(H2), false, "[RD] sem + = miss, nunca hit");
    assert.equal(result.get(H3), false, "[RD download] = miss, nunca hit");
  } finally {
    mock.restore();
  }
});

test("7e. deadline ÚNICO: 5 lotes não somam o timeout por lote", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.maxHashes = 1;
  let calls = 0;
  const delayer = 40;
  const mock = mockFetch(async (url) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, delayer));
    return jsonOk({ data: { items: stremthruItems(url.searchParams.get("hash") || "") } });
  });
  try {
    const start = Date.now();
    await rdOracle.check({ hashes: [H1, H2, H3, H4, H5], type: "movie", id: "ttx", timeoutMs: 90 }, "chave");
    const elapsed = Date.now() - start;
    assert.ok(calls < 5, `não inicia lote depois do deadline; rodou ${calls}`);
    assert.ok(elapsed < 5 * delayer, `não multiplicou o prazo por lote: ${elapsed}ms`);
    assert.ok(elapsed <= 90 + 2 * delayer + 40, `próximo do deadline único: ${elapsed}ms`);
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

test("G7-regressão: cache por título filtra pelo conjunto pedido; hash que o ledger já resolveu não é ecoado", async () => {
  config.debrid.rdOracle.torrentio = true;
  // Semeia o cache por título com a resposta antiga da obra: A=true, B=false.
  // Esta chamada pede [A, B], mas o ledger já decidiu B — o dedupe do caller
  // deixa B fora da rede; o retorno do cache tem que respeitar o mesmo conjunto.
  cache.set("rdt:v1:trt:movie:tt-reg", [[H1, true], [H2, false]], 21600);
  rdLedger.noteHit([H2]);
  let rede = 0;
  const mock = mockFetch(() => {
    rede += 1;
    return jsonOk({});
  });
  try {
    const result = await rdOracle.check({ hashes: [H1, H2], type: "movie", id: "tt-reg", timeoutMs: 800 }, "chave");
    assert.equal(rede, 0, "resposta servida do cache por título, sem rede");
    assert.equal(result.get(H1), true, "true do cache preservado para o hash pedido (true-wins)");
    assert.equal(result.has(H2), false, "B fora do conjunto efetivo não é ecoado do cache — pipeline não pode rebaixar hit");
    assert.equal(result.size, 1, "só o pedido efetivo volta");
    for (const [hash, cached] of result) {
      if (!cached) rdLedger.noteMiss(hash);
    }
    assert.equal(rdLedger.peek(H2), "hit", "evidência antiga do cache não rebaixa hit confirmado depois");
  } finally {
    mock.restore();
  }
});

test("7f. deadline compartilhado: duas fontes abrem AbortSignal REAL sob o MESMO teto (sem temporização rígida)", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.deadline";
  config.debrid.rdOracle.torrentioUrl = "https://torrentio.deadline";
  config.debrid.rdOracle.torrentio = true;
  const realAbort = AbortSignal.timeout;
  const seen: number[] = [];
  AbortSignal.timeout = ((ms: number) => { seen.push(ms); return realAbort(ms); }) as typeof AbortSignal.timeout;
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: any) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.startsWith("/v0/store/torz/check")) {
      return Promise.resolve(jsonOk({ data: { items: [{ hash: H1, status: "cached" }] } }, 200));
    }
    if (url.pathname.startsWith("/realdebrid=")) {
      return Promise.resolve(jsonOk({ streams: [{ name: "[RD+] x", infoHash: H1 }] }, 200));
    }
    return Promise.resolve(jsonOk({}, 404));
  }) as unknown as typeof globalThis.fetch;
  try {
    const result = await rdOracle.check({ hashes: [H1], type: "movie", id: "tt-dl", timeoutMs: 120 }, "chave");
    assert.ok(calls.length >= 2, `duas fontes paralelas consultadas de fato: ${calls.length}`);
    assert.ok(seen.length >= 2, `abaixo de tudo, cada fonte abriu AbortSignal.timeout real: ${seen.length}`);
    assert.ok(seen.every((ms) => ms <= 120), `cada signal respeita o teto ÚNICO (< = timeoutMs): ${seen}`);
    assert.equal(result.get(H1), true, "true-wins preservado com as duas fontes no ar");
  } finally {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realAbort;
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

test("11. dedupe contra ledger: hashes já decididos não vão à rede nem são ecoados", async () => {
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
    assert.equal(result.get(H3), true, "H3 veio da rede como cached");
    assert.equal(result.has(H1), false, "hit do ledger não é ecoado: o pipeline não tem nada novo a gravar");
    assert.equal(result.has(H2), false, "miss do ledger não é ecoado: reabrir a lista não re-carimba o miss");
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
    const rawInCache = cache.get("rdt:v1:trt:movie:tt15");
    assert.ok(Array.isArray(rawInCache), "debe gardarse como Array no cache para serializar a L2");
    // Segunda chamada recupera do cache convertido a Map
    const result2 = await rdOracle.check({ hashes: [H1, H2], type: "movie", id: "tt15", timeoutMs: 800 }, "chave");
    assert.equal(result2.get(H1), true);
    assert.equal(result2.get(H2), false);
  } finally {
    mock.restore();
  }
});

test("14. reabrir a mesma lista N vezes não move attempts/at de um miss do ledger", async () => {
  // 1ª leitura: StremThru enumera H1 como não-cacheado — miss MEDIDO agora.
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  const mock1 = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") {
      return jsonOk({ data: { items: [{ hash: H1, status: "uncached" }] } });
    }
    return jsonOk({}, 404);
  });
  try {
    const v1 = await rdOracle.check({ hashes: [H1], type: "movie", id: "tt16", timeoutMs: 800 });
    assert.equal(v1.get(H1), false, "false medido agora é autoritativo");
    rdLedger.noteMiss(H1); // replica o bucle do pipeline (debrid-pipeline.ts)
    const before = cache.get(rdLedger.key(H1)) as { s: string; n: number; at: number };
    assert.equal(before.s, "miss");
    assert.equal(before.n, 1, "miss recém-medido nasce com 1 tentativa");
  } finally {
    mock1.restore();
  }

  // 2. reabrir a MESMA lista: H1 já é miss conhecido do ledger — o oráculo não
  // mede de novo nem ecoa, então o pipeline não re-escreve o miss.
  let networkCalls = 0;
  const mock2 = mockFetch(() => {
    networkCalls += 1;
    return jsonOk({});
  });
  try {
    const v2 = await rdOracle.check({ hashes: [H1], type: "movie", id: "tt1", timeoutMs: 800 });
    assert.equal(networkCalls, 0, "ledger conhece o miss; não re-mede");
    assert.equal(v2.has(H1), false, "miss do ledger não é ecoado → sem re-carimbo");
  } finally {
    mock2.restore();
  }

  const after = cache.get(rdLedger.key(H1)) as { s: string; n: number; at: number };
  assert.equal(after.s, "miss");
  assert.equal(after.n, 1, "attempts NÃO avança ao reabrir sem evidência nova");
});
