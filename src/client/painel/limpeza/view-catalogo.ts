import { html, useState, useEffect } from '../vendor/preact.js';
import { Card, Badge, Feedback, ActionGroup, DataTable, Pager, Skeleton, type Column } from '../kit.js';
import { postAction } from '../api.js';
import { getPainelState, subscribePainelToken } from '../store.js';
import { useAction, actionError } from '../action.js';
import { formatBytes } from '../fmt.js';
import { SelectField, NumberField } from '../form.js';
import {
  catalogBucketOptions,
  catalogListRows,
  catalogPageCount,
  catalogPageSlice,
  catalogSelection,
  catalogVerdict,
  nextCatalogListState,
  toggleAllSelection,
  type CatalogListRow,
} from './catalogo-model.js';

/** Callback de clique que dispara a promise sem `void` espalhado no markup. */
export function fire(handler: () => Promise<void> | void): () => void {
  return () => {
    void handler();
  };
}

export interface CatalogNavProps {
  onChanged?: () => void;
}

/**
 * Navegação do catálogo (Etapa 4): varrer → listar → apagar. A listagem vem do
 * backend (`max`), mas a paginação é do CLIENTE — o servidor devolve o teto de
 * uma vez e a tela fatia. Toda linha é identificada pelo `serviceId` (o
 * `filename` é só rótulo), e o relatório da conta é atualizado por `onChanged`
 * depois de cada mutação.
 */
