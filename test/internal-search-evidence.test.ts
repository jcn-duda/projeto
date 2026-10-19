// Regressão do enriquecimento das rotas internas (`collect`/`index`): só a
// prova de ARQUIVO (`applyFileEvidence`) é anexada no caminho de resposta. O
// `ptTitleDual` é decisão in-process do build Rust (`SearchMeta.titles` →
// `BuildContext.titles`), então a rota NÃO consulta `getTitles` nem espera TMDB.
//
// O teste da rota `index` vive em `internal-search-index.test.ts`; aqui ficam os
// dois cenários do `collect` (promessa que nunca assenta e getTitles que lança).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.CACHE_PERSIST = 'false';
import express from 'express';
import { createTestServer, encodeConfig } from './e2e/e2e-harness.js';
import config from '../src/config.js';
import { buildServices } from '../src/routes/services.js';
import { registerInternalSearch } from '../src/routes/internal-search.js';
import type { InternalSearchCollaborators } from '../src/routes/internal-search.js';
import { markFileEvidence } from '../src/utils/release-index.js';

const TOKEN = 'tok-internal-evidence';
const encoded = encodeConfig({});

let savedToken = '';
before(() => {
  savedToken = config.jackett.testToken;
  config.jackett.testToken = TOKEN;
});
after(() => {
  config.jackett.testToken = savedToken;
});

function collectBody(extra: Record<string, unknown> = {}) {
  return {
    encoded,
    query: 'Filme 2024',
    type: 'movie',
    imdb: 'tt0000001',
    deadline_at: Date.now() + 5000,
    ...extra,
  };
}

/** Registra a rota com o `collectRaw`/`getTitles` do cenário e devolve o servidor. */
async function withCollect(overrides: Partial<InternalSearchCollaborators>, fn: (server: any) => Promise<void>) {
  const app = express();
  registerInternalSearch(app as unknown as express.Router, buildServices(), overrides);
  const server = await createTestServer(app);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test('collect: não toca getTitles nem espera TMDB; ptTitleDual fica com o Rust', async () => {
  let calls = 0;
  await withCollect({
    // Se a rota voltar a consultar os títulos, a promessa nunca assenta e o
    // teste (além do contador) estoura o prazo — é o await inútil que saiu.
    getTitles: (() => {
      calls += 1;
      return new Promise(() => {});
    }) as any,
    collectRaw: (async () => ({
      items: [
        { title: 'Filme 2024 1080p DUBLADO', infoHash: 'a'.repeat(40), indexer: 'bludv', isBr: true },
        { title: 'Movie 2024 1080p', infoHash: 'b'.repeat(40), indexer: 'eztv' },
        { title: 'Órfão 2024', infoHash: 'c'.repeat(40) },
      ],
      partial: true,
      completion: Promise.resolve(),
      sweepInline: false,
      live: null,
    })) as any,
  }, async (server) => {
    const started = Date.now();
    const res = await server.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody(),
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 0, 'getTitles não pode ser tocado no caminho de coleta');
    assert.ok(Date.now() - started < 2000, 'a resposta não espera metadados');
    // O flag que a rota anexava saiu; o build in-process do Rust decide pelo
    // `SearchMeta.titles` (meta_tests + audio_proof_tests cobrem o núcleo).
    assert.equal(res.json.items.every((item: any) => item.ptTitleDual === undefined), true);
  });
});

test('collect: getTitles que lança não derruba a rota e a prova de arquivo continua', async () => {
  const hash = 'd'.repeat(40);
  markFileEvidence(hash, { a: 'Dual', q: '720p', n: 'Filme.2024.720p.DUAL.mkv' });
  let calls = 0;
  await withCollect({
    getTitles: (() => {
      calls += 1;
      throw new Error('getTitles não deve ser chamado na coleta');
    }) as any,
    collectRaw: (async () => ({
      items: [
        { title: 'Filme 2024 1080p DUBLADO', infoHash: hash, indexer: 'bludv', isBr: true },
        { title: 'Movie 2024 1080p', infoHash: 'e'.repeat(40), indexer: 'eztv' },
      ],
      partial: false,
      completion: Promise.resolve(),
      sweepInline: false,
      live: null,
    })) as any,
  }, async (server) => {
    const res = await server.request('POST', '/internal/search/collect', {
      headers: { 'X-Indexer-Test-Token': TOKEN },
      body: collectBody(),
    });
    assert.equal(res.status, 200);
    assert.equal(calls, 0);
    const comProva = res.json.items.find((item: any) => item.infoHash === hash);
    assert.equal(comProva.provenAudio, 'Dual', 'applyFileEvidence segue intacto');
    assert.equal(comProva.provenQuality, '720p');
    assert.equal(comProva.provenName, 'Filme.2024.720p.DUAL.mkv');
    assert.equal(comProva.ptTitleDual, undefined);
    const semProva = res.json.items.find((item: any) => item.infoHash === 'e'.repeat(40));
    assert.equal(semProva.provenAudio, undefined, 'sem evidência o item passa intacto');
  });
});
