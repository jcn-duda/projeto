// Bug 2026-09-27 v2: entidades DESTRUÍDAS no dn ("4ordf" = "4&ordf;" sem o
// "&"), card "temporada-1" que lista botões S1..S9 sem impor a season do
// card, título de batch normalizado para o matching, alinhamento da busca ao
// vivo (`fetchSeriesLinks`) com o crawl, e veto de identidade por adaptação
// (One Piece live action 2023/2026 NÃO é o anime tt0388629; anime packs
// S01-S15 continuam passando). Sem rede.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CACHE_PERSIST = 'false';

const { declaredSeriesLocation, seasonFromCardSlug, groupSeriesReleases } =
  await import('../src/providers/crawl-sites/vaca-series-locate.js');
const { extractBatchTitle } = await import('../resolvers/profiles/vacatorrent-parsers.js');
const { createVacaContent } = await import('../resolvers/profiles/vacatorrent-content.js');
const { parseDownloadLinks } = await import('../resolvers/profiles/vacatorrent-parsers.js');
const { filterRelevantRaw } = await import('../src/utils/release-filters.js');
const { releaseWorkTargets } = await import('../src/utils/release-work.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'crawl', 'vaca', n), 'utf8');

const base = { cardSeason: null, cardTitle: '', isBatch: false, realTitle: null, dn: null, linkEpisode: null };

describe('entidades DESTRUÍDAS (sem "&") na evidência', () => {
  test('dn "4ordf" declara a 4ª temporada (dn real do TWD, medido em produção)', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'The.Walking.Dead.4ordf.Temporada.Completa.1080p.DUAL', linkEpisode: 7 }),
      { season: 4, episode: null }, 'pack da 4ª: sem episódio herdado do bloco',
    );
  });

  test('resíduo numérico "4#170;" e ordinal "º" também decodificam', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'Show.4#170;.Temporada.Completa.1080p' }),
      { season: 4, episode: null },
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'Show.3ordm.Temporada.Completa.1080p' }),
      { season: 3, episode: null },
    );
  });

  test('falso positivo é barrado: "Accordf" e "m4ordfx" não viram ordinal', () => {
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'Accordf.1080p' }),
      { season: null, episode: null },
    );
    assert.deepEqual(
      declaredSeriesLocation({ ...base, dn: 'm4ordfx.1080p' }),
      { season: null, episode: null },
    );
  });

  test('CARD não impõe a season dele quando o rótulo do botão declara outra', () => {
    // Página "temporada-1" do TWD lista cards S1..S9: a âncora "4ordf
    // Temporada" é a evidência certa — NUNCA a S1 do slug/página.
    assert.deepEqual(
      declaredSeriesLocation({
        ...base, cardSeason: 1,
        cardTitle: 'The Walking Dead 4ordf Temporada',
        dn: 'The.Walking.Dead.4ordf.Temporada.Completa.1080p',
      }),
      { season: 4, episode: null },
    );
    // Rótulo legível com dn silencioso também vence o card (regra 2 nova).
    assert.deepEqual(
      declaredSeriesLocation({ ...base, cardSeason: 1, cardTitle: 'The Walking Dead 2ª Temporada' }),
      { season: 2, episode: null },
    );
    // Rótulo silencioso mantém a regressão do slug (regra 3).
    assert.deepEqual(
      declaredSeriesLocation({ ...base, cardSeason: 1, cardTitle: 'The Walking Dead' }),
      { season: 1, episode: null },
    );
  });

  test('seasonFromCardSlug lê ordinal destruído no slug ("4ordf-temporada")', () => {
    assert.equal(seasonFromCardSlug('https://x/tv/twd/season/4ordf-temporada/'), 4);
  });
});

describe('título de batch normalizado para o matching (sem relaxar o filtro)', () => {
  test('extractBatchTitle tira o rótulo "BATCH –" e repara entidades destruídas', () => {
    const html = '<div class="bl-hero-title">BATCH – The Walking Dead 4ordf Temporada Completa</div>';
    assert.equal(extractBatchTitle(html), 'The Walking Dead 4ª Temporada Completa');
  });

  test('título normalizado passa no matchesBrTitle/regras do filtro de série', () => {
    const title = 'The Walking Dead 4ª Temporada Completa DUAL 1080p';
    assert.equal(
      filterRelevantRaw(
        [{ title, magnet: `magnet:?xt=urn:btih:${'ab'.repeat(20)}`, indexer: 'vacatorrent', isBr: true, seeders: 1 }],
        { names: ['The Walking Dead'], year: 2010, isSeries: true, season: 4, episode: 5 },
      ).length, 1, 'pack da temporada atende o episódio pedido',
    );
  });
});

