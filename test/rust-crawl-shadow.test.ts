// Ligação de captura/shadow do raspador (rust-crawl-shadow.ts + crawl-page.ts).
//
// Prova o fio REAL do shadow com um núcleo STUB injetado (`setCoreForTest`):
// o modo `off` só não lança — não prova a ligação. Aqui rodamos em `shadow`,
// comparamos a MESMA unidade de página (links pré-protetor do tap) contra o
// `parseCrawlPage` stub e checamos métricas de página/divergência/erro. Também
// cobrimos a captura (confinada, limitada, scrub de token/cookie) e o funil.
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const metrics = (await import('../src/utils/metrics.js'));
const rustCore = (await import('../src/utils/rust-core.js'));
const { captureCrawlPage, shadowCrawlPage, scrubCrawlPage } = await import('../src/utils/rust-crawl-shadow.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');

const savedCaptureDir = config.crawl.captureDir;
const savedMaxBytes = config.crawl.captureMaxBytes;
const savedShadowMaxBytes = config.crawl.shadowMaxBytes;
const savedMode = config.rustCore.mode;

/** Espera o `setImmediate` do shadow/captura (ambos em background). */
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/** Resultado mínimo do `parseCrawlPage` do Rust. */
function rustPage(over: Record<string, unknown> = {}) {
  return { url: 'https://x.test/a/', status: 'no-torrent', releases: [], groups: [], unlocated: [], ...over };
}

/** Injeta um núcleo stub com o `parseCrawlPage` dado e liga o modo shadow. */
function useCore(parseCrawlPage: (site: string, kind: string, url: string, html: string) => unknown) {
  config.rustCore.mode = 'shadow';
  rustCore.setCoreForTest({ normalizeTitle: (t: string) => t, parseCrawlPage } as never);
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-capture-'));
  config.crawl.captureDir = tmp;
  config.crawl.captureMaxBytes = savedMaxBytes;
  config.crawl.shadowMaxBytes = savedShadowMaxBytes;
  metrics.reset();
  rustCore.setCoreForTest(null);
  config.rustCore.mode = 'off';
});

afterEach(() => {
  // Limpa o tmp DESTE teste (o `after` só veria o último, vazando os demais).
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp do SO */ }
});

after(() => {
  config.crawl.captureDir = savedCaptureDir;
  config.crawl.captureMaxBytes = savedMaxBytes;
  config.crawl.shadowMaxBytes = savedShadowMaxBytes;
  config.rustCore.mode = savedMode;
  rustCore.setCoreForTest(null);
});

test('scrubCrawlPage: redige tokens de protetor reais (id/pub/data-token) e cookie, preserva btih/href', () => {
  const html = '<a href="magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&tr=https://t/?passkey=SEGREDO">x</a>'
    + '<script>document.cookie = "sid=segredo"</script>'
    + '<a href="https://nerd.test/link.php?id=BLOBNERD123">nerd</a>'
    + '<a href="https://systemtech.space/enc/go.php?id=BLOBVACA&pub=PUB_fBL3F0">vaca</a>'
    + '<a data-token="BASE64TOKEN==" class="bt">rede</a>'
    + '<div id="main">x</div>';
  const out = scrubCrawlPage(html);
  for (const secret of ['SEGREDO', 'sid=segredo', 'BLOBNERD123', 'BLOBVACA', 'PUB_fBL3F0', 'BASE64TOKEN']) {
    assert.equal(out.includes(secret), false, `segredo vazou: ${secret}`);
  }
  assert.equal(out.includes('btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01'), true, 'btih preservado');
  assert.equal(out.includes('link.php'), true, 'href de protetor (estrutura) preservado');
  assert.equal(out.includes('go.php'), true, 'href de protetor (estrutura) preservado');
  assert.equal(out.includes('data-token='), true, 'atributo data-token preservado');
  assert.equal(out.includes('id="main"'), true, 'id de ELEMENTO (aspa) não é tocado');
  assert.equal(scrubCrawlPage(html), out, 'determinístico');
});

