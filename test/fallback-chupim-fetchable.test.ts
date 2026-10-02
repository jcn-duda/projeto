// Reserva do banco ELEGÍVEL ao Chupim (2026-10-01). O dublado dos sites que só o
// raspador/colhedor leem chega à lista só como reserva 📦 (o índice guarda 2.000
// obras contra ~27 mil raspadas), e reserva nunca virava candidato: com "só
// cache" o "Show Bar - Versão Estendida [1080p DUAL]" (tt0200550) ficava
// invisível para sempre, com o aviso prometendo "reabra em alguns minutos".
// Elegível = linha já aprovada no filtro vivo, ou fonte index-only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import debrid from '../src/debrid/index.js';
import * as autofetch from '../src/providers/autofetch.js';
import * as cache from '../src/utils/cache.js';
import * as runtime from '../src/runtime.js';
import { applyDebrid } from '../src/providers/index.js';
import { toRawItem } from '../src/providers/magnet-bank-fallback.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { applyNoticeOrigin } from '../src/providers/stream-builder.js';
import { brDubbedPool, fallbackBlocked } from '../src/utils/autofetch-pools.js';
import type { Stream, DebridAdapter } from '../types/domain.js';

const hex = (c: string) => c.repeat(40);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => cache.clear());

const candidate = (indexer: string, passedFilter: number) => ({
  magnet: { hash: hex('a'), uri: `magnet:?xt=urn:btih:${hex('a')}`, title: 'Show Bar - Versão Estendida [1080p DUAL]', size: 0, seedersLast: 1, dubbed: true, quality: '1080p', isBr: true },
  source: { indexer, tracker: '' },
  work: { passedFilter },
}) as any;

test('elegível: aprovada no filtro vivo OU fonte index-only; o resto segue bloqueado', () => {
  assert.equal(toRawItem(candidate('kickasstorrents-to', 1)).fallbackFetchable, true, 'passed_filter=1');
  assert.equal(toRawItem(candidate('hdrtorrent-cardigann', 0)).fallbackFetchable, true, 'index-only');
  assert.equal(toRawItem(candidate('kickasstorrents-to', 0)).fallbackFetchable, undefined, 'palpite nunca aprovado');
});

test('a marca atravessa o stream, entra no pool BR e sai antes do protocolo', () => {
  const ok = toStremioStream({ ...toRawItem(candidate('hdrtorrent-cardigann', 0)), seeders: 1 }) as any;
  const blocked = toStremioStream({ ...toRawItem(candidate('kickasstorrents-to', 0)), infoHash: hex('b'), seeders: 1 }) as any;
  assert.equal(ok._fallbackFetchable, true);
  assert.equal(fallbackBlocked(ok), false);
  assert.equal(fallbackBlocked(blocked), true);
  assert.deepEqual(brDubbedPool([ok, blocked]).map((s: any) => s.infoHash), [hex('a')]);
  assert.equal('_fallbackFetchable' in applyNoticeOrigin([ok])[0], false, 'marca interna não vai ao protocolo');
});

test('reserva elegível vira candidato do Chupim no applyDebrid', async () => {
  const h = hex('c');
  const adapter = debrid.BY_ID.get('premiumize') as DebridAdapter;
  const originalCheck = debrid.checkCached;
  const originalEnqueue = adapter.enqueue;
  const enqueued: string[] = [];
  const searchKey = 'busca-fb-elegivel';
  const stream = { infoHash: h, name: 'Show Bar 1080p', title: 'Show Bar - Versão Estendida [1080p DUAL]', _br: true, _dubClaim: true, _quality: '1080p', _seeders: 1, _fromFallback: true, _fallbackFetchable: true } as unknown as Stream;
  try {
    adapter.enqueue = async (_apiKey, infoHash) => { enqueued.push(infoHash); return true; };
    debrid.checkCached = async () => ({ cached: new Set(), known: true });
    const userOpts = { ...runtime.defaults(), debridService: 'premiumize', debridApiKey: 'chave-fb-el', debridCachedOnly: true, autoFetchBr: true };
    await runtime.run({ opts: userOpts, encoded: 'cfg-fb-el' }, () => applyDebrid([stream], { searchKey } as any));
    await sleep(30);
    assert.deepEqual(enqueued, [h], 'o dublado raspado é baixado para a próxima abertura');
  } finally {
    debrid.checkCached = originalCheck;
    adapter.enqueue = originalEnqueue;
    autofetch.releaseSearch(searchKey);
  }
});

// Rótulo `is_br` antigo do banco (só sobe, sem versão): o DUB russo do
// rutracker saía como BR no instantâneo. Idioma estrangeiro sem NENHUM sinal
// PT desmente; título brasileiro com acento/rótulo PT continua BR.
const legacy = (title: string) => ({ ...candidate('kickasstorrents-to', 1), magnet: { ...candidate('x', 1).magnet, title, isBr: true } });

test('is_br antigo cede ao idioma estrangeiro, nunca ao título brasileiro', () => {
  for (const t of [
    'Coyote Ugly [2000, USA, drama, melodrama, comedy, music, HDRip] Dub',
    'Gen V s01e01 (2023) [Uzbekistan Dubbed] 1080p WEB DLRip TeeWee',
    'Inside.Out.2.2024.1080p.WEB-DL.ENG.LATINO.DDP5.1.Atmos.H264-BEN.THE.MEN',
  ]) assert.equal(toRawItem(legacy(t)).isBr, false, t);
  for (const t of [
    'A Casa dos Espíritos (2026) S01E04 [1080p DUAL]',
    'Vírus (2009) [1080p WEB-DL DUAL 3.9 GB]',
    'The Spanish Princess 1ª Temporada (2019) WEB-DL | – E05 [WEB-DL LEGENDADO]',
    'Lat Mat: 48H (2021) / WEB-DL [1080p WEB-DL LEGENDADO 2.15 GB]',
  ]) assert.equal(toRawItem(legacy(t)).isBr, true, t);
});
