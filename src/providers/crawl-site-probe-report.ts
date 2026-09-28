// Fronteira da SONDA por site (Fase 8, 8.3) com o resto do sistema: o que SAI
// do processo e como a rodada é configurada. O núcleo do veredito fica em
// `crawl-site-probe.ts` (amostragem, denominadores, limiares, codec); aqui
// mora só o que é exclusivo do operador, e o motivo de sair dali é o mesmo dos
// dois: são as duas pontas onde um erro é irreversível ou ilegível.
//
// `scrub` é a decisão de segurança: o relatório vai para o log do operador e para
// o painel, e NENHUMA credencial, cookie ou URL de protetor pode atravessar.
// `pageSlug` é a outra ponta do mesmo acordo — a página entra no relatório como
// identificador, nunca como URL, porque a URL pode ser do host de failover ou da
// cadeia do protetor.
//
// `parseProbeOptions` concentra o parse de CLI/env COM env INJETADO (nada de
// `process.env` no módulo puro — o teste cobre o parse inteiro) e a precedência
// default < env < CLI. Os knobs `CRAWL_PROBE_*` ainda NÃO estão em `config.ts` de
// propósito: quem implementou a config multi-site do `CrawlSite` é o dono daquele
// arquivo nesta fase. Quando ele fechar, os mesmos nomes passam a ser lidos de lá
// sem mudar esta assinatura — e por isso que o `env` chega pronto.
//
// A ESCRITA do veredito é ÓPT-IN (`--write`) e a flag é o ÚNICO pedido que
// libera o site na rotação. Ela não pode ser o default: `--no_write` (com
// sublinhado), `--write=false` e um typo qualquer levavam a mesma leitura "não
// pediu escrita" e gravavam a autorização de qualquer jeito. Ausência da flag
// significa ausência de autorização, sempre.
//
// O vocabulário de flags vive em `probeArgGate`, que é puro e não precisa de
// `config.ts` — é o que o entry-point consulta ANTES de carregar qualquer módulo,
// para `--help` e flag desconhecida responderem sem tocar rede nem abrir o
// `crawl.db`. `parseProbeArgv` reusa o mesmo gate: uma lista só de flags
// aceitas, sem a possibilidade de o parse e a validação divergirem.
import { DEFAULT_PROBE_THRESHOLDS, PROBE_SAMPLE } from './crawl-site-probe.js';
import type { ProbeThresholds, ProbeVerdict } from './crawl-site-probe.js';

export type { ProbeThresholds };

// --- Sanitização do relatório ----------------------------------------------

/**
 * Três camadas, da mais ampla para a mais fina: header de cookie, par
 * `chave=valor` (e a forma de header `nome: valor`) de nome sensível, e
 * QUALQUER URL — a de protetor não é pública do site e o caminho dela
 * identifica a cadeia, o suficiente para o log virar canal de saída.
 */
export function scrub(raw: unknown, maxLen = 200): string {
  let text = String((raw as { message?: string })?.message ?? raw ?? '');
  text = text.replace(/\b(?:set-)?cookie\s*:\s*[^\r\n]*/gi, 'cookie:***');
  text = text.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'bearer ***');
  // Forma `chave=valor`: lista ampla (inclusive `pass`/`session`), valor com ou
  // sem aspas. Erro de terceiro imprime a query inteira, e é aí que a chave mora.
  text = text.replace(
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|pass|cf_clearance|session|auth)[A-Za-z0-9_.-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s&,;"']+)/gi,
    '$1=***',
  );
  // Forma de HEADER `nome: valor` — lista estreita, sem o `pass` solto (que em
  // texto corrido é palavra, não credencial: "pass: 3 páginas" viraria lixo).
  text = text.replace(
    /\b((?:x-)?(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|authorization|auth|session[_-]?id|cf_clearance))\s*:\s*("[^"]*"|'[^']*'|[^\s,;"']+)/gi,
    '$1: ***',
  );
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** Identificador de página para o relatório: último segmento do caminho, sem
 * query e sem host (o host pode ser o do failover, e a URL inteira é o que a
 * constraint de segredo proíbe). */
export function pageSlug(url: string, maxLen = 60): string {
  let pathPart = String(url || '');
  try {
    pathPart = new URL(pathPart).pathname;
  } catch {
    pathPart = pathPart.split('?')[0].split('#')[0];
  }
  const slug = (pathPart.replace(/\/+$/, '').split('/').pop() || '').trim();
  return slug.slice(0, maxLen);
}

