// Sonda AMOSTRAL por site (Fase 8, item 8.3) — operador, à mão, rede real.
// É a medição que o plano exige ANTES de ligar qualquer fonte nova na rotação
// ("medir uma amostra de 40 itens como foi feito no Vaca"):
//
//   npm run build && npm run probe:crawl-site -- --site=vacatorrent --sample=40
//   npm run build && npm run probe:crawl-site -- --site=nerdfilmes --offset=13
//   npm run build && npm run probe:crawl-site -- --site=nerdfilmes --write
//
// A ESCRITA DO VEREDITO É ÓPT-IN (`--write`). Sem a flag, a rodada é de
// OBSERVAÇÃO: imprime o relatório e não grava nada — e é o default de propósito,
// porque o veredito gravado é a autorização de entrada do site na rotação.
// `--no_write` (com sublinhado), `--write=false` e qualquer typo são flag
// DESCONHECIDA e derrubam a CLI antes de qualquer import pesado, nunca uma
// gravação silenciosa.
//
// O que este processo FAZ:
//   - resolve o adaptador REAL do site (o mesmo `CrawlSite` que o motor usa);
//   - descobre as URLs pelo `discover()` e tira uma amostra ESPALHADA de 40
//     (--offset gira o conjunto entre rodadas);
//   - processa cada página pelo `processCrawlPage` em dry-run E noPersist, uma
//     por vez, com a pausa do `CRAWL_DELAY_MS`.
//
// O que ele NÃO faz — e o porquê está em cada ponto:
//   - não abre a fila: a linha da página é SINTÉTICA, montada na memória. Sem
//     `crawl_url`/`crawl_run`, sem `takeNext`, sem `requeueUrl` — a sonda não
//     consome nem devolve trabalho do motor (é o que a `simulate` do painel faz,
//     e ela depende da fila estar carregada; aqui a amostra sai do `discover`);
//   - não grava acervo: dry-run impede o recorder (banco de magnets/índice) e
//     noPersist impede o store. As duas travas são independentes e as duas
//     ligadas;
//   - não altera cursor nem `crawl_state` além de `probe:verdict`, e isso
//     SOMENTE com `--write`; `crawl-store` é importado só por isso;
//   - não abre porta nem aquece resolvedor: a superfície do profile é
//     construída direto (mesmo caminho da sonda da Fase 2,
//     `crawl-identify-probe.ts`), então a sonda não briga com o container por
//     8700-8707. Se a instância embutida JÁ estiver carregada no processo, ela
//     é reusada (mesmo seletor de domínio, sessão quente);
//   - não imprime segredo: tudo passa por `scrub()`/`pageSlug()` — sem cookie,
//     sem token e sem URL de protetor;
//   - não abre `data/cache.db`: identificar a obra passa por `identifyWork` →
//     `utils/cache.ts`, e esse módulo ABRE o SQLite no LOAD (e carrega tudo do
//     disco). A sonda é uma rodada de observação: o cache de título do TMDB
//     pertence ao processo do addon, e escrever nele a partir daqui seria a
//     sonda mexendo em estado de produção. O L1 em memória continua deduzindo a
//     amostra (40 páginas raramente repetem título), então o custo é nulo.
//
// O TMDB é consultado de propósito: é assim que a identificação é medida, e sem
// ela o `magnetsPerPage` é o único dado. Banco de magnets e índice nunca são
// abertos (o dry-run impede o recorder, e o `magnet-bank` só abre na captura).
// O ÚNICO arquivo em disco que a sonda toca é o `crawl.db`, e só para gravar a
// chave `probe:verdict` no fim (com `--write`).
//
// ── `--help` E FLAG DESCONHECIDA ANTES DE TUDO ──────────────────────────────
// O portão de argumentos roda ANTES do `Promise.all` de imports abaixo, e é
// por isso que ele fica num módulo puro (`crawl-site-probe-report.ts`, cujo
// único import de runtime é o núcleo puro da sonda): `--help` responde sem
// carregar `config.ts`, sem abrir o `crawl.db` e sem resolver adaptador. Sem
// essa ordem, "imprimir o uso" custaria abrir o banco e puxar os oito
// profiles do resolvedor para depois dizer que não vai raspar nada.
process.env.CACHE_PERSIST = 'false';

