// Guarda da bancada: recusa abrir o banco DO REPOSITÓRIO durante os testes.
//
// Incidente que originou esta guarda (Leva B4): rodar um teste TS direto
// (`node dist/test/<arquivo>.js`, sem `--import ./dist/test/setup-env.js`)
// deixou `CACHE_PERSIST` no default (`true`) e `config.cache.dbPath` apontando
// para `<repo>/data/cache.db`. O harness de evicção então limpou o prefixo
// `autofetch:v3:o:` do cache REAL da máquina — verde de um lado, acervo do
// operador mutado do outro.
//
// O `test/setup-env.ts` é quem fecha o buraco por desenho (pina
// `CACHE_PERSIST=false` e joga o `magnets.db` num temp por processo), mas ele
// só vale quando é PRÉ-CARREGADO. Este módulo é a rede de segurança para o
// caminho em que ele não é: quem abre KV/SQLite num helper de teste chama
// `assertSafeTestDb(__name)` ANTES da primeira leitura/escrita e o teste morre
// com a instrução do conserto, em vez de morder o disco real.
//
// `data/catalog.db` e `data/crawl.db` não entram na lista: nenhum helper da
// suíte os abre (catálogo e crawl só existem nos testes via caminho injetado).
import path from 'node:path';
import config from '../../src/config.js';
import { DEFAULT_CACHE_DB_PATH, DEFAULT_MAGNET_BANK_DB_PATH } from '../../src/config/helpers.js';

/**
 * Bancos que a suíte NUNCA pode abrir. Vêm das constantes de produção, não de
 * um literal: se o default do repositório mudar de lugar, a guarda acompanha.
 */
const REPO_DB_PATHS: readonly string[] = [DEFAULT_CACHE_DB_PATH, DEFAULT_MAGNET_BANK_DB_PATH];

/** O NTFS é case-insensitive: `DATA\Cache.DB` é o mesmo arquivo. */
function foldPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Absoluto + normalizado + (no Windows) dobrado para minúsculas. */
function canonical(candidate: string): string {
  return foldPath(path.resolve(String(candidate ?? '').trim()));
}

/**
 * `true` quando o caminho RESOLVIDO é um dos bancos do repositório.
 * Relativo (`data/cache.db`) é resolvido a partir do cwd, como o SQLite faria.
 */
export function isRepoDbPath(candidate: string): boolean {
  const raw = String(candidate ?? '').trim();
  if (!raw || raw === ':memory:') return false;
  const abs = canonical(raw);
  return REPO_DB_PATHS.some((repoPath) => canonical(repoPath) === abs);
}

/**
 * Devolve o caminho quando ele é seguro (ou `:memory:`/vazio) e LANÇA quando é
 * um banco do repositório. A mensagem cita os dois consertos possíveis porque o
 * erro aparece no meio de uma suíte que já quebrou por outro motivo.
 */
export function assertSafeTestDbPath(candidate: string, source: string): string {
  const raw = String(candidate ?? '').trim();
  if (!isRepoDbPath(raw)) return raw;
  throw new Error(
    `[db-guard] ${source}: recusado abrir o banco do REPOSITÓRIO (${raw}).\n`
    + 'Este teste rodaria contra o acervo real da máquina. Consertos:\n'
    + '  1) rode a suíte pelo runner (setup-env pré-carregado):\n'
    + '     node --test --import ./dist/test/setup-env.js <arquivos>\n'
    + '  2) ou aponte o banco para um diretório temporário antes de importar\n'
    + '     a config: CACHE_PERSIST=false, CACHE_DB_PATH=<tmp>/cache.db e\n'
    + '     MAGNET_BANK_DB_PATH=<tmp>/magnets.db (fs.mkdtempSync).',
  );
}

/** Caminhos que o processo usaria se nadasse; `:memory:` quando não persiste. */
export function testDbPaths(): { cache: string; magnets: string } {
  return {
    cache: config.cache.persist ? config.cache.dbPath : ':memory:',
    magnets: config.magnetBank.dbPath,
  };
}

/**
 * Portão dos helpers: recusa o processo quando a config viva aponta para o
 * repositório. `source` é o nome do helper — vai na mensagem para o conserto
 * ser direto em vez de "algum lugar dos testes".
 */
export function assertSafeTestDb(source: string): void {
  const { cache, magnets } = testDbPaths();
  assertSafeTestDbPath(cache, `${source}: cache`);
  assertSafeTestDbPath(magnets, `${source}: magnets`);
}