test('captura escreve HTML + meta com host/caminho e SEM segredo', async () => {
  captureCrawlPage('bludv-cardigann', 'movie', 'https://bludv.test/filmes/matrix/?token=SEGREDO#top', scrubCrawlPage('<h1>Matrix (1999)</h1>'));
  await settle();

  const dir = path.join(tmp, 'bludv-cardigann');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['_filmes_matrix.html', '_filmes_matrix.meta.json']);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '_filmes_matrix.meta.json'), 'utf8'));
  assert.equal(meta.site, 'bludv-cardigann');
  assert.equal(meta.kind, 'movie');
  assert.equal(meta.host, 'bludv.test');
  assert.equal(meta.path, '/filmes/matrix');
  assert.equal(JSON.stringify(meta).includes('SEGREDO'), false, 'query não vaza no meta');
});

test('captura: JSON ganha .json; sem dir é no-op; teto e traversal confinados', async () => {
  captureCrawlPage('mico', 'movie', 'https://mico.test/crawl/movie/tt0133093/', '{"streams":[]}');
  await settle();
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'mico')).sort(), ['_crawl_movie_tt0133093.json', '_crawl_movie_tt0133093.meta.json']);

  config.crawl.captureDir = null;
  captureCrawlPage('mico', 'movie', 'https://mico.test/x/', '{"streams":[]}');
  await settle();
  config.crawl.captureDir = tmp;

  config.crawl.captureMaxBytes = 8;
  captureCrawlPage('mico', 'movie', 'https://mico.test/y/', '{"streams":[1,2,3]}');
  await settle();
  assert.equal(fs.existsSync(path.join(tmp, 'mico', '_y.json')), false, 'acima do teto não grava');
  config.crawl.captureMaxBytes = savedMaxBytes;

  captureCrawlPage('../evil', 'movie', 'https://x.test/a/b/', '<html>x</html>');
  await settle();
  assert.equal(fs.existsSync(path.resolve(tmp, '..', 'evil')), false, 'site sanitizado não escapa');
  assert.deepEqual(fs.readdirSync(path.join(tmp, '___evil')).sort(), ['_a_b.html', '_a_b.meta.json']);
});

test('shadow OFF é no-op (não conta páginas)', async () => {
  const r = { url: 'https://x.test/a/', status: 'no-torrent' as const };
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', '<html>x</html>', r);
  await settle();
  assert.equal(metrics.snapshot().counters['rust.crawl.pages'], undefined);
});

test('shadow SHADOW: mesma unidade casa (sem diff) e conta a página', async () => {
  useCore(() => rustPage());
  const r = { url: 'https://x.test/a/', status: 'no-torrent' as const };
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', '<html>x</html>', r, []);
  await settle();
  const c = metrics.snapshot().counters;
  assert.equal(c['rust.crawl.pages'], 1, 'ligação Rust exercitada');
  assert.equal(c['rust.crawl.diff'], undefined, 'unidade igual não diverge');
});

test('shadow SHADOW: divergência de status e de torrents conta rust.crawl.diff', async () => {
  const MAG = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  useCore(() => rustPage({
    status: 'done',
    releases: [{ title: 'R', magnet: MAG, indexer: 'x', tracker: '', isBr: true, seeders: 1 }],
  }));
  const r = { url: 'https://x.test/a/', status: 'no-torrent' as const };
  // TS sem links, Rust com 1 release → diff de status E de torrents.
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', '<html>x</html>', r, []);
  await settle();
  const c = metrics.snapshot().counters;
  assert.ok((c['rust.crawl.diff'] ?? 0) >= 1, 'divergência contada');
  assert.equal(c['rust.crawl.error'], undefined, 'divergência não é erro');
});

test('shadow SHADOW: comparar LINKS de página (pré-protetor) casa com releases do Rust', async () => {
  const MAG = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  useCore(() => rustPage({
    status: 'done',
    releases: [{ title: 'R', magnet: MAG, indexer: 'x', tracker: '', isBr: true, seeders: 1 }],
  }));
  const r = { url: 'https://x.test/a/', status: 'done' as const };
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', '<html>x</html>', r, [{ url: MAG }]);
  await settle();
  const c = metrics.snapshot().counters;
  assert.equal(c['rust.crawl.diff'], undefined, 'mesmo btih não diverge');
});

