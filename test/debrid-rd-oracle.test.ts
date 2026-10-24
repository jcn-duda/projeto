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

test("7b. fixture real StremThru: 'cached' => true; 'unknown' => SEM veredicto (nunca miss)", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  const cachedHash = STREMTHRU_FIX.data.items[0].hash.toLowerCase();
  const unknownHash = STREMTHRU_FIX.data.items[1].hash.toLowerCase();
  assert.equal(STREMTHRU_FIX.data.items[1].status, "unknown", "a fixture real precisa manter o tri-estado");
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") return jsonOk(STREMTHRU_FIX);
    return jsonOk({}, 404);
  });
  try {
    const result = await rdOracle.check({ hashes: [cachedHash, unknownHash], type: "movie", id: "tt21", timeoutMs: 800 }, "chave");
    assert.equal(result.get(cachedHash), true, "status cached = hit");
    assert.equal(
      result.has(unknownHash),
      false,
      "'unknown' é o StremThru dizendo que não sabe; virar false gravaria miss de até 3 dias no ledger global",
    );
  } finally {
    mock.restore();
  }
});

test("7A. StremThru tri-estado no MESMO envelope: cached→true, uncached/not_cached→false, unknown/estranho ausentes (sem noteMiss)", async () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  const items = [
    { hash: H1, status: "cached" },
    { hash: H2, status: "uncached" },
    { hash: H3, status: "not_cached" },
    { hash: H4, status: "unknown" },
    { hash: H5, status: "algum_status_novo" },
  ];
  const mock = mockFetch((url) => {
    if (url.pathname === "/v0/store/torz/check") return jsonOk({ data: { items } });
    return jsonOk({}, 404);
  });
  try {
    const verdicts = await rdOracle.check(
      { hashes: [H1, H2, H3, H4, H5], type: "movie", id: "tt-tri", timeoutMs: 800 },
      "chave",
    );
    assert.equal(verdicts.get(H1), true, "cached = hit");
    assert.equal(verdicts.get(H2), false, "uncached = miss autoritativo");
    assert.equal(verdicts.get(H3), false, "not_cached = miss autoritativo");
    assert.equal(verdicts.has(H4), false, "unknown fica fora do Map (nunca false)");
    assert.equal(verdicts.has(H5), false, "status desconhecido sem veredicto nenhum");

    // Replica o loop exato do pipeline (debrid-pipeline.ts) apos check().
    const hitsArr: string[] = [];
    for (const [hash, cached] of verdicts) {
      if (cached) hitsArr.push(String(hash));
      else rdLedger.noteMiss(hash);
    }
    if (hitsArr.length) rdLedger.noteHit(hitsArr);

    // Só cached e os negativos EXPLÍCITOS tocam o ledger; unknown (e status
    // estranho) não geram noteMiss — virar miss envenenaria o ledger por 3 dias.
    assert.equal(rdLedger.peek(H1), "hit");
    assert.equal(rdLedger.peek(H2), "miss");
    assert.equal(rdLedger.peek(H3), "miss");
    assert.equal(rdLedger.peek(H4), "unknown", "unknown não vira miss no loop do pipeline");
    assert.equal(rdLedger.peek(H5), "unknown", "status desconhecido também não grava nada");
  } finally {
    mock.restore();
  }
});

test("7B. sem fonte explicitamente habilitada, nenhuma credencial sai para terceiro", async () => {
  config.debrid.rdOracle.stremthruUrl = "";
  config.debrid.rdOracle.stremthruToken = "token-que-nao-deve-sair";
  config.debrid.rdOracle.torrentio = false;
  let fetches = 0;
  const mock = mockFetch(() => {
    fetches += 1;
    return jsonOk({});
  });
  try {
    assert.equal(rdOracle.available("chave-da-instalacao"), false);
    const result = await rdOracle.check(
      { hashes: [H1], type: "movie", id: "tt-opt-in", timeoutMs: 800 },
      "chave-da-instalacao",
    );
    assert.equal(result.size, 0);
    assert.equal(fetches, 0, "sem endpoint/flag explícito não há chamada externa");
  } finally {
    mock.restore();
  }
});
