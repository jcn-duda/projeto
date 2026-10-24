import { html, useState } from '../vendor/preact.js';
import { Card, Badge, Feedback, ActionGroup, DataTable, Pager, type Column } from '../kit.js';
import { postAction } from '../api.js';
import { getPainelState } from '../store.js';
import { useAction, actionError } from '../action.js';
import { formatBytes } from '../fmt.js';
import { SelectField } from '../form.js';
import {
  workVersionsPlan,
  workGroupLabel,
  versionsFilterOptions,
  filterWorkGroups,
  type WorkVersionGroup,
  type WorkVersionRow,
  type WorkVersionsPlan,
} from './versoes-model.js';
import { fire } from './view-catalogo.js';

export interface WorkVersionsCardProps {
  onChanged?: () => void;
}

const MUTED_LINE = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);';
const PAGE_SIZE = 5;

interface VersionRow {
  serviceId: string;
  filename: string;
  size: number;
  bucketName: string;
  verdictText: string;
  verdictVariant: 'ok' | 'err' | 'neutral';
  isKeep: boolean;
  active: boolean;
  protected: boolean;
  foreignProof: string;
  ptProof: string;
}

function verdictLabel(r: WorkVersionRow): string {
  if (r.foreignProof) return 'estrangeiro';
  if (r.ptProof) return 'PT';
  return r.bucketName || 'sem prova';
}
function verdictVariant(r: WorkVersionRow): 'ok' | 'err' | 'neutral' {
  if (r.foreignProof) return 'err';
  if (r.ptProof) return 'ok';
  return 'neutral';
}

/**
 * Card "Versões da mesma obra" (T3): agrupa por imdbId + temporada + episódio.
 * Cada grupo mostra o keep (sobrevivente) e os kills sugeridos. O operador
 * escolhe quais apagar (os kills já vêm marcados por padrão). A ação usa
 * `manual-delete` — irreversível, com confirm.
 */