test('shadow SHADOW: protetor vira contagem, magnet casa — sem diff espúrio', async () => {
  const MAG = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  useCore(() => rustPage({ status: 'done', releases: [{ title: 'R', magnet: MAG, indexer: 'x', tracker: '', isBr: true, seeders: 1 }] }));
  const r = { url: 'https://x.test/a/', status: 'done' as const };
  shadowCrawlPage('vacatorrent', 'movie', 'https://x.test/a/', '<html>x</html>', r, [{ url: MAG }, { url: 'https://prot.test/go?id=BLOB' }]);
  await settle();
  const c = metrics.snapshot().counters;
  assert.equal(c['rust.crawl.page_link.protector'], 1, 'protetor contado (NÃO virou chave de torrent)');
  assert.equal(c['rust.crawl.diff'], undefined, 'magnet casa; protetor não gera diff espúrio');
});

test('shadow SHADOW: status done pós-protetor × no-torrent pré-protetor conta protetor, NÃO diff', async () => {
  // Vaca movie: o TS chega a 'done' SÓ depois de seguir go.php; o Rust, pré-
  // protetor (links sem magnet), diz 'no-torrent'. Divergência EXPLICADA.
  useCore(() => rustPage({ status: 'no-torrent' }));
  const r = { url: 'https://x.test/a/', status: 'done' as const };
  shadowCrawlPage('vacatorrent', 'movie', 'https://x.test/a/', '<html>x</html>', r, [{ url: 'https://prot.test/go?id=BLOB' }]);
  await settle();
  const c = metrics.snapshot().counters;
  assert.equal(c['rust.crawl.status.protector'], 1, 'explicada por protetor, contada à parte');
  assert.equal(c['rust.crawl.diff'], undefined, 'não vira diff sistemático');
  assert.equal(c['rust.crawl.page_link.protector'], 1, 'fronteira segue visível');
});

test('shadow SHADOW: divergência REAL pré-protetor ainda marca diff', async () => {
  // Rust acha um magnet que a PÁGINA TS não tem (ambos pré-protetor) → diff real.
  const MAG = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  useCore(() => rustPage({ status: 'done', releases: [{ title: 'R', magnet: MAG, indexer: 'x', tracker: '', isBr: true, seeders: 1 }] }));
  const r = { url: 'https://x.test/a/', status: 'no-torrent' as const };
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', '<html>x</html>', r, []);
  await settle();
  const c = metrics.snapshot().counters;
  assert.ok((c['rust.crawl.diff'] ?? 0) >= 1, 'divergência real marca diff');
  assert.equal(c['rust.crawl.status.protector'], undefined, 'não é explicada por protetor');
});

test('shadow SHADOW: campo unilateral marca diff; Mico (título de release) não', async () => {
  // Rust com título de obra; TS sem → unilateral → diff.
  useCore(() => rustPage({ status: 'done', title: 'Matrix' }));
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', '<html>x</html>', { url: 'https://x.test/a/', status: 'done' }, []);
  await settle();
  assert.ok((metrics.snapshot().counters['rust.crawl.diff'] ?? 0) >= 1, 'unilateral marca diff');
  // Mico: o title do TS é de RELEASE — o unilateral de título não pode disparar.
  metrics.reset();
  useCore(() => rustPage({ status: 'done', title: 'Matrix' }));
  shadowCrawlPage('mico', 'movie', 'https://x.test/a/', '{"streams":[]}', { url: 'https://x.test/a/', status: 'done' }, []);
  await settle();
  assert.equal(metrics.snapshot().counters['rust.crawl.diff'], undefined, 'mico não compara título');
});

test('shadow SHADOW: teto PRÓPRIO de bytes, independente do de captura', async () => {
  useCore(() => rustPage());
  const big = `<html>${'x'.repeat(64)}</html>`;
  // Teto de CAPTURA desligado NÃO desliga o do shadow.
  config.crawl.captureMaxBytes = 0;
  config.crawl.shadowMaxBytes = 8;
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', big, { url: 'https://x.test/a/', status: 'done' }, []);
  await settle();
  let c = metrics.snapshot().counters;
  assert.equal(c['rust.crawl.shadow.skipped'], 1, 'teto do shadow vale mesmo com captura sem teto');
  assert.equal(c['rust.crawl.pages'], undefined, 'nenhum parse nativo disparado');
  // 0 no teto do shadow LIGA explicitamente o parse (só este teto desligado).
  metrics.reset();
  config.crawl.shadowMaxBytes = 0;
  shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', big, { url: 'https://x.test/a/', status: 'done' }, []);
  await settle();
  c = metrics.snapshot().counters;
  assert.equal(c['rust.crawl.pages'], 1, 'shadowMaxBytes=0 desliga só o teto do shadow');
});

