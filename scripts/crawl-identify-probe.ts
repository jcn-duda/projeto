// Sonda AO VIVO da Fase 2 da raspagem: mede o casamento estrito de
// identificação (título+ano → TMDB → IMDb) numa amostra real de páginas do
// Vaca Torrent SEM IMDb ancorado. Uso manual do operador — não é rota, não é
// teste e NÃO LIGA O CRAWLER (o motor é fase 3; o .env segue com
// CRAWL_ENABLED=false):
//
//   npm run build && npm run probe:crawl-identify -- --sample=100
//
// Garantias do desenho (as mesmas da Fase 1, mais o escopo da Fase 2):
//   - NÃO grava nada: não importa o crawl-store, não abre o data/crawl.db,
//     não chama captureItems, não toca banco de magnets nem índice;
//   - NÃO resolve magnets: só a página da OBRA é baixada — identificar não
//     precisa do movie-links nem do protetor de link;
//   - o transporte é o caminho DIRETO do perfil (fetchTextDirect, sem
//     FlareSolverr), uma página por vez, com a pausa CRAWL_DELAY_MS;
//   - a chave do TMDB vem do .env e NUNCA é impressa (a sonda não loga URL de
//     API; os erros do módulo não carregam query).
//
// Método: descoberta pelo sitemap (mesma do adaptador), página lida na ordem;
// página com IMDb ancorado na ficha técnica é CONTORNADA (não é amostra — o
// alvo é exatamente a cauda sem IMDb); sem título vira "layout"; o restante
// entra na amostra e passa pelo identifyWork. Amostra = páginas com
// identificação tentada (identified/unidentified/ambiguous); "unavailable"
// (TMDB fora) é contado à parte e aborta a medição em série.
import config from '../src/config.js';
import { createResolver } from '../resolvers/profiles/vacatorrent.js';
import {
  createVacaCrawlSite, parseTitleYear, parseImdbId,
} from '../src/providers/crawl-sites/vaca.js';
import type { VacaResolverSurface } from '../src/providers/crawl-sites/vaca.js';
import { identifyWork } from '../src/providers/crawl-identify.js';
import type { IdentifyOutcome } from '../src/providers/crawl-identify.js';

