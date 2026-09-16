export async function fetchStatus(
  token: string,
  blocos?: string[],
): Promise<{ ok: true; data: Record<string, any> } | { ok: false; status: number; error: string }> {
  if (!token) {
    return { ok: false, status: 401, error: 'Token não configurado' };
  }

  const query = blocos && blocos.length > 0 ? `?blocos=${encodeURIComponent(blocos.join(','))}` : '';
  const url = `/dashboard-status.json${query}`;

  try {
    const res = await fetch(url, {
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
