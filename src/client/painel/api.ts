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

export async function postAction(
  token: string,
  action: string,
  bodyData: Record<string, any> = {},
): Promise<{ ok: true; data: Record<string, any> } | { ok: false; status: number; error: string }> {
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
      return { ok: false, status: res.status, error: data.error || `Erro HTTP ${res.status}` };
    }

    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'Falha ao executar ação' };
  }
}