export function WorkVersionsCard({ onChanged }: WorkVersionsCardProps) {
  const [plan, setPlan] = useState<WorkVersionsPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const { pending, run } = useAction();

  const loadVersions = async () => {
    const token = getPainelState().token;
    if (!token) return;
    setFeedback(null);
    try {
      const res = await postAction(token, 'catalog-versions');
      const p = workVersionsPlan(res.ok ? res.data : null);
      if (!p.ok) {
        setFeedback({ text: `Falha: ${p.reason}`, ok: false });
        return;
      }
      setPlan(p);
      // Pré-seleciona os kills sugeridos.
      const pre = new Set<string>();
      for (const g of p.groups) for (const k of g.kill) pre.add(k.serviceId);
      setSelected(pre);
      setPage(1);
      setFeedback({ text: `Versões: ${p.groups.length} grupo(s) · ${p.withoutImdb} sem obra`, ok: true });
    } catch (err) {
      setFeedback({ text: `Falha: ${String(err)}`, ok: false });
    }
  };

  const deleteSelected = async () => {
    if (scopedIds.length === 0) return;
    const outcome = await run({
      action: 'manual-delete',
      body: { serviceIds: scopedIds },
      confirm: {
        title: 'Apagar versões',
        message: `Apagar ${scopedIds.length} versão(ões) da conta? A ação é irreversível.`,
        confirmLabel: 'Apagar',
        danger: true,
      },
      poll: ['conta', 'debrid', 'magnetdb'],
      successToast: (data) => `Versões removidas: ${Number(data.deleted || 0)} magnet(s)`,
    });
    if (outcome.ok) {
      setSelected(new Set());
      setFeedback(null);
      setPlan(null);
      onChanged?.();
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const groups = plan ? filterWorkGroups(plan.groups, filter) : [];
  // Escopo visível: só os kills dos grupos filtrados entram na
  // contagem e no envio do delete — marcações de grupos ocultos são ignoradas.
  const visibleIds = new Set<string>();
  for (const g of groups) for (const k of g.kill) visibleIds.add(k.serviceId);
  const scopedIds = [...selected].filter((id) => visibleIds.has(id));
  const scopedBytes = scopedIds.reduce((sum, id) => {
    for (const g of groups) for (const k of g.kill) if (k.serviceId === id) return sum + k.size;
    return sum;
  }, 0);
  const totalRecoverable = groups.reduce((sum, g) => sum + g.recoverableBytes, 0);
  const pages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pages);
  const pageGroups = groups.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  const columns: Column<VersionRow>[] = [
    { header: '', render: (row) => row.isKeep
      ? html`<${Badge} text="FICA" variant="ok" />`
      : html`<input type="checkbox" checked=${selected.has(row.serviceId)} disabled=${row.active || row.protected} onChange=${() => toggle(row.serviceId)} />` },
    { header: 'Release', render: (row) => html`<span class="painel-cell-release" title=${row.filename}>${row.filename}</span>` },
    { header: 'Tamanho', render: (row) => formatBytes(row.size) },
    { header: 'Balde', render: (row) => row.bucketName },
    { header: 'Veredito', render: (row) => html`<${Badge} text=${row.verdictText} variant=${row.verdictVariant} />` },
  ];

  return html`
    <${Card} title="Versões da mesma obra"
      badge=${plan ? { text: `${groups.length} GRUPO(S)`, variant: groups.length > 0 ? 'warn' as const : 'ok' as const } : undefined}>
      <${Feedback} entry=${feedback} />
      <div class="painel-form-row">
        <${SelectField} label="Filtro" value=${filter} options=${versionsFilterOptions()}
          onChange=${(v: string) => {
            setFilter(v);
            setPage(1);
            // Re-marca os kills sugeridos dos grupos que passam no filtro.
            const next = filterWorkGroups(plan?.groups || [], v);
            const pre = new Set<string>();
            for (const g of next) for (const k of g.kill) pre.add(k.serviceId);
            setSelected(pre);
          }} />
      </div>
      <div class="painel-btn-row">
        <button class="painel-btn" disabled=${pending} onClick=${fire(loadVersions)}>Calcular versões</button>
      </div>

      ${plan == null
        ? html`<p style=${MUTED_LINE}>Rode "Calcular versões" para agrupar por obra.</p>`
        : groups.length === 0
          ? html`<p style=${MUTED_LINE}>Nenhum grupo encontrado.</p>`
          : html`
            <p style=${MUTED_LINE}>${groups.length} grupo(s) · ${formatBytes(totalRecoverable)} recuperáveis · ${plan.withoutImdb} sem obra</p>
            ${pageGroups.map((g) => {
              const rows: VersionRow[] = [
                { serviceId: g.keep.serviceId, filename: g.keep.filename, size: g.keep.size, bucketName: g.keep.bucketName, verdictText: verdictLabel(g.keep), verdictVariant: verdictVariant(g.keep), isKeep: true, active: g.keep.active, protected: g.keep.protected, foreignProof: g.keep.foreignProof, ptProof: g.keep.ptProof },
                ...g.kill.map((k) => ({ serviceId: k.serviceId, filename: k.filename, size: k.size, bucketName: k.bucketName, verdictText: verdictLabel(k), verdictVariant: verdictVariant(k), isKeep: false, active: k.active, protected: k.protected, foreignProof: k.foreignProof, ptProof: k.ptProof })),
              ];
              return html`
                <div style="margin-bottom: var(--space-3);">
                  <h4 style="margin: 0 0 var(--space-1); font-size: var(--font-floor); font-weight: 700;">
                    ${workGroupLabel(g)}
                    <span class="painel-badge painel-badge-neutral" style="margin-left: var(--space-2);">${formatBytes(g.recoverableBytes)} recuperáveis</span>
                  </h4>
                  <${DataTable} columns=${columns} rows=${rows} rowKey=${(r: VersionRow) => r.serviceId} />
                </div>
              `;
            })}
            <${Pager} page=${clampedPage} pages=${pages} total=${groups.length} unit="grupo"
              onPrev=${() => setPage(clampedPage - 1)} onNext=${() => setPage(clampedPage + 1)} />
            <${ActionGroup} title="Apagar versões selecionadas" badge="IRREVERSÍVEL" danger
              note=${scopedIds.length ? `${scopedIds.length} selecionada(s) · ${formatBytes(scopedBytes)}` : 'nada selecionado'}>
              <div class="painel-btn-row">
                <button class="painel-btn painel-btn-danger" disabled=${pending || scopedIds.length === 0}
                  onClick=${fire(deleteSelected)}>
                  Apagar selecionadas (${scopedIds.length} · ${formatBytes(scopedBytes)})
                </button>
              </div>
            </${ActionGroup}>
          `}
    </${Card}>
  `;
}