const argvRaw = process.argv.slice(2);
const { PROBE_USAGE, probeArgGate } = await import('../src/providers/crawl-site-probe-report.js');

// Um portão só: `--help` sai 0 sem rede, contradição e flag desconhecida saem 2.
const flagGate = probeArgGate(argvRaw);
if (flagGate.help) {
  console.log(PROBE_USAGE);
  process.exit(0);
}
if (flagGate.conflict) {
  console.error(`[sonda] ${flagGate.conflict}`);
  console.error(PROBE_USAGE);
  process.exit(2);
}
if (flagGate.unknown.length) {
  console.error(`[sonda] flag desconhecida: ${flagGate.unknown.join(', ')}. `
    + 'A escrita do veredito e "--write"; "--no_write" e "--no-write" sao coisas diferentes.');
  console.error(PROBE_USAGE);
  process.exit(2);
}

// ── POR QUE TUDO ENTRA POR `await import()` ───────────────────────────────
// ESM HOISTA os `import` estáticos: eles rodam ANTES da primeira linha deste
// arquivo, então um `process.env` aqui não alcançaria um módulo já carregado.
// Como o `cache.ts` abre o banco no load, a atribuição tem que acontecer antes —
// e a única forma num entry-point ESM é o import dinâmico (o mesmo motivo do
// `--import ./dist/test/setup-env.js` na suíte). Os `import type` abaixo são
// apagados na compilação e não têm efeito na ordem.
const [

  { default: config },
  { vacaSurface, nerdSurface, tdfSurface, comandoSurface, redetorrentSurface, bludvSurface, hdrSurface },
  { createVacaCrawlSite },
  { createNerdfilmesCrawlSite },
  { createTorrentdosfilmesCrawlSite },
  { createComandotorrentsCrawlSite },
  { createRedetorrentCrawlSite },
  { createBludvCrawlSite },
  { createHdrtorrentsCrawlSite },
  { processCrawlPage },
  { instance },
  store,
  {
    PROBE_STATE_KEY, PROBE_VERDICT_VERSION,
    classifyPage, decide, emptyCost, evenlySpaced, renderProbeVerdict, summarize,
  },
  { pageSlug, parseProbeArgv, probeWriteDrifts, scrub },
] = await Promise.all([
  import('../src/config.js'),
  import('./crawl-probe-surfaces.js'),
  import('../src/providers/crawl-sites/vaca.js'),
  import('../src/providers/crawl-sites/nerdfilmes.js'),
  import('../src/providers/crawl-sites/torrentdosfilmes.js'),
  import('../src/providers/crawl-sites/comandotorrents.js'),
  import('../src/providers/crawl-sites/redetorrent.js'),
  import('../src/providers/crawl-sites/bludv.js'),
  import('../src/providers/crawl-sites/hdrtorrents.js'),
  import('../src/providers/crawl-page.js'),
  import('../src/br-resolvers.js'),
  import('../src/utils/crawl-store.js'),
  import('../src/providers/crawl-site-probe.js'),
  import('../src/providers/crawl-site-probe-report.js'),
]);

import type { PageReading, ProbeStop, ProbeVerdict } from '../src/providers/crawl-site-probe.js';
import type { ProbeOptions } from '../src/providers/crawl-site-probe-report.js';
import type { CrawlSite, CrawlUrlRow, DiscoveredUrl } from '../src/providers/crawl-types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Adaptador do site da rodada. Primeiro a instância EMBUTIDA (é o caminho de
 * produção: seletor de domínio vivo, sessão quente) — alcançada só se o
 * processo já a carregou. Fora dela, a superfície é construída direto do
 * profile; é aqui que entra o site NOVO (uma linha por site, sem `listen`).
 *
 * `seriesProbe` é o portão da AMOSTRA de série: os sites BR publicam série por
 * post de temporada, e o `discover` só emite `tv_show` quando a rodada pede
 * série. A produção NUNCA liga isso (a fábrica do registry não passa a opção);
 * aqui é o que permite medir ≥10 páginas de série sem ligar as séries do site.
 */
