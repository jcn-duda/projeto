// A sonda (Fase 8, 8.3) contra o NONO site: o Mico é API do addon, não HTML, e
// a sua descoberta é a ÚNICA que grava estado — o `discoverKind` persiste o
// cursor `full-sweep:<kind>` quando a varredura completa termina. O contrato de
// OBSERVAÇÃO da sonda é EXPLÍCITO: a CLI passa `noPersist: true` no `discover`
// (opção do `CrawlDiscoverOptions`) e o `discoverKind` condiciona a ESCRITA do
// cursor a `!noPersist` — a escolha normal full/incremental, as marcações
// (`complete`/`completeByKind`) e o custo ficam intactos; o motor (sem a
// opção) persiste como sempre. Nenhum atalho de config/env falseia semântica.
//
// Cobertura:
//   - `noPersist: true` está na chamada da CLI e o atalho env
//     (`MICO_CRAWL_FULL_SWEEP_HOURS` gigante) NÃO existe;
//   - descoberta em OBSERVAÇÃO que rodaria varredura completa e veria o fim
//     grava ZERO (cursor, fila, veredito) com `completeByKind` intacto;
//   - o portão de série da sonda: sem `--series` nenhuma tv_show; com, entra
//     tv_show e TAMBÉM não grava;
//   - a página de filme na amostra (dry-run + noPersist) não toca fila nem
//     acervo — `simulated`/`no-torrent` carrega o que foi visto;
//   - SEM `noPersist` (motor), a varredura completa grava o cursor.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const micoCrawl = await import('../src/providers/crawl-sites/mico.js');
const crawlStore = await import('../src/utils/crawl-store.js');
const { processCrawlPage } = await import('../src/providers/crawl-page.js');
const { PROBE_STATE_KEY } = await import('../src/providers/crawl-site-probe.js');
const { PROBE_USAGE, probeArgGate, parseProbeOptions } = await import('../src/providers/crawl-site-probe-report.js');
const { stubFetch } = await import('./helpers/stub.js');
import type { CrawlSeriesLimits, CrawlUrlRow } from '../src/providers/crawl-types.js';

const FIX = path.join(process.cwd(), 'test', 'fixtures', 'crawl', 'mico');
const read = (name: string): any => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const HOST = config.mico.url;
const synthetic = (kind: 'movie' | 'series', tt: string) => `${HOST}/crawl/${kind}/${tt}/`;
const SAMPLE_SERIES: CrawlSeriesLimits = { enabled: true, maxCards: 10, maxButtons: 40 };

const savedMico = { ...config.mico };

beforeEach(() => {
  crawlStore.resetForTests();
  crawlStore.open(undefined, { forceMemory: true });
  config.mico.enabled = true;
  config.mico.crawlMinGapMs = 0;
  micoCrawl._resetThrottleForTest();
});

after(() => {
  Object.assign(config.mico, savedMico);
  micoCrawl._resetThrottleForTest();
});

/** Dublê das rotas que a descoberta e a amostra de filme do Mico consomem.
 *  `skip` sem rota = catálogo esgotado (a API real responde 200 com `metas: []`). */
