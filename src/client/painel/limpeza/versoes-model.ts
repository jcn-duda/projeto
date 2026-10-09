// Modelo puro do card "Versões da mesma obra" (T3).
// Sem DOM, sem preact: dado → dado, testável direto.
import { bucketLabel } from '../limpeza-model.js';

export interface WorkVersionRow {
  serviceId: string;
  hash: string;
  filename: string;
  size: number;
  bucket: string;
  bucketName: string;
  foreignProof: string;
  ptProof: string;
  ready: boolean;
  active: boolean;
  protected: boolean;
  workTitle: string;
  season: number | null;
  episode: number | null;
}

export interface WorkVersionGroup {
  key: string;
  workTitle: string;
  season: number | null;
  episode: number | null;
  imdbId: string;
  keep: WorkVersionRow;
  kill: WorkVersionRow[];
  recoverableBytes: number;
}

export interface WorkVersionsPlan {
  ok: boolean;
  reason: string | null;
  groups: WorkVersionGroup[];
  withoutImdb: number;
}

function toRow(r: any): WorkVersionRow {
  return {
    serviceId: String(r?.serviceId ?? ''),
    hash: String(r?.hash || ''),
    filename: String(r?.filename || '') || '—',
    size: Number(r?.size || 0),
    bucket: String(r?.bucket || ''),
    bucketName: bucketLabel(String(r?.bucket || '')),
    foreignProof: String(r?.foreignProof || ''),
    ptProof: String(r?.ptProof || ''),
    ready: Boolean(r?.ready),
    active: Boolean(r?.active),
    protected: Boolean(r?.protected),
    workTitle: String(r?.workTitle || ''),
    season: r?.season != null ? Number(r.season) : null,
    episode: r?.episode != null ? Number(r.episode) : null,
  };
}

/** Contrato real de `catalog-versions`: `{ ok:true, plan:{ groups, withoutImdb } }`
 * ou `{ ok:false, reason }`. */
export function workVersionsPlan(data: Record<string, any> | null | undefined): WorkVersionsPlan {
  if (!data || data.ok === false) {
    const reason = String(data?.reason || data?.error || 'erro');
    return { ok: false, reason, groups: [], withoutImdb: 0 };
  }
  const plan = data.plan || {};
  const groups = (Array.isArray(plan.groups) ? plan.groups : []).map((g: any) => ({
    key: String(g?.key || ''),
    workTitle: String(g?.workTitle || ''),
    season: g?.season != null ? Number(g.season) : null,
    episode: g?.episode != null ? Number(g.episode) : null,
    imdbId: String(g?.imdbId || ''),
    keep: toRow(g?.keep),
    kill: (Array.isArray(g?.kill) ? g.kill : []).map(toRow),
    recoverableBytes: Number(g?.recoverableBytes || 0),
  }));
  return { ok: true, reason: null, groups, withoutImdb: Number(plan.withoutImdb || 0) };
}

/** Rótulo da temporada/episódio para o título do grupo. */
export function workGroupLabel(g: WorkVersionGroup): string {
  const parts = [g.workTitle || g.imdbId];
  if (g.season != null && g.episode != null) parts.push(`S${String(g.season).padStart(2, '0')}E${String(g.episode).padStart(2, '0')}`);
  else if (g.season != null) parts.push(`S${String(g.season).padStart(2, '0')}`);
  return parts.join(' · ');
}

/** Opções de filtro para o select de veredito. */
export function versionsFilterOptions(): Array<{ value: string; label: string }> {
  return [
    { value: '', label: 'Todos os grupos' },
    { value: 'foreign', label: 'Só com estrangeiro' },
  ];
}

/** Filtra grupos: "foreign" mantém só grupos onde pelo menos um kill tem
 * foreignProof. */
export function filterWorkGroups(groups: WorkVersionGroup[], filter: string): WorkVersionGroup[] {
  if (filter === 'foreign') return groups.filter((g) => g.kill.some((k) => k.foreignProof));
  return groups;
}
