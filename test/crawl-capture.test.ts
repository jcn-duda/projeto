// Captura de fixtures do raspador (`crawl-capture.ts` + `crawl-page.ts`).
//
// Cobre o scrub (token de protetor, cookie, btih/href preservados), a captura
// (HTML/JSON, opt-in, teto de bytes, confinamento) e o funil REAL do crawler:
// o tap `onPageContent` do adaptador alimenta a captura.
import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CACHE_PERSIST = 'false';

const config = (await import('../src/config.js')).default;
const { captureCrawlPage, scrubCrawlPage } = await import('../src/utils/crawl-capture.js');
const { createPageProcessor } = await import('../src/providers/crawl-page.js');

const savedCaptureDir = config.crawl.captureDir;
const savedMaxBytes = config.crawl.captureMaxBytes;

/** Espera o `setImmediate` da captura (roda em background). */
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adom-capture-'));
  config.crawl.captureDir = tmp;
  config.crawl.captureMaxBytes = savedMaxBytes;
});

afterEach(() => {
  // Limpa o tmp DESTE teste (o `after` só veria o último, vazando os demais).
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* tmp do SO */ }
});

after(() => {
  config.crawl.captureDir = savedCaptureDir;
  config.crawl.captureMaxBytes = savedMaxBytes;
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

test('funil do crawler: onPageContent do adaptador alimenta a captura', async () => {
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
});