function micoStub(routes: {
  catalog?: Record<number, any>;
  seriesCatalog?: Record<number, any>;
  stream?: Record<string, any>;
}) {
  const resp = (r: any) => (r && typeof r.status === 'number'
    ? { ok: false, status: r.status, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => r ?? { metas: [] } });
  return stubFetch((url) => {
    const mc = /\/catalog\/movie\/MicoFilmes\/skip=(\d+)\.json/.exec(url);
    if (mc) return resp(routes.catalog?.[Number(mc[1])]);
    const sc = /\/catalog\/series\/MicoSeries\/skip=(\d+)\.json/.exec(url);
    if (sc) return resp(routes.seriesCatalog?.[Number(sc[1])]);
    const st = /\/stream\/movie\/(tt\d+)\.json/.exec(url);
    if (st) {
      const r = routes.stream?.[st[1]];
      return r ? resp(r) : { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** O store não pode ter NADA da rodada: cursor, fila e veredito zerados. */
function assertStoreUntouched(engine: ReturnType<typeof crawlStore.engine>): void {
  assert.equal(engine.getState('mico', 'full-sweep:movie'), null, 'cursor de filme não foi gravado');
  assert.equal(engine.getState('mico', 'full-sweep:series'), null, 'cursor de série não foi gravado');
  assert.equal(engine.getState('mico', PROBE_STATE_KEY), null, 'veredito não é gravado sem --write');
  assert.equal(engine.counters('mico').total, 0, 'nenhuma linha de fila foi criada');
}

describe('sonda mico: descoberta de observação (noPersist) não grava NADA', () => {
  test('varredura completa que VERIA O FIM grava zero e mantém a semântica full', async () => {
    const site = micoCrawl.createMicoCrawlSite(); // SEM argumentos, como a CLI usa
    const stub = micoStub({ catalog: { 0: read('catalog-skip-0.json'), 25: read('catalog-skip-5.json') } });
    try {
      // Store vazio = última varredura completa é NULA: a escolha normal é FULL
      // SWEEP — e é isso que a observação roda, sem falsear por config.
      const found = await site.discover(null, {
        series: { enabled: false, maxCards: 10, maxButtons: 40 },
        noPersist: true,
      });
      assert.equal(found.urls.length, 7, 'a descoberta leu o catálogo stubado');
      assert.equal(found.complete, true, 'a rodada terminou completa (viu o fim das vazias)');
      assert.equal(found.completeByKind?.movie, true,
        'a escolha full/incremental NÃO foi falseada (full sweep de verdade)');
      // Sob a regra do MOTOR, completa + sawEnd + fullSweep grava o cursor — é
      // exatamente o que o `noPersist` da observação impede.
      assertStoreUntouched(crawlStore.engine());
    } finally {
      stub.restore();
    }
  });

  test('portão de série: sem --series zero tv_show; com, entra tv_show e segue sem gravação', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({
      catalog: { 0: read('catalog-skip-0.json'), 25: read('catalog-skip-5.json') },
      seriesCatalog: { 0: read('catalog-series-skip-0.json'), 25: read('catalog-series-skip-3.json') },
    });
    try {
      const semSerie = await site.discover(null, { series: { ...SAMPLE_SERIES, enabled: false }, noPersist: true });
      assert.ok(semSerie.urls.every((u) => u.kind === 'movie'), 'sem --series nenhuma tv_show sai');
      const comSerie = await site.discover(null, { series: SAMPLE_SERIES, noPersist: true });
      assert.equal(comSerie.urls.filter((u) => u.kind === 'tv_show').length, 4, 'a rodada de série descobriu tv_show');
      assert.equal(comSerie.completeByKind?.tv_show, true, 'semântica da descoberta de série intacta');
      assertStoreUntouched(crawlStore.engine());
    } finally {
      stub.restore();
    }
  });
});

describe('sonda mico: página da amostra é dry-run + noPersist', () => {
  /** Linha SINTÉTICA da amostra (não existe em lugar nenhum do store). */
  const row = (kind: 'movie' | 'series', tt: string): CrawlUrlRow => ({
    site: 'mico', url: synthetic(kind, tt), lastmod: '', kind: kind === 'series' ? 'tv_show' : 'movie',
    status: 'pending', imdb: null, tries: 0, nextAt: 0, checkedAt: 0,
    releases: 0, error: '', progress: '', addedAt: 0,
  });

  test('página de filme com release → simulated, e fila/acervo não recebem NADA', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ stream: { tt7286456: read('stream-movie.json') } });
    try {
      const outcome = await processCrawlPage(site, row('movie', 'tt7286456'), {
        dryRun: true, noPersist: true, series: { ...SAMPLE_SERIES, enabled: false },
      });
      assert.equal(outcome.kind, 'simulated', 'IMDb pronto + dry-run → simulated (nunca done)');
      assert.ok(outcome.releases >= 1, 'o desfecho carrega as releases VISTAS');
      assert.equal(outcome.requestCost, 1, 'a página custou a chamada de stream');
      assertStoreUntouched(crawlStore.engine());
    } finally {
      stub.restore();
    }
  });

  test('página sem stream → no-torrent, e mesmo assim zero gravação', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ stream: { tt0000009: read('stream-empty.json') } });
    try {
      const outcome = await processCrawlPage(site, row('movie', 'tt0000009'), {
        dryRun: true, noPersist: true, series: { ...SAMPLE_SERIES, enabled: false },
      });
      assert.equal(outcome.kind, 'no-torrent');
      assert.equal(outcome.requestCost, 1);
      assertStoreUntouched(crawlStore.engine());
    } finally {
      stub.restore();
    }
  });
});

