// Fetch do CRAWL do Vaca com escalonamento: direto primeiro (reusa a sessão quente
// do host, 0 browser) e, SÓ com o desafio do Cloudflare, UMA resolução pelo
// FlareSolverr — que memoriza o cf_clearance e faz os fetches diretos seguintes
// voltarem a passar sem browser. Desde a troca para vaqueirofilmes1.com o fetch
// direto frio é desafiado (403) e o crawl pausava sozinho (error-streak). Roda na
// faixa única do FlareSolverr (`CRAWL_FLARE_SITES`) e a resolução conta UMA
// requisição no custo da página (`hooks.onRequest`).
type Hooks = { onRequest?: () => void };

/** Erro que o fetch direto lança ao ser desafiado: o gatilho do escalonamento. */
export const DIRECT_CHALLENGE_MSG = 'vacatorrent: desafio Cloudflare no caminho direto (crawl sem Flare)';

export interface CrawlFetchDeps {
  fetchTextDirect(url: string, accept?: string, hooks?: Hooks): Promise<string>;
  fetchTextViaFlare(url: string): Promise<string>;
  flareSessions: { clear(): void };
  isChallenge(body: string): boolean;
  unwrapSearchJson(body: string): string;
}

export function createFetchTextCrawl(deps: CrawlFetchDeps) {
  return async function fetchTextCrawl(url: string, accept = 'text/html,application/xhtml+xml', hooks?: Hooks): Promise<string> {
    try {
      return await deps.fetchTextDirect(url, accept, hooks);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== DIRECT_CHALLENGE_MSG) throw err;
    }
    hooks?.onRequest?.();
    const body = await deps.fetchTextViaFlare(url);
    if (deps.isChallenge(body)) {
      // O núcleo memoriza a sessão antes de devolver o HTML: não reaproveitar
      // cookies de uma solução que ainda é o desafio.
      deps.flareSessions.clear();
      throw new Error('vacatorrent: desafio Cloudflare não resolvido');
    }
    return accept.includes('application/json') ? deps.unwrapSearchJson(body) : body;
  };
}