async function resolveSite(siteId: string, series: boolean): Promise<CrawlSite | null> {
  if (instance(siteId)) {
    const { ensureActiveSite } = await import('../src/providers/crawl-sites/registry.js');
    const embedded = await ensureActiveSite(siteId);
    if (embedded) return embedded;
  }
  if (siteId === 'vacatorrent') return createVacaCrawlSite(vacaSurface());
  if (siteId === 'nerdfilmes') {
    return createNerdfilmesCrawlSite(nerdSurface(), { seriesProbe: series });
  }
  if (siteId === 'torrentdosfilmesv2') {
    return createTorrentdosfilmesCrawlSite(tdfSurface(), { seriesProbe: series });
  }
  if (siteId === 'comandotorrents') {
    return createComandotorrentsCrawlSite(comandoSurface(), { seriesProbe: series });
  }
  // Card `redetorrent-cardigann`, profile `redetorrent`: `instance()` é
  // indexado pelo NOME do profile, então a instância embutida acima não casa
  // com o id do card e a superfície direto é o caminho da sonda.
  if (siteId === 'redetorrent-cardigann') {
    return createRedetorrentCrawlSite(redetorrentSurface(), { seriesProbe: series });
  }
  // Os dois adapts novos (Fase 8) entram pelo MESMO caminho direto e pela MESMA
  // ponte por NOME: `instance()` é indexado pelo nome do profile, então o id do
  // card nunca casa com ele. Sem estas linhas a sonda — o PORTÃO de entrada do
  // site na rotação — não roda para os dois. `ensureSite` fica de fora de
  // propósito: ele viria pela instância embutida, que não existe neste processo.
  if (siteId === 'bludv-cardigann') {
    return createBludvCrawlSite(bludvSurface(), { seriesProbe: series });
  }
  if (siteId === 'hdrtorrent-cardigann') {
    return createHdrtorrentsCrawlSite(hdrSurface(), { seriesProbe: series });
  }
  return null;
}

/**
 * Linha SINTÉTICA da página: o `processCrawlPage` só usa `site`, `url`, `kind`
 * e `progress` (retomada) de uma `CrawlUrlRow`. Com `noPersist` nenhuma das
 * marcações chega ao store, então a linha não existe em lugar nenhum — ela é
 * a unidade de trabalho em memória da sonda.
 */
function sampleRow(siteId: string, entry: DiscoveredUrl): CrawlUrlRow {
  return {
    site: siteId, url: entry.url, lastmod: entry.lastmod, kind: entry.kind,
    status: 'pending', imdb: null, tries: 0, nextAt: 0, checkedAt: 0,
    releases: 0, error: '', progress: '', addedAt: 0,
  };
}

interface RunResult {
  readings: PageReading[];
  stop: ProbeStop;
  discovered: number;
  kind: 'movie' | 'tv_show' | 'mixed';
  complete: boolean;
}

