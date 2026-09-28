// MODO AMOSTRA de temporada do NerdFilmes (Fase 8) contra o fixture REAL de
// página de temporada (`post-series.html`, /lanternas-1a-temporada-2026/ — 14
// botões, um por episódio/qualidade). Suíte separada da de `crawl-nerdfilmes`
// porque mede um PORTÃO: enquanto a amostra não separa pack de temporada de
// episódio, abrir a season page no motor é 14 magnets gravados como filme.
//
// O que cada teste fixa:
//   os 14 botões e o que saiu deles  `buttons`/`buttonsFollowed` são o
//                                   denominador honesto da sonda (o que a
//                                   página anunciava × o que o transporte
//                                   seguiu), e o release sai com `E01` no
//                                   título — a EVIDÊNCIA de que este site
//                                   publica POR EPISÓDIO;
//   sem `groups`                    afirmar `season/episode` antes disso seria
//                                   o chute que o portão existe para evitar;
//   teto de botões                  a régua é a página de 14 botões; um outlier
//                                   não vira 200 requests no teto por hora;
//   independência de series.enabled  o estado real do motor hoje é `false` e a
//                                   amostra precisa medir assim mesmo;
//   flag por chamada                a sonda só tem a interface `CrawlSite`, e
//                                   a leitura é por `=== true` (string mentirosa
//                                   NÃO abre).
//
// Os dublês moram em `helpers/crawl-nerdfilmes-fixtures.ts` — uma definição só
// para as duas suítes. Sem rede, sem banco de magnets, sem crawler ligado.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { CrawlPageOptions } from '../src/providers/crawl-types.js';
import type { NerdfilmesSeasonSample } from '../src/providers/crawl-sites/nerdfilmes.js';
import {
  SERIES,
  fixture,
  pageRoutes,
  pathsOf,
  probeSite,
  site,
  withStub,
} from './helpers/crawl-nerdfilmes-fixtures.js';

describe('crawl-sites/nerdfilmes: modo amostra de temporada (seriesProbe)', () => {
  test('lê a página de temporada, reporta os 14 botões e o que saiu deles', () => withStub(
    // Os 14 botões da página real ("Ep 01"…"Ep 07" em duas qualidades) batem
    // todos no MESMO gate capturado, então o dedupe por hash devolve 1 release
    // — e a CONTAGEM de botões/magnets é o que a amostra precisa medir.
    pageRoutes({ [SERIES]: () => fixture('post-series.html') }), async (stub) => {
      const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'series', 'a página é lida como série, não como filme');
      assert.equal(result.title, 'Lanternas 1ª Temporada');
      assert.equal(result.year, 2026);
      assert.equal(result.imdb, null, 'o site não publica IMDb: identificação é por título+ano');
      assert.equal(result.releases?.length, 1, 'mesmo hash nos 14 botões = 1 release');
      assert.equal(result.requestCost, 15, 'página + 14 saltos de gate, medido por hop');
      // O denominador honesto da sonda: quantos botões a página anunciava e
      // quantos o transporte chegou a seguir.
      const sample = result as NerdfilmesSeasonSample;
      assert.equal(sample.buttons, 14, 'os 14 botões reais da página');
      assert.equal(sample.buttonsFollowed, 14);
      // EVIDÊNCIA do portão: o botão de episódio do site não publica tamanho
      // ("1080p | Ep 01 | Dual Áudio") e o título sai marcado com E01 — é isso
      // que diz que o site publica POR EPISÓDIO, não pack de temporada.
      assert.equal(result.releases?.[0].title, 'Lanternas 1ª Temporada E01 [1080p DUBLADO]');
      assert.equal(result.releases?.[0].size, undefined, 'sem tamanho: o site não publica neste botão');
      assert.equal(result.releases?.[0].isBr, true);
      assert.deepEqual(pathsOf(stub), ['/lanternas-1a-temporada-2026/', ...Array(14).fill('/link.php')]);
    }));

  test('sem `groups`: a amostra não afirma a locação de cada botão', () => withStub(
    pageRoutes({ [SERIES]: () => fixture('post-series.html') }),
    async () => {
      // Afirmar `season: 1, episode: null` antes de a amostra distinguir pack de
      // temporada de avulso seria a CHUTE que o portão existe para evitar.
      const result = await probeSite().fetchWork(SERIES, { kind: 'tv_show' });
      assert.equal(result.groups, undefined, 'locação por botão continua sem prova');
    },
  ));

  test('o teto de botões da série vale na amostra (o outlier não vira 200 requests)', () => withStub(
    pageRoutes({ [SERIES]: () => fixture('post-series.html') }),
    async (stub) => {
      const result = await probeSite().fetchWork(SERIES, {
        kind: 'tv_show', series: { enabled: false, maxCards: 10, maxButtons: 3 },
      });
      const sample = result as NerdfilmesSeasonSample;
      assert.equal(sample.buttons, 14, 'o que a página anunciava continua visível');
      assert.equal(sample.buttonsFollowed, 3, 'só 3 botões foram seguidos');
      assert.equal(result.requestCost, 4, 'página + 3 gates');
      assert.equal(stub.calls.length, 4);
    },
  ));

  test('a amostra NÃO depende de `series.enabled` (é a rota da sonda)', () => withStub(
    pageRoutes({ [SERIES]: () => fixture('post-series.html') }),
    async () => {
      // `series.enabled: false` é o estado real do motor hoje: a amostra tem de
      // medir assim mesmo, sem ninguém ligar séries na config.
      const result = await probeSite().fetchWork(SERIES, {
        kind: 'tv_show', series: { enabled: false, maxCards: 1, maxButtons: 40 },
      });
      assert.equal(result.status, 'done');
      assert.equal(result.requestCost, 15);
    },
  ));

  test('a flag por chamada também abre a porta (quem só tem a interface CrawlSite)', () => withStub(
    pageRoutes({ [SERIES]: () => fixture('post-series.html') }),
    async () => {
      // Entrada alternativa para a sonda: o `CrawlPageOptions` compartilhado
      // não tem o campo, então o teste monta o objeto com o tipo do contrato
      // mais o extra — é o mesmo caminho que `probeRequested` lê.
      const opts = { kind: 'tv_show', seriesProbe: true } as unknown as CrawlPageOptions;
      const result = await site().fetchWork(SERIES, opts);
      assert.equal(result.status, 'done');
      assert.equal(result.type, 'series');
      assert.equal(result.requestCost, 15);
      // E a flag mentirosa (string) NÃO abre: a leitura é por `=== true`.
      const falso = await site().fetchWork(SERIES, { kind: 'tv_show', seriesProbe: 'true' } as unknown as CrawlPageOptions);
      assert.equal(falso.status, 'error');
    },
  ));
});