describe('busca ao vivo alinhada ao crawl (fetchSeriesLinks)', () => {
  const SITE = 'https://vaqueirofilmes.com';
  const cardHtml = '<html><body><div class="ss-ep-wrap">'
    + '<div class="ss-ep-num">07</div>'
    + '<a href="https://systemtech.space/enc/go.php?id=x1" class="ss-ep-btn ss-ep-btn-dl">COMPLETE | 1080p</a>'
    + '</div></body></html>';

  function contentWithCard(cardTitle: string) {
    const internalHtml = `<html><body><div class="sa-grid">`
      + `<a href="${SITE}/batch/the-walking-dead-4/" class="sa-card-title">${cardTitle}</a>`
      + `</div></body></html>`;
    const calls: Array<Record<string, unknown>> = [];
    const fetchText = async (url: string) => {
      calls.push({ url });
      if (url.includes('season-internal')) return internalHtml;
      if (url.includes('the-walking-dead-4')) return cardHtml;
      if (url.includes('tv-shows/the-walking-dead')) {
        // Página da série: o data-u aponta o season-internal (mesma forma real).
        const internal = Buffer.from(`${SITE}/pt/season-internal/?show=99`).toString('base64');
        return `<html><body><h1>The Walking Dead (2010)</h1><div data-u="${internal}"></div></body></html>`;
      }
      throw new Error(`fora do mapa: ${url}`);
    };
    const content = createVacaContent({
      // Cast concentrado: a assinatura real é genérica (`cached<R>`); o dublê
      // só executa o loader (sem cache).
      cachedPost: ((_key: string, _ms: number, loader: () => unknown) => Promise.resolve(loader())) as never,
      postCacheMs: 1000,
      fetchText,
      parseDownloadLinks,
    });
    return { content, calls };
  }

  test('card da página "temporada-1" com rótulo "4ordf": link sai S4 SEM E07', async () => {
    const { content } = contentWithCard('The Walking Dead 4ordf Temporada');
    const post = { url: `${SITE}/pt/tv-shows/the-walking-dead/`, title: 'The Walking Dead', type: 'Série' as const, year: 2010, poster: null };
    const links = await content.fetchSeriesLinks(post, null) as unknown as Array<{ season: number | null; episode: number | null }>;
    assert.equal(links.length, 1);
    assert.deepEqual({ season: links[0].season, episode: links[0].episode }, { season: 4, episode: null },
      'mesma locação do crawl: pack S4, NUNCA E07 fictício nem S1 herdado');
  });
});

describe('veto de identidade por adaptação (One Piece anime × live action)', () => {
  const animeCtx = { names: ['One Piece'], year: 1999, isSeries: true, season: 5, episode: 3 };
  const item = (title: string, dn: string) => ({
    title, magnet: `magnet:?xt=urn:btih:${'cd'.repeat(20)}&dn=${encodeURIComponent(dn)}`,
    indexer: 'vacatorrent', isBr: true, seeders: 1,
  });

  test('live action 2023/2026 sob o anime (1999) é rejeitado com motivo identity', () => {
    const reasons: string[] = [];
    const kept = filterRelevantRaw([
      item('One Piece (2023) Temporada 1 Completa Dublado', 'One.Piece.Live.Action.2023.S01.1080p.DUAL'),
      item('One Piece (2026) 2ª Temporada Dublado', 'One.Piece.Live.Action.2026.S02.1080p'),
    ], animeCtx, (item, reason) => { reasons.push(reason); });
    assert.equal(kept.length, 0, 'NENHUM live action entra na lista do anime');
    assert.deepEqual(reasons, ['identity', 'identity'], 'o motivo é identidade, não título/episódio');
  });

  test('anime packs S01-S15 (faixa de anos cobrindo a estreia) PASSAM', () => {
    const kept = filterRelevantRaw([
      item('One Piece 1ª a 15ª Temporadas Completa (1999-2023) Dublado', 'One.Piece.S01-S15.Completa.1080p'),
    ], animeCtx);
    assert.equal(kept.length, 1, 'pack legítimo do anime não é tocado');
  });

  test('a MESMA release live action serve a obra certa (estreia 2023)', () => {
    const reasons: string[] = [];
    const kept = filterRelevantRaw([
      // O rótulo "Live Action" vai no dn (o título do post nomeia a obra):
      // título casa o filtro, o VETO só dispara pelo texto completo — e a
      // estreia 2023 está a ±2 do ano declarado → release legítima.
      item('One Piece (2023) Temporada 1 Completa Dublado', 'One.Piece.Live.Action.2023.S01.1080p.DUAL'),
    ], { ...animeCtx, year: 2023, season: 1 }, (item, reason) => { reasons.push(reason); });
    assert.equal(kept.length, 1, 'na obra do live action a release é legítima');
    assert.deepEqual(reasons, []);
  });

  test('releaseWorkTargets com ano: contaminado vira [] (nada gravado); sem ano, régua normal', () => {
    assert.deepEqual(
      releaseWorkTargets('One Piece Live Action (2023) Completa', { season: 5, episode: null }, 'One.Piece.Live.Action.2023.1080p', { year: 1999 }),
      [], 'excluir — nunca remanejar para outro imdb',
    );
    assert.ok(
      releaseWorkTargets('One Piece Live Action (2023) Completa', { season: 5, episode: null }, 'One.Piece.Live.Action.2023.1080p').length > 0,
      'sem ano de estreia o veto fica desligado (fail-open conservador)',
    );
  });

  test('groupSeriesReleases com ano da obra: live action não gera grupo no anime', () => {
    const groups = groupSeriesReleases(
      [{
        release: item('One Piece Live Action (2023) Temporada 1 Completa', 'One.Piece.Live.Action.2023.S01.1080p'),
        request: { season: 1, episode: null },
      }],
      { year: 1999 },
    );
    assert.equal(groups.length, 0, 'contaminação sai SEM grupo (excluir, não mover)');
  });

  test('groupSeriesReleases sem ano mantém o comportamento anterior', () => {
    const groups = groupSeriesReleases(
      [{
        release: item('One Piece Live Action (2023) Temporada 1 Completa', 'One.Piece.Live.Action.2023.S01.1080p'),
        request: { season: 1, episode: null },
      }],
    );
    assert.deepEqual(groups.map((g) => g.season), [1]);
  });
});