async function runSample(site: CrawlSite, opts: ProbeOptions): Promise<RunResult> {
  const series = {
    enabled: opts.series,
    maxCards: opts.seriesMaxCards,
    maxButtons: opts.seriesMaxButtons,
  };
  const discovery = await site.discover(null, { series });
  if (!discovery.urls.length) throw new Error('descoberta vazia: o site não devolveu nenhuma URL');
  console.log(`[sonda] ${site.label} (${site.id}): ${discovery.urls.length} URL(s) `
    + `· completa=${discovery.complete} · falhas=${discovery.failures.length}`);
  for (const failure of discovery.failures.slice(0, 3)) console.log(`[sonda]   falha: ${scrub(failure)}`);

  // Amostragem ESTRATIFICADA quando a rodada pede série: a auditoria do plano
  // exige que as páginas de série apareçam na amostra, e `evenlySpaced` sobre a
  // lista inteira (32% de temporada no acervo medido do NerdFilmes) deixaria
  // a leitura de série como detalhe. Metade da amostra é de cada tipo, e o
  // console diz quantas linhas de série saíram de verdade.
  const movies = discovery.urls.filter((u) => u.kind === 'movie');
  const shows = discovery.urls.filter((u) => u.kind !== 'movie');
  const picked = opts.series && shows.length
    ? [
      ...evenlySpaced(movies, Math.round(opts.sample / 2), opts.offset),
      ...evenlySpaced(shows, opts.sample - Math.round(opts.sample / 2), opts.offset),
    ]
    : evenlySpaced(movies, opts.sample, opts.offset);
  const kinds = new Set(picked.map((u) => u.kind));
  const kind: RunResult['kind'] = kinds.size > 1 ? 'mixed' : (kinds.values().next().value ?? 'movie');
  console.log(`[sonda] amostra de ${picked.length} página(s) espalhada(s) (offset ${opts.offset}, `
    + `${kind}${opts.series ? `; ${picked.filter((u) => u.kind !== 'movie').length} de série` : ''})`
    + `; uma por vez, pausa ${opts.delayMs}ms`);

  const readings: PageReading[] = [];
  let stop: ProbeStop = picked.length < opts.sample ? 'descoberta-pequena' : 'amostra-completa';
  let siteDownStreak = 0;
  for (const entry of picked) {
    const slug = pageSlug(entry.url);
    // Cronômetro DA LEITURA da página (o adaptador inteiro: HTML do post e
    // cada salto de botão), medido em volta do `processCrawlPage`. É o que
    // alimenta a média e o p95 de latência do relatório — e o p95 sai de uma
    // amostra real, com `measuredPages` dizendo sobre quantas páginas.
    const t0 = Date.now();
    try {
      const outcome = await processCrawlPage(site, sampleRow(site.id, entry), {
        dryRun: true, noPersist: true, maxTries: config.crawl.maxTries, series,
      });
      readings.push(classifyPage({
        kind: outcome.kind, siteLevelError: outcome.siteLevelError,
        detail: outcome.detail, releases: outcome.releases,
        requests: outcome.requestCost, latencyMs: Date.now() - t0, slug,
      }));
      siteDownStreak = outcome.siteLevelError ? siteDownStreak + 1 : 0;
      if (siteDownStreak >= 3) { stop = 'site-fora'; break; }
    } catch (err: unknown) {
      // `processCrawlPage` devolve `error` em vez de lançar; exceção CRUA é
      // colaborador/store (ou um `any`-adaptador futuro) — a página conta como
      // erro de leitura e a rodada continua, senão a sonda morre no fim da
      // primeira e o operador fica sem veredito nenhum.
      readings.push(classifyPage({ kind: 'error', detail: scrub(err), latencyMs: Date.now() - t0, slug }));
      console.log(`[sonda] ${slug}: exceção — ${scrub(err)}`);
    }
    if (readings.length < picked.length) await sleep(opts.delayMs);
  }
  return { readings, stop, discovered: discovery.urls.length, kind, complete: discovery.complete };
}

