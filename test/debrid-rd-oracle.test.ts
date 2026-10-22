import { test } from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import * as rdOracle from "../src/debrid/rd-oracle.js";

// Gate do oráculo do Real-Debrid. Depois da Fase 1 do corte "mais Rust, menos
// TS" só sobrou `available()`: o despachante (`check`) morreu junto com o
// `applyDebrid` do `src/`, e o registry consulta este flag para decidir se o RD
// promete `cacheCheck` dinâmico (src/debrid/registry.ts:66).
//
// O que estes casos protegem é o opt-in: sem fonte EXPLÍCITA (endpoint +
// credencial), a apiKey da instalação não é considerada utilizável e o RD
// continua honesto ("não sei").

const ORACLE_SNAPSHOT = { ...config.debrid.rdOracle };

test.beforeEach(() => {
  config.debrid.rdOracle.enabled = true;
  config.debrid.rdOracle.stremthruUrl = "";
  config.debrid.rdOracle.stremthruToken = "";
  config.debrid.rdOracle.torrentio = false;
  config.debrid.rdOracle.torrentioUrl = "https://torrentio.strem.fun";
  config.debrid.rdOracle.torrentioKey = "";
});

test.afterEach(() => {
  Object.assign(config.debrid.rdOracle, ORACLE_SNAPSHOT);
});

test("kill-switch DEBRID_RD_ORACLE=false: available() false mesmo com fonte configurada", () => {
  config.debrid.rdOracle.enabled = false;
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.stremthruToken = "token";
  assert.equal(rdOracle.available("chave-da-instalacao"), false);
});

test("sem fonte explicitamente habilitada, a apiKey da instalação não basta (opt-in)", () => {
  config.debrid.rdOracle.stremthruUrl = "";
  config.debrid.rdOracle.torrentio = false;
  assert.equal(rdOracle.available("chave-da-instalacao"), false);
  assert.equal(rdOracle.available(), false);
});

test("StremThru utilizável: endpoint + credencial explícita OU apiKey efetiva", () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  assert.equal(rdOracle.available(), false, "endpoint sem credencial nenhuma não conta");
  config.debrid.rdOracle.stremthruToken = "token-da-fonte";
  assert.equal(rdOracle.available(), true, "token da fonte basta");
  config.debrid.rdOracle.stremthruToken = "";
  assert.equal(rdOracle.available("chave-da-instalacao"), true, "token vazio cai na apiKey efetiva");
});

test("Torrentio exige a flag E credencial efetiva", () => {
  config.debrid.rdOracle.torrentioUrl = "https://torrentio.example";
  config.debrid.rdOracle.torrentioKey = "chave-torrentio";
  assert.equal(rdOracle.available(), false, "flag desligada: nem URL nem key habilitam");
  config.debrid.rdOracle.torrentio = true;
  assert.equal(rdOracle.available(), true, "flag + key explícita");
  config.debrid.rdOracle.torrentioKey = "";
  assert.equal(rdOracle.available(), false, "flag sem key nem apiKey não conta");
  assert.equal(rdOracle.available("chave-da-instalacao"), true, "flag + apiKey efetiva");
});