describe('motor preservado: sem noPersist, a varredura completa grava o cursor', () => {
  test('full-sweep normal do motor continua persistindo', async () => {
    const site = micoCrawl.createMicoCrawlSite();
    const stub = micoStub({ catalog: { 0: read('catalog-skip-0.json'), 25: read('catalog-skip-5.json') } });
    try {
      const found = await site.discover(null); // SEM noPersist: o motor de verdade
      assert.equal(found.complete, true);
      assert.equal(found.completeByKind?.movie, true, 'a rodada vale cobertura de cursor');
      assert.ok(Number(crawlStore.engine().getState('mico', 'full-sweep:movie') || 0) > 0,
        'o cursor full-sweep foi gravado (fluxo normal de produção)');
      assert.equal(crawlStore.engine().counters('mico').total, 0, 'a descoberta nunca grava fila (isso é do motor)');
    } finally {
      stub.restore();
    }
  });
});

describe('sonda mico: a CLI usa o contrato noPersist e NÃO tem atalho de env', () => {
  const script = fileURLToPath(new URL('../scripts/crawl-site-probe.js', import.meta.url));

  test('o pin env `MICO_CRAWL_FULL_SWEEP_HOURS` NÃO existe; a descoberta vai de `noPersist`', () => {
    const src = fs.readFileSync(script, 'utf8');
    assert.doesNotMatch(src, /MICO_CRAWL_FULL_SWEEP_HOURS/,
      'sem número mágico de env falseando o horizonte da varredura');
    assert.match(src, /discover\(null,\s*\{\s*series,\s*noPersist:\s*true\s*\}\)/,
      'a chamada da sonda passa o contrato explícito');
    assert.match(src, /process\.env\.CACHE_PERSIST = 'false'/, 'o pré-ajuste de cache segue lá');
  });

  test('o adaptador do Mico entra sem surface e sem argumento (API, não HTML)', () => {
    const src = fs.readFileSync(script, 'utf8');
    assert.match(src, /if \(siteId === 'mico'\)\s*return createMicoCrawlSite\(\);/,
      'ramo direto com a fábrica SEM argumentos');
    assert.doesNotMatch(src, /createMicoCrawlSite\([^)]/, 'nenhum argumento inventado');
    assert.doesNotMatch(src, /micoSurface/, 'Mico é API: não existe surface de resolver para inventar');
    assert.match(src, /hdrtorrent-cardigann e mico/, 'a mensagem de sites conhecidos lista o Mico');
  });
});

describe('sonda mico: gate e --help aceitam o site', () => {
  const defaults = { site: 'vacatorrent', delayMs: 1000, seriesMaxCards: 10, seriesMaxButtons: 40 };

  test('--site=mico passa no gate e no parse (site é arbitrário, sem enum)', () => {
    assert.deepEqual(probeArgGate(['--site=mico']).unknown, [], 'o gate não tem enum de sites');
    assert.equal(parseProbeOptions(['--site=mico'], {}, defaults).site, 'mico');
  });

  test('o uso documenta o Mico e a descoberta sem persistência', () => {
    assert.match(PROBE_USAGE, /\bmico\b/, 'o uso lista o Mico');
    assert.match(PROBE_USAGE, /sem persistencia e nunca escreve/, 'e diz que a descoberta não grava');
  });
});