// --- Opções da rodada (CLI/env) --------------------------------------------

export interface ProbeOptions {
  site: string;
  sample: number;
  offset: number;
  delayMs: number;
  series: boolean;
  /** Módulos de série (releem `CRAWL_SERIES_*`; a sonda de filme não usa). */
  seriesMaxCards: number;
  seriesMaxButtons: number;
  /**
   * GRAVAR o veredito em `crawl_state`? Opt-in por `--write`. `false` é o
   * default e significa rodada de OBSERVAÇÃO — nada é gravado, e o relatório
   * nem libera site, porque a autorização é o veredito gravado.
   */
  write: boolean;
  /** Arquivo do relatório JSON do operador (`--out=`); `null` = só console. */
  out: string | null;
  thresholds: ProbeThresholds;
}

/** Defaults do `parseProbeArgv` (o que o chamador não decide). */
export type ProbeArgDefaults = {
  site: string; delayMs: number; seriesMaxCards: number; seriesMaxButtons: number;
};

/** Resultado da validação do VOCABULÁRIO de flags (sem env e sem config). */
export interface ProbeArgGate {
  /** `--help`/`-h`: imprime o uso e sai 0, sem rede. */
  help: boolean;
  /** Flags fora do vocabulário, na ordem em que apareceram. */
  unknown: string[];
  /** Contradição explícita (`--write` e `--no-write` na mesma rodada). */
  conflict: string | null;
}

/**
 * Flags aceitas, com valor depois do `=`. É a LISTA ÚNICA: o gate rejeita
 * qualquer coisa fora daqui (incluindo `--no_write`, que não é o mesmo que
 * `--no-write`) e o parse só lê daqui. Nomes SEM o prefixo `--`, porque é o
 * `bareName` que o gate compara.
 */
const VALUE_FLAGS = [
  'site', 'sample', 'offset', 'delay-ms', 'out',
  'min-valid', 'min-magnet', 'min-identify', 'min-magnets',
] as const;

/** Flags booleanas aceitas. `--write` é a que LIBERA; `--no-write` é a
 *  redundância explícita de quem sabe que a observação é o default. */
const BOOL_FLAGS = ['series', 'write', 'no-write'] as const;

const flagName = (arg: string): string => {
  const cut = arg.indexOf('=');
  return cut >= 0 ? arg.slice(0, cut) : arg;
};

/** Nome SEM o prefixo: as listas abaixo são os nomes, a comparação é com o nome. */
const bareName = (arg: string): string => {
  const name = flagName(arg);
  return name.startsWith('--') ? name.slice(2) : name;
};

/**
 * Confere o vocabulário de flags. Deliberadamente sem `config.ts`: o entry-point
 * chama isto antes de carregar qualquer módulo, e é o que garante que `--help` e
 * flag desconhecida não cheguem a abrir store, resolver adaptador ou tocar rede.
 */
export function probeArgGate(argv: readonly string[]): ProbeArgGate {
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const arg of argv) {
    if (arg === '--') break;
    // Ajuda é `=` de menos: `--help`/`-h` exatos, e qualquer outra forma é
    // flag desconhecida (uma forma futura com valor não existe no uso).
    if (arg === '--help' || arg === '-h') { seen.add('help'); continue; }
    const name = bareName(arg);
    const comValor = arg.includes('=');
    if ((BOOL_FLAGS as readonly string[]).includes(name)) {
      // `--write=false` NÃO é `--write`: aceitar a forma com valor faria a
      // rodada NEGAR a escrita e gravar a autorização do mesmo jeito — o
      // inverso exato do defeito que o opt-in veio corrigir.
      if (comValor) unknown.push(arg);
      else seen.add(name);
      continue;
    }
    if (!(VALUE_FLAGS as readonly string[]).includes(name) || !comValor) { unknown.push(arg); continue; }
  }
  return {
    help: seen.has('help'),
    unknown,
    conflict: seen.has('write') && seen.has('no-write')
      ? '--write e --no-write na mesma rodada: a escrita é opt-in, escolha uma'
      : null,
  };
}