export function CatalogNav({ onChanged }: CatalogNavProps) {
  const [bucket, setBucket] = useState('');
  const [max, setMax] = useState(100);
  const [page, setPage] = useState(1);
  const [listData, setListData] = useState<Record<string, any> | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const { pending, run } = useAction();
  const loading = pending || listLoading;

  // Carregamento PRÓPRIO (fora do `run`): listar é leitura, não entra no toast
  // nem na trava de reentrada das destrutivas. `nextCatalogListState` garante
  // que uma falha de transporte não apague a lista já carregada.
  const loadList = async () => {
    const token = getPainelState().token;
    if (!token) return;
    setListLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'catalog-list', { bucket, max });
      setListData((prev) => nextCatalogListState(prev, res));
      setSelected([]);
      setPage(1);
      if (!res.ok) setFeedback({ text: `Falha ao listar: ${res.error}`, ok: false });
    } finally {
      setListLoading(false);
    }
  };

  // O prefixo é fixo por carregamento de página; só o token muda em runtime, e
  // o canal `subscribePainelToken` recarrega com a credencial nova (e zera a
  // seleção: os ids eram da conta anterior).
  useEffect(() => {
    void loadList();
    return subscribePainelToken(() => {
      setSelected([]);
      void loadList();
    });
  }, []);

  const deleteIds = async (ids: string[]) => {
    if (ids.length === 0) return;
    const outcome = await run({
      action: 'manual-delete',
      body: { serviceIds: ids },
      confirm: {
        title: 'Deleção manual',
        message: `Apagar ${ids.length} magnet(s) da conta? A ação é irreversível.`,
        confirmLabel: 'Apagar',
        danger: true,
      },
      poll: ['conta', 'debrid', 'magnetdb'],
      successToast: (data) => `Deleção manual: ${Number(data.deleted || 0)} magnet(s) removido(s)`,
    });
    if (outcome.ok) {
      setSelected([]);
      setFeedback(null);
      await loadList();
      onChanged?.();
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  const scan = async () => {
    const outcome = await run({
      action: 'catalog-scan',
      successToast: (data) => `Varredura concluída: ${Number(data.report?.scanned || 0)} magnet(s) lidos`,
    });
    if (outcome.ok) {
      setFeedback(null);
      await loadList();
      onChanged?.();
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  const rows = catalogListRows(listData);
  const selection = catalogSelection(rows, selected);
  const pages = catalogPageCount(rows.length);
  const pageRows = catalogPageSlice(rows, page);
  const allSelected = selection.eligible > 0 && selection.count === selection.eligible;

  const columns: Column<CatalogListRow>[] = [
    {
      header: '',
      render: (row) => html`
        <input
          type="checkbox"
          checked=${selected.includes(row.serviceId)}
          disabled=${Boolean(row.active) || loading}
          onChange=${() => toggle(row.serviceId)}
        />
      `,
    },
    { header: 'Release', render: (row) => html`<span class="painel-cell-release" title=${row.filename}>${row.filename}</span>` },
    { header: 'Tamanho', render: (row) => formatBytes(row.sizeBytes) },
    { header: 'Balde', render: (row) => row.bucketName },
    { header: 'Veredito', render: (row) => html`<${VerdictChip} row=${row} />` },
    {
      header: '',
      render: (row) => html`
        <button
          class="painel-btn painel-btn-danger"
          disabled=${loading || Boolean(row.active)}
          onClick=${fire(() => deleteIds([row.serviceId]))}
        >Apagar</button>
      `,
    },
  ];

  return html`
    <${Card} title="Navegação do Catálogo (operador)"
      badge=${listData == null ? undefined : { text: `${rows.length} LINHA(S)`, variant: 'neutral' as const }}>
      <${Feedback} entry=${feedback} />
      <div class="painel-form">
        <div class="painel-form-row">
          <${SelectField} label="Balde de áudio" value=${bucket} options=${catalogBucketOptions()} onChange=${setBucket} />
          <${NumberField} label="Máximo por listagem" value=${max} min=${1} max=${500} onChange=${setMax}
            hint="Teto (max) enviado ao backend" />
        </div>
        <div class="painel-btn-row">
          <button class="painel-btn" disabled=${loading} onClick=${fire(loadList)}>Listar</button>
          <button class="painel-btn painel-btn-accent" disabled=${loading} onClick=${fire(scan)}>Varrer conta</button>
        </div>
      </div>

      ${listData == null
        ? (listLoading
            ? html`<${Skeleton} block />`
            : html`<div class="painel-empty painel-empty-sm">Use "Listar" para carregar as linhas do catálogo.</div>`)
        : listData.ok === false
          ? html`<div class="painel-empty painel-empty-sm">${String(listData.reason || listData.error || 'catálogo indisponível')}</div>`
          : rows.length === 0
            ? html`<div class="painel-empty painel-empty-sm">Nenhuma linha neste balde.</div>`
            : html`
              <${DataTable} columns=${columns} rows=${pageRows} rowKey=${(row: CatalogListRow) => row.serviceId} />
              <${Pager} page=${page} pages=${pages} total=${rows.length}
                onPrev=${() => setPage(page - 1)} onNext=${() => setPage(page + 1)} />
              <${ActionGroup} title="Deleção manual" badge="IRREVERSÍVEL" danger
                note=${selection.count
                  ? `${selection.count} de ${selection.eligible} selecionado(s) · ${formatBytes(selection.bytes)}`
                  : 'nada selecionado'}>
                <div class="painel-btn-row">
                  <button class="painel-btn" disabled=${loading || selection.eligible === 0}
                    onClick=${() => setSelected(toggleAllSelection(rows, selected))}>
                    ${allSelected ? 'Limpar seleção' : 'Selecionar todos'}
                  </button>
                  <button class="painel-btn painel-btn-danger" disabled=${loading || selection.count === 0}
                    onClick=${fire(() => deleteIds(selected))}>
                    Apagar selecionados (${selection.count})
                  </button>
                </div>
              </${ActionGroup}>
            `}
    </${Card}>
  `;
}

/** Chip do veredito; `active`/`protected` viajam como flags sem afetar a cor. */
function VerdictChip({ row }: { row: CatalogListRow }) {
  const verdict = catalogVerdict(row);
  const flags = [row.active ? 'baixando' : '', row.protected ? 'protegido' : ''].filter(Boolean).join(' · ');
  return html`
    <span>
      <${Badge} text=${verdict.text} variant=${verdict.variant} />
      ${flags ? ` (${flags})` : null}
    </span>
  `;
}