/** Relatório no console: taxas com denominador explícito, ponto E limite. */
function printReport(v: ProbeVerdict): void {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  console.log(`\n=== Sonda ${v.site} · veredito ${v.verdict.toUpperCase()} ===`);
  console.log(`amostra: ${v.sample} página(s) · parou por: ${v.stop} · ${v.reasons.join(', ') || 'sem ressalva'}`);
  console.log(`páginas válidas ${v.counts.valid}/${v.counts.sample} = ${pct(v.rates.valid)} `
    + `(limite inferior 95% ${pct(v.bounds.valid)} · alvo ${pct(v.thresholds.validRate)})`);
  console.log(`com release ${v.counts.withRelease}/${v.denominators.buttonPages} botão(s) = ${pct(v.rates.magnet)} `
    + `(lim. inf. ${pct(v.bounds.magnet)} · alvo ${pct(v.thresholds.magnetRate)})`);
  console.log(`identificadas ${v.counts.identified}/${v.denominators.identifyAnswered} página(s) com release = `
    + `${pct(v.rates.identify)} (lim. inf. ${pct(v.bounds.identify)} · alvo ${pct(v.thresholds.identifyRate)})`);
  console.log(`magnets/página com botão: ${v.rates.magnetsPerPage} `
    + `(${v.counts.magnets} magnet(s) · alvo ${v.thresholds.magnetsPerPage})`);
  // A classe separa o que o balde agrupava: `no-work` é o TMDB RESPONDENDO que
  // a página não é a obra, `tmdb-down` é a NOSSA dependência fora. Lidos juntos
  // (v1) eles davam "TMDB caiu" para 21 páginas de série que rendeu sim.
  console.log(`classes: ${v.counts.identified} identificada(s) · ${v.counts.noWork} no-work (obra não veio) · `
    + `${v.counts.tmdbDown} tmdb-down (TMDB fora) · ${v.counts.noTorrent} sem botão · `
    + `${v.counts.buttonNoMagnet} botão sem magnet · ${v.counts.pageErrors} erro(s) de página · ${v.counts.siteLevel} site fora`);
  const cost = v.cost ?? emptyCost();
  console.log(`custo: ${cost.requests} requisição(ões) em ${v.sample} página(s) · `
    + `média ${cost.requestsPerPage}/página · p95 ${cost.p95RequestsPerPage}/página · latência média ${cost.meanLatencyMs}ms `
    + `· p95 ${cost.p95LatencyMs}ms · máx ${cost.maxLatencyMs}ms (medida em ${cost.measuredPages} página(s))`);
  console.log(`limiares usados: ${JSON.stringify(v.thresholds)}`);
  if (v.counts.buttonNoMagnet > 0) {
    console.log('nota: páginas de "botão sem magnet" contam no denominador de magnet, porque é a falha '
      + 'que a taxa mede; elas entram com 0 releases porque nenhum magnet saiu.');
  }
  if (v.counts.noWork > 0) {
    console.log(`nota: ${v.counts.noWork} página(s) tiveram release e obra não identificada (no-work). As releases `
      + 'VISTAS continuam em `magnets` e a identificação conta como resposta negativa. Página de série é o '
      + 'caso conhecido: o TMDB não resolve o título do post de temporada.');
  }
  if (v.kind !== 'movie') {
    console.log('nota: a rodada nao e de filme (' + v.kind + '). Os dois publicos tem denominadores '
      + 'diferentes e a serie hoje nao e identificavel por titulo, entao este veredito NAO vale como '
      + 'autorizacao de rotacao — nem com --write.');
  }
  console.log('limitação conhecida: o denominador "página com botão" é INFERIDO do desfecho; o '
    + 'adaptador pode medir `buttons`/`buttonsFollowed`, mas o `PageOutcome` não carrega o campo.');
  if (v.verdict === 'go') {
    console.log(`\nLiberado: com CRAWL_REQUIRE_PROBE=true, "${v.site}" entra na rotação por este veredito.`);
  } else if (v.verdict === 'no-go') {
    console.log(`\nBloqueado: "${v.site}" NÃO entra na rotação com CRAWL_REQUIRE_PROBE=true `
      + `(${v.reasons.filter((r) => r.startsWith('abaixo-limiar:')).join(', ') || 'sem botão publicável'}).`);
  } else {
    console.log('\nInconclusivo: remedir outro dia (ou com --sample maior) antes de decidir pela fonte.');
  }
}