function intArg(name: string, fallback: number): number {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const value = Number(hit.slice(name.length + 3));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

const SAMPLE_TARGET = intArg('sample', 30);
const MAX_PAGES = intArg('max-pages', SAMPLE_TARGET * 4);
const DELAY_MS = intArg('delay-ms', config.crawl.delayMs);
const PAGE_ERROR_ABORT = 10;   // site fora/desafio em série: a medição não tem valor
const UNAVAILABLE_ABORT = 5;   // TMDB indisponível em série: idem

/** Instância do perfil na MESMA config do carregador embutido — mas SEM
 * createServer/listen (nenhuma porta abre) e SEM warm(): a sonda é um
 * processo próprio e passageiro. */
function vacaSurface(): VacaResolverSurface {
  const port = config.resolvers.ports.vacatorrent + config.resolvers.portOffset;
  return createResolver({
    port,
    selfUrl: `http://${config.resolvers.host}:${port}`,
    siteUrl: config.resolvers.vacatorrentUrl || undefined,
    extraProtectors: config.resolvers.extraProtectors,
  });
}

interface SampleRow {
  url: string;
  title: string;
  year: number | null;
  outcome: IdentifyOutcome;
  imdb: string | null;
  reason: string;
}

function slugOf(url: string): string {
  return (new URL(url).pathname.replace(/\/$/, '').split('/').pop() || url).slice(0, 60);
}

/** Erro de terceiro não vai cru ao log: a query/chave não aparece em mensagem
 * nenhuma (o cabeçalho promete que a chave do TMDB nunca é impressa) e o
 * texto é truncado — erro longo de rede não vira parede de log. */
function sanitizeErr(err: unknown): string {
  const raw = String((err as { message?: string })?.message || err);
  return raw.replace(/api_key=[^&\s"']+/gi, 'api_key=***').slice(0, 240);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  if (!config.tmdb.apiKey) {
    console.error('TMDB_API_KEY ausente no .env — medição de identificação não roda.');
    process.exit(1);
  }
  const surface = vacaSurface();
  const site = createVacaCrawlSite(surface);

  console.log(`[sonda] descoberta do sitemap (${new URL(surface.siteSelector.url()).hostname})…`);
  const discovery = await site.discover(null);
  console.log(
    `[sonda] ${discovery.urls.length} URLs de filme descobertas `
    + `(complete=${discovery.complete}, falhas=${discovery.failures.length})`,
  );

  const counters: Record<string, number> = {
    comImdbAncorado: 0, semTitulo: 0, erroPagina: 0,
    identified: 0, unidentified: 0, ambiguous: 0, unavailable: 0,
  };
  const rows: SampleRow[] = [];
  let pages = 0;
  let consecutivePageErrors = 0;
  let stop = '';

  for (const entry of discovery.urls) {
    if (rows.length >= SAMPLE_TARGET) { stop = 'amostra completa'; break; }
    if (pages >= MAX_PAGES) { stop = 'teto de páginas'; break; }
    if (counters.unavailable >= UNAVAILABLE_ABORT) { stop = 'TMDB indisponível em série'; break; }
    if (consecutivePageErrors >= PAGE_ERROR_ABORT) { stop = 'site fora/desafio em série'; break; }

    pages += 1;
    let html: string;
    try {
      html = await surface.fetchTextDirect(entry.url);
      consecutivePageErrors = 0;
    } catch (err) {
      counters.erroPagina += 1;
      consecutivePageErrors += 1;
      console.log(`[sonda] página falhou (${slugOf(entry.url)}): ${sanitizeErr(err)}`);
      continue;
    }

    const { title, year } = parseTitleYear(html);
    if (!title) { counters.semTitulo += 1; continue; }
    if (parseImdbId(html)) { counters.comImdbAncorado += 1; continue; }

    const result = await identifyWork({ type: 'movie', title, year });
    counters[result.outcome] += 1;
    rows.push({ url: entry.url, title, year, outcome: result.outcome, imdb: result.imdb, reason: result.reason });
    console.log(
      `[sonda] ${result.outcome.padEnd(12)} "${title}" (${year ?? '?'})`
      + ` → ${result.imdb ?? 'null'} · ${result.reason}`,
    );
    if (rows.length < SAMPLE_TARGET) await sleep(DELAY_MS);
  }

  const sampled = rows.length;
  console.log('\n=== Resumo da sonda de identificação (Fase 2, Vaca) ===');
  console.log(`páginas baixadas: ${pages} · paradas por: ${stop || 'fim da descoberta'}`);
  console.log(`fora da amostra: ${counters.comImdbAncorado} com IMDb ancorado · `
    + `${counters.semTitulo} sem título (layout) · ${counters.erroPagina} com erro de página`);
  console.log(`amostra (sem IMDb, identificadas): ${sampled}`);
  console.log(`  acertos (identified):   ${counters.identified}`);
  console.log(`  null (unidentified):    ${counters.unidentified}`);
  console.log(`  ambíguos (ambiguous):   ${counters.ambiguous}`);
  console.log(`  TMDB indisponível:      ${counters.unavailable} (fora da taxa)`);
  if (sampled > 0) {
    const hitRate = ((counters.identified / sampled) * 100).toFixed(1);
    const nullRate = ((counters.unidentified / sampled) * 100).toFixed(1);
    const ambRate = ((counters.ambiguous / sampled) * 100).toFixed(1);
    console.log(`  taxas sobre a amostra: ${hitRate}% acerto · ${nullRate}% null · ${ambRate}% ambíguo`);
  }
  const interesting = rows.filter((row) => row.outcome !== 'identified');
  if (interesting.length) {
    console.log('\ndetalhe dos não-acertos (auditoria do casamento estrito):');
    for (const row of interesting) {
      console.log(`  [${row.outcome}] "${row.title}" (${row.year ?? '?'}) · ${row.reason} · ${slugOf(row.url)}`);
    }
  }
  console.log('\nmétodo: sitemap → página da obra (fetch direto, 1 por vez, '
    + `pausa ${DELAY_MS}ms) → páginas SEM IMDb ancorado → identifyWork `
    + '(nome estrito normalizado, ano ±1 local, ambíguo/null). '
    + 'Nada foi gravado: sem crawl.db, sem magnets, sem índice; crawler continua desligado.');
}

main().catch((err) => {
  console.error('[sonda] falhou:', sanitizeErr(err));
  process.exit(1);
});
