// Série cujo site repete o MESMO bloco de packs em todo card (The Walking
// Dead no Vaca, medido 2026-09-28: as 11 páginas de temporada traziam os 10
// packs das batches, com a URL do protetor cifrada por página — 0/10 iguais).
// Sem dedupe entre cards e entre passadas, a série gastava 1.087 requisições e
// 4 passadas para 10 magnets únicos, e o contador da linha somava 36. Aqui o
// adaptador roda com uma superfície dublê (sem rede) sobre as fixtures reais
// da página da série e do season-internal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSeriesWork, packSignature } from '../src/providers/crawl-sites/vaca-series.js';
import type { VacaSeriesContext } from '../src/providers/crawl-sites/vaca-series.js';
import { parseProgress, renderProgress, progressAdvanced } from '../src/utils/crawl-store-rules.js';
import type { ResolverLink } from '../resolvers/types.js';
import type { SeriesWorkProgress } from '../src/providers/crawl-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'crawl', 'vaca');
const SHOW_HTML = fs.readFileSync(path.join(FIX, 'tv-show-page.html'), 'utf8');
const INTERNAL_HTML = fs.readFileSync(path.join(FIX, 'season-internal-mixed.html'), 'utf8');
const SHOW = 'https://vaqueirofilmes.com/pt/tv-shows/outer-banks/';

const hashFor = (size: string) => size.replace(/\D/g, '').padEnd(40, 'a').slice(0, 40);

/** Superfície dublê: TODO card devolve o mesmo bloco de botões, cada um com
 * URL de protetor única por card (como o `systemtech` cifrado). */
function fakeCtx(block: Array<Pick<ResolverLink, 'quality' | 'audio' | 'size' | 'episode'>>) {
  const state = { follows: 0, requests: 0 };
  const surface = {
    async fetchTextDirect(url: string) {
      state.requests += 1;
      if (url.includes('season-internal')) return INTERNAL_HTML;
      if (url.includes('/tv-shows/')) return SHOW_HTML;
      return `<html>card ${url}</html>`;
    },
    parseDownloadLinks(_html: string, cardUrl: string) {
      return block.map((b, i) => ({ ...b, source: null, url: `https://systemtech.space/enc/go.php?id=${encodeURIComponent(cardUrl)}-${i}` }));
    },
    async fetchFollowingAllowed(linkUrl: string) {
      state.follows += 1;
      const i = Number(linkUrl.split('-').pop());
      const b = block[i];
      return `magnet:?xt=urn:btih:${hashFor(`${b.size}${b.episode ?? ''}`)}`;
    },
    extractMagnet: (html: string) => html,
    assertAllowedUrl: () => undefined,
  };
  const ctx = {
    surface,
    assertSiteUrl: (value: string) => new URL(value),
    parseTitleYear: () => ({ title: 'Outer Banks', year: 2020 }),
    parseImdbId: () => 'tt10293938',
    magnetHash: (magnet: string) => (magnet.match(/btih:([a-z0-9]{40})/i) || [])[1] || null,
    releaseToRawItem: (_obra: unknown, link: ResolverLink, magnet: string) => ({
      title: `Outer Banks S05 [${link.quality}p ${link.size}]`, magnet, seeders: 1, indexer: 'vacatorrent', isBr: true,
    }),
    countRequest: () => { state.requests += 1; },
    requestCost: () => state.requests,
  } as unknown as VacaSeriesContext;
  return { ctx, state };
}

const PACKS = [
  { quality: 720, audio: 'dublado', size: '5.14 GB', episode: null },
  { quality: 720, audio: 'dual', size: '6.08 GB', episode: null },
] as Array<Pick<ResolverLink, 'quality' | 'audio' | 'size' | 'episode'>>;

const releasesOf = (r: { groups?: Array<{ releases: unknown[] }> }) =>
  (r.groups || []).reduce((n, g) => n + g.releases.length, 0);

test('mesma passada: o bloco repetido em 4 cards é resolvido UMA vez', async () => {
  const { ctx, state } = fakeCtx(PACKS);
  const r = await fetchSeriesWork(ctx, SHOW, { enabled: true, maxCards: 10, maxButtons: 40 });
  assert.equal(state.follows, 2, 'só o primeiro card segue o protetor');
  assert.equal(releasesOf(r), 2);
});

test('entre passadas: a retomada não re-resolve nem reemite o que já saiu', async () => {
  const { ctx, state } = fakeCtx(PACKS);
  const limits = { enabled: true, maxCards: 1, maxButtons: 40 };
  let resume: SeriesWorkProgress | null = null;
  let emitted = 0;
  for (let pass = 0; pass < 6; pass += 1) {
    const r = await fetchSeriesWork(ctx, SHOW, limits, resume);
    emitted += releasesOf(r);
    // O motor persiste o progresso pela forma canônica: o `seen` precisa
    // sobreviver ao render/parse da coluna.
    resume = parseProgress(renderProgress(r.progress!));
    if (r.status !== 'partial') break;
  }
  assert.equal(state.follows, 2, 'protetor seguido só na 1ª passada');
  assert.equal(emitted, 2, 'o contador da linha soma os únicos, não 2 por card');
});

test('botão de EPISÓDIO não usa assinatura: mesmo tamanho em cards diferentes é seguido', async () => {
  const { ctx, state } = fakeCtx([{ quality: 1080, audio: 'dublado', size: '1.2 GB', episode: 1 }]);
  await fetchSeriesWork(ctx, SHOW, { enabled: true, maxCards: 10, maxButtons: 40 });
  assert.equal(state.follows, 4, 'S01E01 e S02E01 podem ter o mesmo tamanho arredondado');
});

test('assinatura só existe para pack com tamanho real', () => {
  assert.equal(packSignature({ quality: 720, audio: 'dual', size: '6.08 GB', episode: null }), 's:720|dual|6.08gb');
  assert.equal(packSignature({ quality: 720, audio: 'dual', size: '6,08 GB', episode: null }), 's:720|dual|6.08gb');
  assert.equal(packSignature({ quality: 720, audio: 'dual', size: '1 KB', episode: null }), null, 'sentinela do resolver');
  assert.equal(packSignature({ quality: 720, audio: 'dual', size: null, episode: null }), null);
  assert.equal(packSignature({ quality: 720, audio: 'dual', size: '6.08 GB', episode: 3 }), null);
});

test('progresso: `seen` sobrevive ao render e NÃO conta como avanço', () => {
  const base: SeriesWorkProgress = { v: 1, doneCards: ['a'], totalCards: 3 };
  const withSeen = { ...base, seen: ['h:abc', 's:720|dual|6.08gb'] };
  assert.deepEqual(parseProgress(renderProgress(withSeen))?.seen, withSeen.seen);
  assert.equal(parseProgress(renderProgress(base))?.seen, undefined);
  assert.equal(progressAdvanced(renderProgress(base), withSeen), false, 'só dedupe mudou: estagnação continua visível');
  assert.equal(progressAdvanced(renderProgress(base), { ...withSeen, doneCards: ['a', 'b'] }), true);
});
