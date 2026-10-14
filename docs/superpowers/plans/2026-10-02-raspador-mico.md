# Raspador do Mico Leão Dublado — plano

Data: 2026-10-02. Estado: **Fase 0 concluída (portão PASSA); Fase 1 IMPLEMENTADA
(filmes); Fase 2 IMPLEMENTADA (séries)**.

## Por que (e por que com cuidado)

O Mico (`src/providers/mico.ts`, card virtual `mico`) é um addon Stremio, não um
site: só é consultado na busca ao vivo, por IMDb, então o acervo dele só entra no
banco quando alguém abre aquele título. Um raspador o leria inteiro, como os
oito sites BR.

A medição ao vivo de 2026-10-02 (Fase 0) confirmou valor suficiente e API
estável — o portão PASSOU:

| Medida (Fase 0, API ao vivo) | Valor |
|---|---|
| Filmes únicos no catálogo `MicoFilmes` (paginação simples) | 3.265 em ~70 páginas (skip final ~3.475) |
| Séries no catálogo `MicoSeries` (paginação simples) | 1.773 em 45 páginas (teto atingido) |
| Amostra de filmes | 300 |
| Filmes da amostra com ≥ 1 stream | 39 (~13%) |
| Hashes desses 39 | 273 |
| Já no banco da VPS por outra fonte | 219 (80,2%) |
| Novos | 54 (19,8%) |
| Novos BR dublados | 29 |
| Latência da API | p50 60 ms / p95 540 ms |
| 429 / 5xx no ritmo de 1 s | 0× / 0× |

**Armadilha confirmada:** o filtro de gênero da API está QUEBRADO (o
`/manifest.json` declara 17 gêneros, mas `genre=<G>` devolve `metas: []` para
todos). A descoberta usa **paginação simples**, que cobre o catálogo inteiro.
Projeção: ~3.265 chamadas de filme para ~29 hashes BR dublados novos por
rodada de releitura. Por isso o plano começa barato (só filmes) e tem um
**portão de valor** antes das séries.

## O que o Mico oferece

- `GET /manifest.json` — catálogos `movie/MicoFilmes` e `series/MicoSeries`, com
  `extra` `search` e `genre`.
- `GET /catalog/<type>/<id>[/skip=N].json` — `metas` com o IMDb.
  **Armadilha medida (Fase 0):** o filtro de gênero está QUEBRADO —
  `genre=<G>&skip=N` devolve `metas: []` para TODOS os 17 gêneros declarados no
  manifest. A **paginação simples** (`skip=N`) cobre o catálogo inteiro: 3.265
  filmes únicos em ~70 páginas, 1.773 séries em 45 páginas (teto atingido). O
  tamanho de página é VARIÁVEL (14 a 97 metas), então o `skip` avança pelo
  número REAL de metas. NÃO use gêneros.
- `GET /stream/movie/<tt>.json` e `/stream/series/<tt>:<S>:<E>.json` — streams
  com `infoHash`, título do post e `sources` (trackers). Série é POR EPISÓDIO.

## Desenho

O Mico entra como **mais um site do motor** (`crawl-sites/mico.ts`), com o id do
card virtual `mico` — é o id que amarra o item raspado à reserva e ao `ji`.

1. **Registro.** Linha nova em `crawl-sites/registry.ts` (hoje tabela fechada
   dos 8 cards do Jackett; o comentário e o teste que exigem 8 mudam para 9). O
   site nasce DESLIGADO (catálogo do painel), como todo site fora do
   `CRAWL_SITES`.
2. **Descoberta (`discover`).** Percorre `MicoFilmes` por **PAGINAÇÃO SIMPLES**
   (`skip=N`, dedupe por IMDb) — o filtro de gênero está quebrado (Fase 0). O
   `skip` avança pelo número real de metas e a varredura termina na primeira
   página vazia (teto de 200 páginas). Cada obra vira uma URL sintética estável
   — `https://<host do Mico>/crawl/movie/<tt>/` — cujo `url_key` (caminho) é a
   identidade na fila. Como o catálogo não publica data, o `lastmod` é
   **SINTÉTICO**: `bucketLastmod` devolve a data do balde de releitura da obra
   (relida a cada `MICO_CRAWL_REREAD_DAYS` dias, ~1/14 do catálogo por dia,
   espalhado pelo hash do IMDb, com máximo monotônico para o cursor). Falha de
   UMA página é best-effort (`complete:false`, segue com passo nominal 40);
   falha TOTAL lança com `withRequestCost`. Catálogo vazio ou ilegível é FALHA,
   nunca "vazio e completo" (regra de todos os sites). **Fase 2 (IMPLEMENTADA):**
   com `opts.series.enabled` o `discover` pagina também o `MicoSeries` (skip
   dinâmico, dedupe, teto de 300 páginas) e emite `tv_show` com `lastmod` de 30
   dias; falha total de série não derruba a descoberta de filme.