/** Uso da CLI (o que `--help` imprime, e o que acompanha o erro de flag). */
export const PROBE_USAGE = [
  'Uso: npm run build && npm run probe:crawl-site -- [opcoes]',
  '',
  'Sonda amostral por site: amostra 40 paginas pelo MESMO adaptador que a',
  'producao usa, em dry-run + noPersist. Nao grava acervo, nao abre a fila e',
  'nao altera cursor. A unica escrita possivel e o veredito em crawl_state.',
  '',
  '  --site=<id>          site da rodada (padrao: primeiro de CRAWL_SITES;',
  '                        ou CRAWL_PROBE_SITE). A CLI conhece vacatorrent,',
  '                        nerdfilmes, torrentdosfilmesv2 e comandotorrents, e',
  '                        qualquer site com instancia embutida ja carregada.',
  '  --sample=<n>         tamanho da amostra (padrao 40 = a politica do plano).',
  '  --offset=<n>         gira o conjunto amostrado entre rodadas (padrao 0).',
  '  --delay-ms=<n>       pausa entre paginas (padrao: CRAWL_DELAY_MS).',
  '  --series             amostra de serie (o discover so emite tv_show nela).',
  '  --write              GRAVA o veredito em crawl_state["<site>"]["probe:verdict"]',
  '                        e passa a valer como autorizacao de entrada na',
  '                        rotacao. OPT-IN: sem esta flag nada e gravado.',
  '  --no-write           explicita a rodada de observacao (e o default).',
  '  --out=<arquivo>      grava o mesmo JSON do console num arquivo do operador',
  '                        (payload ja sanitizado, sem cookie/token/URL).',
  '  --min-valid=<r>      limiar de paginas validas (0..1; padrao do plano).',
  '  --min-magnet=<r>     limiar de paginas com release (0..1).',
  '  --min-identify=<r>   limiar de identificacao (0..1).',
  '  --min-magnets=<n>    media de magnets por pagina com botao (>=0).',
  '  --help, -h           imprime este uso e sai 0, sem tocar a rede.',
  '',
  'O veredito so e gravado com --write E sob a politica do plano: amostra',
  'inteira de 40, SO FILME (rodada de serie ou mista nao grava) e limiares',
  'PADRAO. Fora disso a CLI recusa gravar e diz por que. Os limiares tambem',
  'aceitam CRAWL_PROBE_MIN_* no ambiente.',
].join('\n');

const numArg = (argv: string[], name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const numOf = (value: unknown, fallback: number, min = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.trunc(n) : fallback;
};

const ratioOf = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

/** Sem truncagem: `magnetsPerPage` é média, não contagem (1.5 é limiar útil). */
const meanOf = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Opções da rodada: precedência default < env < CLI (ver o cabeçalho).
 *  Não valida o vocabulário de flags — quem recusa é `probeArgGate` (e o
 *  chamador que decide sair diferente de zero). */
export function parseProbeOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  defaults: ProbeArgDefaults,
): ProbeOptions {
  const d = DEFAULT_PROBE_THRESHOLDS;
  return {
    site: String(numArg([...argv], 'site') ?? env.CRAWL_PROBE_SITE ?? defaults.site ?? '').trim(),
    sample: Math.max(1, numOf(numArg([...argv], 'sample') ?? env.CRAWL_PROBE_SAMPLE, PROBE_SAMPLE, 1)),
    offset: Math.max(0, numOf(numArg([...argv], 'offset') ?? env.CRAWL_PROBE_OFFSET, 0)),
    delayMs: Math.max(0, numOf(numArg([...argv], 'delay-ms') ?? env.CRAWL_PROBE_DELAY_MS, defaults.delayMs)),
    series: argv.includes('--series') || String(env.CRAWL_PROBE_SERIES || '') === 'true',
    seriesMaxCards: Math.max(1, numOf(env.CRAWL_SERIES_MAX_CARDS, defaults.seriesMaxCards, 1)),
    seriesMaxButtons: Math.max(1, numOf(env.CRAWL_SERIES_MAX_BUTTONS, defaults.seriesMaxButtons, 1)),
    // Opt-in: só `--write` grava. `--no-write` é a redundância explícita de
    // quem sabe que observar é o default, e nunca é confundido com o silêncio
    // (que também observa).
    write: argv.includes('--write') && !argv.includes('--no-write'),
    out: (numArg([...argv], 'out') ?? '').trim() || null,
    thresholds: {
      validRate: ratioOf(numArg([...argv], 'min-valid') ?? env.CRAWL_PROBE_MIN_VALID, d.validRate),
      magnetRate: ratioOf(numArg([...argv], 'min-magnet') ?? env.CRAWL_PROBE_MIN_MAGNET, d.magnetRate),
      identifyRate: ratioOf(numArg([...argv], 'min-identify') ?? env.CRAWL_PROBE_MIN_IDENTIFY, d.identifyRate),
      magnetsPerPage: meanOf(numArg([...argv], 'min-magnets') ?? env.CRAWL_PROBE_MIN_MAGNETS, d.magnetsPerPage),
    },
  };
}

