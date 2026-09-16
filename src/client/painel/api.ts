/**
 * Segmento de config em que a página foi aberta ("" na raiz, "/abc123" numa
 * install URL). Paridade com o dashboard legado (`core.ts:basePrefix`): sem
 * isto o /painel aberto a partir de uma instalação consultaria SEMPRE a conta
 * do .env, mesmo o handler existindo em /:userConfig/dashboard-status.json.
 */
export function prefixFromPathname(pathname: string): string {
  const match = String(pathname || '').match(/^\/(.+)\/painel\/?$/);
  return match ? '/' + match[1] : '';
}

export function basePrefix(): string {
  const pathname = typeof window !== 'undefined' ? window.location?.pathname : '';
  return prefixFromPathname(String(pathname || ''));
}

export async function fetchStatus(
  token: string,
  blocos?: string[],
): Promise<{ ok: true; data: Record<string, any> } | { ok: false; status: number; error: string }> {
  if (!token) {
    return { ok: false, status: 401, error: 'Token não configurado' };
  }

  const query = blocos && blocos.length > 0 ? `?blocos=${encodeURIComponent(blocos.join(','))}` : '';
  const url = `${basePrefix()}/dashboard-status.json${query}`;

  try {
    const res = await fetch(url, {
      // Diagnóstico é estado vivo: cache do browser serviria uma leitura velha.
      cache: 'no-store',
      headers: {
        'X-Indexer-Test-Token': token,
      },
    });

    if (res.status === 401) {
      return { ok: false, status: 401, error: 'Token inválido ou não autorizado' };
    }
    if (res.status === 503) {
      return { ok: false, status: 503, error: 'Serviço de diagnóstico desativado pelo operador' };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'Limite de concorrência atingido (429)' };
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, status: res.status, error: body.error || `Erro HTTP ${res.status}` };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'Falha de conexão com o servidor' };
  }
}

/**
 * Leitura do funil por item (`GET /stream-trace.json`). Mesmo prefixo de
 * instalação e mesmo token de header do `fetchStatus`: a rota existe nas duas
 * formas (`/stream-trace.json` e `/:userConfig/stream-trace.json`) e o
 * segmento de config tem que acompanhar o `/painel` aberto. O 404 da rota é
 * RESPOSTA VÁLIDA (`ok:true, found:false` = obra fora do cache), não erro de
 * transporte — tratá-lo como falha esconderia a causa real do "sumiu".
 */
export async function fetchStreamTrace(
  token: string,
  type: string,
  id: string,
  options: { live?: boolean } = {},
): Promise<{ ok: true; data: Record<string, any> } | { ok: false; status: number; error: string }> {
  if (!token) {
    return { ok: false, status: 401, error: 'Token não configurado' };
  }

  const query = `?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}${options.live ? '&mode=live' : ''}`;
  const url = `${basePrefix()}/stream-trace.json${query}`;

  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'X-Indexer-Test-Token': token,
      },
    });

    if (res.status === 401) {
      return { ok: false, status: 401, error: 'Token inválido ou não autorizado' };
    }
    if (res.status === 503) {
      return { ok: false, status: 503, error: 'Serviço de diagnóstico desativado pelo operador' };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'Outro diagnóstico em andamento; tente de novo em instantes' };
    }

    const data = await res.json().catch(() => ({}));
    // 404 é resposta do handler (`found:false`), não falha: preserva o corpo.
    if (res.status === 404 && data && data.ok === true) {
      return { ok: true, data };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error || `Erro HTTP ${res.status}` };
    }
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'Falha de conexão com o servidor' };
  }
}

/**
 * Teste de UM indexador (`GET /test-indexer.json`). Mesmo prefixo de instalação
 * e mesmo token de header do `fetchStatus`; o backend valida o id contra o
 * catálogo (400 `indexador desconhecido`) e devolve o resultado do `jackett.test`
 * — o MESMO caminho da busca real, inclusive a resolução do magnet. Só roda no
 * clique; nada sonda sozinho.
 */
export async function fetchTestIndexer(
  token: string,
  id: string,
  options: { q?: string; type?: 'movie' | 'series' } = {},
): Promise<{ ok: true; data: Record<string, any> } | { ok: false; status: number; error: string }> {
  if (!token) {
    return { ok: false, status: 401, error: 'Token não configurado' };
  }

  const params = new URLSearchParams();
  params.set('id', id);
  if (options.q) params.set('q', options.q);
  params.set('type', options.type === 'series' ? 'series' : 'movie');
  const url = `${basePrefix()}/test-indexer.json?${params.toString()}`;

  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'X-Indexer-Test-Token': token,
      },
    });

    if (res.status === 401) {
      return { ok: false, status: 401, error: 'Token inválido ou não autorizado' };
    }
    if (res.status === 503) {
      return { ok: false, status: 503, error: 'Serviço de diagnóstico desativado pelo operador' };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'Limite de concorrência atingido (429)' };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error || `Erro HTTP ${res.status}` };
    }
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'Falha de conexão com o servidor' };
  }
}

export async function postAction(
  token: string,
  action: string,
  bodyData: Record<string, any> = {},
): Promise<
  | { ok: true; data: Record<string, any> }
  | { ok: false; status: number; error: string; data?: Record<string, any> }
> {
  if (!token) {
    return { ok: false, status: 401, error: 'Token não configurado' };
  }

  try {
    const res = await fetch(`${basePrefix()}/dashboard-action.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Indexer-Test-Token': token,
      },
      body: JSON.stringify({ action, ...bodyData }),
    });

    if (res.status === 401) {
      return { ok: false, status: 401, error: 'Token inválido ou não autorizado' };
    }
    if (res.status === 503) {
      return { ok: false, status: 503, error: 'Serviço de diagnóstico desativado' };
    }
    if (res.status === 429) {
      return { ok: false, status: 429, error: 'Limite de concorrência atingido (429)' };
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // O corpo inteiro segue no `data`: ações que devolvem `reason`/`fix`
      // (ex.: harvester-debrid-set) precisam do motivo, não só do `error`.
      return { ok: false, status: res.status, error: data.error || `Erro HTTP ${res.status}`, data };
    }

    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'Falha ao executar ação' };
  }
}