3. **Leitura (`fetchWork`).**
   - Filme: uma chamada a `/stream/movie/<tt>.json`. Devolve `imdb` PRONTO — o
     `crawl-page` pula a identificação pelo TMDB, a parte mais cara e frágil dos
     outros sites. Itens no formato do `mico.search` atual (mesmo `magnet` montado
     dos `sources`, `isBr: true`, `indexer: 'mico'`), para a gravação ser a de
     sempre (banco vivo + filtro de título + índice).
   - Sem stream (83% da amostra) é `no-torrent`, com releitura espaçada (o
     acervo do Mico muda — sugestão: 14 dias via o `requeue` que já existe).
   - Série (**Fase 2 IMPLEMENTADA**, `mico-series.ts`): lista de episódios pela
     Cinemeta (`getMeta('series', tt)`), só os já exibidos
     (`episodeAired["S:E"]` ≤ agora), das `MICO_CRAWL_SERIES_MAX_SEASONS`
     temporadas mais recentes para trás; uma chamada por episódio até
     `maxButtons` por passe, groups `{season, episode, releases}` na locação
     certa e progresso retomável (`SeriesWorkProgress`, `doneCards="S:E"`
     monotônico), como as séries do Vaca.
4. **Ritmo.** API na Vercel de terceiro: `delayMs` ≥ 1 s e `maxPerHour`
   próprio (sugestão: 600), sem FlareSolverr (fetch direto).
5. **Cobertura.** Com a carga concluída, `crawl-coverage.ts` passa a marcar
   `mico` como coberto — o colhedor (`MICO_HARVEST`) deixa de consultá-lo obra a
   obra. A busca ao vivo continua consultando o Mico como hoje.

## Fases e portões

| Fase | Entrega | Portão para seguir |
|---|---|---|
| 0 | Medir: ordem do catálogo (recência?), taxa de stream e de hashes novos numa amostra de 300 filmes, latência e limites da API | **PASSOU** — 29 novos BR dublados (19,8% de hashes novos), p50 60 ms/p95 540 ms, 0× 429/5xx |
| 1 | Filmes: registro, descoberta por paginação simples, `fetchWork` com IMDb pronto, `bucketLastmod`, testes com fixtures reais, painel | **IMPLEMENTADA** (2026-10-02). Portão de operação: rodar 48 h na VPS e contar `crawl.record.added` do `mico` e o que virou BR dublado tocável |
| 2 | Séries: episódios pela Cinemeta, teto por obra, progresso retomável | **IMPLEMENTADA** (2026-10-02). Portão de operação: como a Fase 1, rodar na VPS e contar `crawl.record.added` do `mico` em `tv_show` |

Kill-switch: o próprio liga/desliga do site no painel; nada novo no `.env`
além do ritmo, se o default não servir.

## Riscos

- **Retorno baixo** (86% repetido) — o portão da fase 0/1 existe por isso.
- **API de terceiro**: pode mudar formato ou limitar; falha nunca derruba o
  motor (é erro de página, com backoff), e o fetch não leva credencial nenhuma.
- **Matching fraco do Mico** (já documentado: Coringa traz Harley Quinn): tudo
  passa pelo `filterRelevantRaw` da gravação, como hoje na busca ao vivo.
- **Série é cara**: dezenas de milhares de chamadas; por isso fica para a fase 2
  e com teto.

## Arquivos

- novo: `src/providers/crawl-sites/mico.ts` (327 linhas, dentro do teto de 400;
  `mico-discovery.ts` não foi necessário), `test/crawl-mico.test.ts`, fixtures em
  `test/fixtures/crawl/mico/` (`catalog-skip-0.json`, `catalog-skip-5.json`,
  `catalog-empty.json`, `stream-movie.json` — stream REAL capturado,
  `stream-empty.json`)
- muda: `src/providers/mico.ts` (`fetchMicoStreams`, `micoMovieStreamUrl`,
  `micoEpisodeStreamUrl` — a busca ao vivo `search` NÃO mudou de
  comportamento), `crawl-sites/registry.ts` (+ teste da tabela),
  `src/config/providers.ts` e `.env.example` (`MICO_CRAWL_MIN_GAP_MS`,
  `MICO_CRAWL_REREAD_DAYS`), `harvest-worker.ts` (pula filme coberto),
  `test/crawl-site-catalog.test.ts`, `AGENTS.md` (bloco do raspador e do Mico)

### Fase 2 (séries) — IMPLEMENTADA

- novo: `src/providers/crawl-sites/mico-series.ts` (descoberta + leitura de
  séries) e `src/providers/crawl-sites/mico-shared.ts` (primitivas puras,
  throttle próprio e página de catálogo, compartilhadas por filme e série sem
  ciclo). `mico.ts` foi reescrito como orquestrador (227 linhas) — a extração
  coube no teto de 400 (`lint:lines` verde). `test/crawl-mico-series.test.ts`
  (registrado em `testFiles` no `package.json`); fixtures
  `catalog-series-skip-0.json`, `catalog-series-skip-3.json`,
  `catalog-series-empty.json`, `stream-episode.json` e `meta-series.json`
  (payload da Cinemeta com `videos`/datas de exibição).
- muda: `src/config/providers.ts` e `.env.example`
  (`MICO_CRAWL_SERIES_MAX_SEASONS`, default 2), `harvest-worker.ts` (pula filme
  E série quando o raspador cobre o `mico`), `AGENTS.md` (blocos do colhedor,
  da descoberta e o novo bloco de séries). A busca AO VIVO e o pipeline de
  stream não mudaram; o `fetchMicoStreams` devolve `{items, ok}` desde a Fase 1
  (o `ok` preserva o 4xx neutro no breaker ao vivo).