test('shadow SHADOW: pageUnit (Mico série) compara a unidade, não o agregado', async () => {
  useCore(() => rustPage({ status: 'no-torrent' }));
  const agg = { url: 'https://x.test/s/', status: 'done' as const, groups: [{ season: 1, episode: 1, releases: [] }] };
  // SEM unit: compararia o agregado (done) × o parse do episódio (no-torrent) → diff.
  shadowCrawlPage('mico', 'tv_show', 'https://x.test/s/', '{"streams":[]}', agg, []);
  await settle();
  assert.ok((metrics.snapshot().counters['rust.crawl.diff'] ?? 0) >= 1, 'agregado diverge (esperado sem unit)');
  metrics.reset();
  // COM unit do episódio: casa (é a MESMA unidade do conteúdo).
  shadowCrawlPage('mico', 'tv_show', 'https://x.test/s/', '{"streams":[]}', agg, [], { status: 'no-torrent' });
  await settle();
  assert.equal(metrics.snapshot().counters['rust.crawl.diff'], undefined, 'unidade casa');
});

test('shadow SHADOW: pageUnit sem imdb cai para o tsResult (Mico série, SEM falso positivo)', async () => {
  const agg = { url: 'https://x.test/s/', status: 'done' as const, imdb: 'tt0133093', groups: [] };
  // Caminho REAL do Mico série: a unit traz SÓ status (mico-series.ts) e o Rust
  // deriva o IMDb da URL. Com fallback por campo, o imdb do agregado casa → sem diff.
  useCore(() => rustPage({ status: 'done', imdb: 'tt0133093' }));
  shadowCrawlPage('mico', 'tv_show', 'https://x.test/s/', '{"streams":[]}', agg, [], { status: 'done' });
  await settle();
  assert.equal(metrics.snapshot().counters['rust.crawl.diff'], undefined, 'imdb do agregado casa; sem falso positivo');
  // imdb REALMENTE divergente → marca diff.
  metrics.reset();
  useCore(() => rustPage({ status: 'done', imdb: 'tt0000001' }));
  shadowCrawlPage('mico', 'tv_show', 'https://x.test/s/', '{"streams":[]}', agg, [], { status: 'done' });
  await settle();
  assert.ok((metrics.snapshot().counters['rust.crawl.diff'] ?? 0) >= 1, 'imdb divergente marca diff');
});

test('shadow SHADOW: erro do Rust é fail-open (conta rust.crawl.error, não lança)', async () => {
  useCore(() => { throw new Error('boom'); });
  const r = { url: 'https://x.test/a/', status: 'done' as const };
  assert.doesNotThrow(() => shadowCrawlPage('bludv-cardigann', 'movie', 'https://x.test/a/', '<html>x</html>', r, []));
  await settle();
  assert.equal(metrics.snapshot().counters['rust.crawl.error'], 1);
});

test('funil do crawler: onPageContent do adaptador alimenta captura e shadow', async () => {
  useCore(() => rustPage({ title: 'Matrix', year: 1999 }));
  const site = {
    id: 'bludv-cardigann',
    label: 'BLUDV',
    discover: async () => ({ urls: [], complete: true, failures: [] }),
    fetchWork: async (url: string, opts?: { onPageContent?: (c: string, l?: readonly unknown[]) => void }) => {
      opts?.onPageContent?.('<html><h1>Matrix (1999)</h1></html>', []);
      return { url, status: 'no-torrent' as const, imdb: null, title: 'Matrix', year: 1999, type: 'movie' as const };
    },
  };
  const row = {
    site: 'bludv-cardigann', url: 'https://bludv.test/filmes/matrix/', lastmod: '2026-01-01',
    kind: 'movie' as const, status: 'pending' as const, imdb: null, tries: 0, nextAt: 0,
    checkedAt: 0, releases: 0, error: '', progress: '', addedAt: 0,
  };
  const outcome = await createPageProcessor()(site as never, row as never, { noPersist: true });
  assert.equal(outcome.kind, 'no-torrent');
  await settle();

  assert.deepEqual(
    fs.readdirSync(path.join(tmp, 'bludv-cardigann')).sort(),
    ['_filmes_matrix.html', '_filmes_matrix.meta.json'],
  );
  assert.equal(metrics.snapshot().counters['rust.crawl.pages'], 1, 'shadow ligado pelo funil');
});