/** O que o entry-point faz com a linha de comando. */
export type ProbeArgParse =
  | { kind: 'help'; usage: string }
  | { kind: 'error'; message: string; usage: string }
  | { kind: 'run'; options: ProbeOptions };

/**
 * Parse COM validação: `--help`/flag desconhecida/contradição saem como
 * desfecho próprio, nunca como rodada. A CLI decide o código de saída; aqui só
 * existe a distinção — o que ela NÃO faz é aceitar flag fora do vocabulário em
 * silêncio, que era como `--no_write` virava gravação.
 */
export function parseProbeArgv(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  defaults: ProbeArgDefaults,
): ProbeArgParse {
  const gate = probeArgGate(argv);
  if (gate.help) return { kind: 'help', usage: PROBE_USAGE };
  if (gate.unknown.length) {
    return {
      kind: 'error',
      usage: PROBE_USAGE,
      message: `flag desconhecida: ${gate.unknown.join(', ')}`
        + ' (a escrita do veredito e "--write"; "--no_write" e "--no-write" sao coisas diferentes)',
    };
  }
  if (gate.conflict) return { kind: 'error', message: gate.conflict, usage: PROBE_USAGE };
  return { kind: 'run', options: parseProbeOptions(argv, env, defaults) };
}

// --- O que RECUSA a gravação do veredito -------------------------------------

/**
 * Desvio de `kind` por tipo de página, escrito para o operador. A autorização é
 * por TIPO: o veredito descreve as páginas que foram medidas, e o motor raspa
 * as duas populações. Uma rodada de série mede a série — exatamente a população
 * que hoje não é identificável por título (o `no-work` que a v2 do codec passou
 * a contar como resposta negativa) — e gravá-la autorizaria a entrada do site
 * inteiro com um número que descreve a outra metade do acervo.
 */
const KIND_DRIFT: Record<string, string> = {
  mixed: 'rodada mista (filme + serie): a autorizacao e por tipo de pagina',
  tv_show: 'rodada de serie (tv_show): a autorizacao e por tipo de pagina e hoje a '
    + 'pagina de serie nao e identificavel por titulo (a identificacao medida e do TMDB, nao do site)',
};

export interface ProbeWriteInput {
  kind: ProbeVerdict['kind'];
  sample: number;
  thresholds: ProbeThresholds;
}

/**
 * Lista de desvios que impedem GRAVAR o veredito — vazia é a única condição que
 * autoriza a escrita. São as três travas da política do plano: amostra inteira
 * de 40, UM tipo de página (só `movie`) e limiares padrão.
 *
 * `kind !== 'movie'` — e não `kind === 'mixed'` — é o ponto que importa: a
 * trava antiga barrava só a rodada MISTA, então uma rodada PURA de série (que a
 * própria CLI sabe rodar com `--series`) passava e gravava um GO autorizando o
 * site inteiro, contra o comentário logo acima dela. O que libera é o tipo de
 * página que o plano mediu; as demais só podem ser rodadas em OBSERVAÇÃO.
 */
export function probeWriteDrifts(input: ProbeWriteInput): string[] {
  const drifts: string[] = [];
  if (input.sample !== PROBE_SAMPLE) drifts.push(`amostra ${input.sample} != ${PROBE_SAMPLE}`);
  if (input.kind !== 'movie') {
    drifts.push(KIND_DRIFT[input.kind]
      || `rodada de ${input.kind}: a autorizacao e por tipo de pagina (so filme grava)`);
  }
  for (const key of ['validRate', 'magnetRate', 'identifyRate', 'magnetsPerPage'] as const) {
    if (input.thresholds[key] !== DEFAULT_PROBE_THRESHOLDS[key]) {
      drifts.push(`${key}=${input.thresholds[key]} (padrao ${DEFAULT_PROBE_THRESHOLDS[key]})`);
    }
  }
  return drifts;
}
