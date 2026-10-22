import { test } from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import * as rdOracle from "../src/debrid/rd-oracle.js";

// Composição das fontes do oráculo do Real-Debrid. A Fase 1 do corte "mais
// Rust, menos TS" levou o despachante (`checkStremthru`/`checkTorrentio`); o que
// sobrou é o gate que o registry lê (src/debrid/registry.ts:66). Estes casos
// cobrem o que o gate exige de cada fonte: endpoint próprio e credencial
// efetiva — e que as fontes somam por OR, não por AND.

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

test("endpoint vazio desliga a fonte mesmo com token/flag", () => {
  config.debrid.rdOracle.stremthruToken = "token";
  assert.equal(rdOracle.available(), false, "StremThru sem URL não é fonte");

  config.debrid.rdOracle.torrentio = true;
  config.debrid.rdOracle.torrentioKey = "chave";
  config.debrid.rdOracle.torrentioUrl = "";
  assert.equal(rdOracle.available(), false, "Torrentio sem URL não é fonte");

  config.debrid.rdOracle.torrentioUrl = "https://torrentio.example";
  assert.equal(rdOracle.available(), true, "com URL + flag + key a fonte volta");
});

test("as fontes somam por OR: uma utilizável já basta", () => {
  config.debrid.rdOracle.stremthruUrl = "https://st.example";
  config.debrid.rdOracle.stremthruToken = "token";
  assert.equal(rdOracle.available(), true, "só StremThru utilizável");

  config.debrid.rdOracle.stremthruUrl = "";
  config.debrid.rdOracle.stremthruToken = "";
  config.debrid.rdOracle.torrentio = true;
  config.debrid.rdOracle.torrentioUrl = "https://torrentio.example";
  config.debrid.rdOracle.torrentioKey = "chave";
  assert.equal(rdOracle.available(), true, "só Torrentio utilizável");
});
