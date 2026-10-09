// Reserva do banco com ÁUDIO GRAVADO (2026-10-08). O classificador da captura
// marca `dubbed` mesmo quando o título do post não cita áudio — "Locke & Key
// 1ª e 2ª Temporada (2021) S01 [720p]" (tt3007572, apachetorrent) chegava ao
// Chupim com `_dubClaim:false` (o claim nasce só do TÍTULO) e o pool BR do
// autofetch ficava vazio: o pack dublado que o banco JÁ conhece nunca era
// baixado e a sonda br-probe girava à toa. `_bankDub` carrega a evidência do
// banco até os pools com as guardas do claim (lie, prova vazia, dn= de cena
// EN, origem da conta); chip e `_dubbed` (prova de arquivo) não mudam.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as cache from '../src/utils/cache.js';
import { toRawItem } from '../src/providers/magnet-bank-fallback.js';
import { toStremioStream } from '../src/utils/search-names.js';
import { applyNoticeOrigin } from '../src/providers/stream-builder.js';
import { brDubbedPool } from '../src/utils/autofetch-pools.js';
import { uncachedBrHashes } from '../src/utils/autofetch-picks.js';

after(() => cache.clear());

const hex = (c: string) => c.repeat(40);

// Linha real do magnets.db (hash 0546becadff2): dubbed=1 do classificador,
// título SEM marca de áudio, apachetorrent (fonte do acervo raspado).
const bank = (over: Record<string, unknown> = {}) => ({
  magnet: {
    hash: hex('a'),
    uri: `magnet:?xt=urn:btih:${hex('a')}`,
    title: 'Locke & Key 1ª e 2ª Temporada (2021) S01 [720p]',
    size: 0,
    seedersLast: 1,
    dubbed: true,
    quality: '720p',
    isBr: true,
    ...over,
  },
  source: { indexer: 'apachetorrent', tracker: '' },
  work: { passedFilter: 1 },
}) as any;

test('áudio gravado no banco vira _bankDub e o pack dublado entra no pool BR', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1 }) as any;
  assert.equal(s._br, true);
  assert.equal(s._dubClaim, false, 'o título não cita áudio: claim do post não nasce');
  assert.equal(s._dubbed, false, 'não é prova de arquivo');
  assert.equal(s._bankDub, true, 'a evidência do classificador atravessa o build');
  assert.deepEqual(
    brDubbedPool([s], { season: 1 }).map((x: any) => x.infoHash),
    [hex('a')],
    'o Chupim pode baixar o pack que o banco sabe ser dublado',
  );
});

test('sem áudio gravado, o pack sem marca no título continua fora', () => {
  const s = toStremioStream({ ...toRawItem(bank({ dubbed: false })), seeders: 1 }) as any;
  assert.equal(s._bankDub, undefined);
  assert.equal(brDubbedPool([s]).length, 0);
});

test('título com marca de áudio segue pelo caminho antigo (_dubClaim), sem _bankDub', () => {
  const s = toStremioStream({
    ...toRawItem(bank({ title: 'Locke & Key 1ª e 2ª Temporada (2021) [720p WEB-DL DUBLADO]' })),
    seeders: 1,
  }) as any;
  assert.equal(s._dubClaim, true);
  assert.equal(s._bankDub, undefined, 'claim do título já basta: a marca é para o que só o banco sabe');
  assert.equal(brDubbedPool([s]).length, 1);
});

test('guardas do claim: lie, prova vazia e dn= de cena EN anulam _bankDub', () => {
  const lied = toStremioStream({ ...toRawItem(bank()), seeders: 1, lied: true }) as any;
  assert.equal(lied._bankDub, undefined);
  assert.equal(brDubbedPool([lied]).length, 0);

  const proven = toStremioStream({ ...toRawItem(bank()), seeders: 1, provenAudio: '' }) as any;
  assert.equal(proven._bankDub, undefined, 'prova vazia de áudio é EN');

  const dnEn = toStremioStream({
    ...toRawItem(bank({ uri: `magnet:?xt=urn:btih:${hex('a')}&dn=Locke.and.Key.S01E01.HDTV.x264-KILLERS[ettv]` })),
    seeders: 1,
  }) as any;
  assert.equal(dnEn._bankDub, undefined, 'dn= de cena EN contradiz a promessa');
});

test('origem da conta nunca prova áudio (Zumbilândia): brOriginOnly anula', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1, brOriginOnly: true }) as any;
  assert.equal(s._bankDub, undefined);
});

test('reserva não elegível segue bloqueada e item fora do fallback não ganha a marca', () => {
  const blocked = toStremioStream(
    toRawItem({ ...bank(), source: { indexer: 'kickasstorrents-to', tracker: '' }, work: { passedFilter: 0 } }),
  ) as any;
  assert.equal(blocked._fallbackFetchable, undefined);
  assert.equal(brDubbedPool([blocked]).length, 0);

  // Item cru de indexer (não é reserva): a marca é exclusiva do fallback para
  // não ampliar o raio da evidência gravada.
  const raw = toStremioStream({
    title: 'Locke & Key 1ª e 2ª Temporada (2021) S01 [720p]',
    infoHash: hex('b'),
    seeders: 1,
    indexer: 'apachetorrent',
    isBr: true,
    dubbed: true,
  } as any) as any;
  assert.equal(raw._bankDub, undefined);
});

test('vaga P2P do showUncachedBr: a reserva com áudio gravado lista na 1ª abertura (d:1+bu)', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1 }) as any;
  assert.ok(uncachedBrHashes([s], new Set(), 1).has(hex('a')));
});

test('_bankDub sai antes do protocolo, como as outras marcas internas do fallback', () => {
  const s = toStremioStream({ ...toRawItem(bank()), seeders: 1 }) as any;
  assert.equal('_bankDub' in applyNoticeOrigin([s])[0], false);
});
