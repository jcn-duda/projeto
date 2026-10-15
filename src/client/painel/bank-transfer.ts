// Exportar/importar o banco de magnets vivo pelo painel. As duas rotas são
// ARQUIVO em fluxo (`GET /magnet-bank-export`, `POST /magnet-bank-import`), não
// ações do `/dashboard-action.json` — ver `src/routes/magnet-bank-transfer.ts`.
// O token vai no header, como no resto do painel; por isso o download não é um
// `<a href>` simples (o link não carrega header) e passa por `fetch` + blob.
import { basePrefix } from './api.js';

export type TransferFailure = { ok: false; status: number; error: string };

async function failure(res: Response): Promise<TransferFailure> {
  if (res.status === 401) return { ok: false, status: 401, error: 'Token inválido ou não autorizado' };
  if (res.status === 503) return { ok: false, status: 503, error: 'Serviço de diagnóstico desativado pelo operador' };
  const body = await res.json().catch(() => ({} as Record<string, any>));
  return { ok: false, status: res.status, error: typeof body?.error === 'string' ? body.error : `Erro HTTP ${res.status}` };
}

/** Nome do arquivo do `Content-Disposition` (o servidor carimba data/hora). */
export function fileNameFrom(disposition: string | null): string {
  const match = String(disposition || '').match(/filename="?([^";]+)"?/i);
  return match ? match[1] : 'adom-magnets.ndjson.gz';
}

export async function exportBank(token: string): Promise<{ ok: true; blob: Blob; fileName: string } | TransferFailure> {
  if (!token) return { ok: false, status: 401, error: 'Token não configurado' };
  try {
    const res = await fetch(`${basePrefix()}/magnet-bank-export`, {
      cache: 'no-store',
      headers: { 'X-Indexer-Test-Token': token },
    });
    if (!res.ok) return failure(res);
    return { ok: true, blob: await res.blob(), fileName: fileNameFrom(res.headers.get('Content-Disposition')) };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'Falha de conexão com o servidor' };
  }
}

export interface ImportCounts { read: number; inserted: number; merged: number }
export interface ImportResult {
  ok: true;
  lines: number;
  rejected: number;
  magnets: ImportCounts;
  sources: ImportCounts;
  works: ImportCounts;
  ms: number;
}

export async function importBank(token: string, file: Blob, fileName = ''): Promise<ImportResult | TransferFailure> {
  if (!token) return { ok: false, status: 401, error: 'Token não configurado' };
  // O export é gzip; um `.ndjson` montado à mão entra cru.
  const gz = /\.gz$/i.test(fileName) || file.type === 'application/gzip';
  try {
    const res = await fetch(`${basePrefix()}/magnet-bank-import`, {
      method: 'POST',
      headers: {
        'X-Indexer-Test-Token': token,
        'Content-Type': gz ? 'application/gzip' : 'application/x-ndjson',
      },
      body: file,
    });
    if (!res.ok) return failure(res);
    return { ok: true, ...(await res.json()) } as ImportResult;
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || 'Falha de conexão com o servidor' };
  }
}

/** Resumo de uma linha para o operador. */
export function importSummary(r: ImportResult): string {
  const secs = (r.ms / 1000).toFixed(1);
  return `${r.magnets.inserted} magnet(s) novo(s), ${r.magnets.merged} já existia(m) e foi(ram) mesclado(s)`
    + ` · fontes ${r.sources.inserted}+${r.sources.merged} · obras ${r.works.inserted}+${r.works.merged}`
    + (r.rejected ? ` · ${r.rejected} linha(s) rejeitada(s)` : '')
    + ` · ${secs}s`;
}