async function main(): Promise<void> {
  // O portão de flags já rodou antes de qualquer import; `parseProbeArgv` é o
  // MESMO gate, então os dois desfechos extras aqui são rede de segurança para
  // quem chamar `main` por outro caminho — nunca "siga com o que deu para
  // entender", que era o bug do `--no_write` gravando a autorização.
  const parsed = parseProbeArgv(argvRaw, process.env, {
    site: config.crawl.sites[0] || 'vacatorrent',
    delayMs: config.crawl.delayMs,
    seriesMaxCards: config.crawl.seriesMaxCards,
    seriesMaxButtons: config.crawl.seriesMaxButtons,
  });
  if (parsed.kind === 'help') { console.log(parsed.usage); process.exit(0); }
  if (parsed.kind === 'error') { console.error(`[sonda] ${parsed.message}`); console.error(parsed.usage); process.exit(2); }
  const opts = parsed.options;
  if (!opts.site) {
    console.error('informe --site=<id do card do Jackett> (ou CRAWL_PROBE_SITE)');
    process.exit(1);
  }
  if (!config.tmdb.apiKey) {
    console.warn('[sonda] TMDB_API_KEY ausente: a identificação NÃO será medida '
      + '(páginas com release saem como "sem TMDB" e o veredito tende a inconclusivo).');
  }
  const site = await resolveSite(opts.site, opts.series);
  if (!site) {
    // Só os sites com SUPERFÍFIE DIRETA (segundo caminho do `resolveSite`); o
    // `apachetorrent-cardigann` fica de fora porque a tabela ainda o marca sem adaptador.
    console.error(`sem adaptador para "${opts.site}" neste processo: a sonda conhece `
      + 'vacatorrent, nerdfilmes, torrentdosfilmesv2, comandotorrents, redetorrent-cardigann, '
      + 'bludv-cardigann e hdrtorrent-cardigann (superfície direta) e qualquer site com instância embutida carregada.');
    process.exit(1);
  }

  const { readings, stop, discovered, kind, complete } = await runSample(site, opts);
  const summary = summarize(readings);
  const decision = decide(summary, opts.thresholds);
  const verdict: ProbeVerdict = {
    v: PROBE_VERDICT_VERSION, site: site.id, verdict: decision.verdict, at: Date.now(), sample: summary.counts.sample,
    counts: summary.counts, rates: summary.rates, bounds: summary.bounds,
    denominators: summary.denominators, thresholds: opts.thresholds,
    reasons: decision.reasons, stop, kind, classes: summary.classes, cost: summary.cost,
  };
  printReport(verdict);
  console.log(`descoberta: ${discovered} URL(s) · completa=${complete} · kind=${kind}`);

  if (opts.write) {
    // O veredito gravado é AUTORIZAÇÃO de entrada na rotação (gate do motor),
    // então ele só existe sob a política do plano: amostra inteira de 40, UM
    // ÚNICO tipo de página (só filme) e limiares PADRÃO. A rodada de
    // OBSERVAÇÃO (sem `--write`, que é o default) pode mexer nos três à vontade
    // — é ela que não libera nada. A lista de desvios é a do módulo puro, e é
    // ela que o teste cobre: o `kind` é a trava que a rodada de série refutava.
    const drifts = probeWriteDrifts({ kind, sample: summary.counts.sample, thresholds: opts.thresholds });
    if (drifts.length) {
      console.error(`\nveredito NÃO gravado: ${drifts.join('; ')}. `
        + 'Limiar, amostra ou população fora da política não libera site — rode SEM --write para observar.');
      process.exit(1);
    }
    store.engine().setState(site.id, PROBE_STATE_KEY, renderProbeVerdict(verdict));
    console.log(`\nveredito gravado em crawl_state["${site.id}"]["${PROBE_STATE_KEY}"] (codec v${PROBE_VERDICT_VERSION}) — `
      + 'é a ÚNICA escrita desta rodada (nada mais em crawl.db, nada no acervo).');
  } else {
    console.log('\nveredito NÃO gravado (rodada de observação): a escrita é opt-in por --write.');
  }

  // `--out` grava o MESMO payload do console num arquivo do operador. O JSON é
  // o mesmo objeto já sanitizado (sem cookie/token/URL de protetor), então o
  // arquivo não vira um canal de saída que o log não é. Sai do `argv` cru: o
  // alvo já passou pelo gate de flags acima.
  if (opts.out) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
    console.log(`relatório gravado em ${opts.out}`);
  }
  // Sai com 1 em no-go para o operador poder encadear em script; inconclusivo
  // sai 0 — inconclusive não é reprovação, é falta de medida.
  process.exit(verdict.verdict === 'no-go' ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('[sonda] falhou:', scrub(err));
  process.exit(1);
});
