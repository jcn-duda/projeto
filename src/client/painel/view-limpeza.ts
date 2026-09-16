import { html, useState, useEffect } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { postAction } from './api.js';
import { getPainelState, subscribePainelToken } from './store.js';
import { pollOnce } from './poll.js';
import { formatBytes } from './fmt.js';

export interface ViewLimpezaProps {
  catalog?: Record<string, any>;
  conta?: Record<string, any>;
}

export interface DedupPreviewSummary {
  ok: boolean;
  reason: string | null;
  t1Groups: number;
  t2Groups: number;
  candidates: any[];
}

/**
 * Traduz o contrato REAL de `dedup-preview` (`{ ok, plan: { t1, t2 } }`, ou
 * `{ ok:false, reason }`) para o que a tela mostra. A versão anterior lia
 * `previewResult.scanned`, que não existe em nenhuma das respostas — a contagem
 * saía sempre 0. Grupos e alvos são contados de `plan`.
 */
export function dedupPreviewSummary(data: Record<string, any> | null | undefined): DedupPreviewSummary {
  if (!data || data.ok === false) {
    return { ok: false, reason: String(data?.reason || data?.error || 'erro'), t1Groups: 0, t2Groups: 0, candidates: [] };
  }
  const plan = data.plan || {};
  const t1 = Array.isArray(plan.t1) ? plan.t1 : [];
  const t2 = Array.isArray(plan.t2) ? plan.t2 : [];
  const candidates = [
    ...t1.flatMap((g: any) => (Array.isArray(g?.kill) ? g.kill : []).map((k: any) => ({ ...k, group: 'T1 (mesmo hash)', keep: g.keep }))),
    ...t2.flatMap((g: any) => (Array.isArray(g?.kill) ? g.kill : []).map((k: any) => ({ ...k, group: 'T2 (mesmo arquivo)', keep: g.keep }))),
  ];
  return { ok: true, reason: null, t1Groups: t1.length, t2Groups: t2.length, candidates };
}

export interface CatalogSummary {
  ok: boolean;
  reason: string | null;
  magnets: number;
  ready: number;
  knownWorks: number;
  unknownWorks: number;
  totalCount: number;
  totalBytes: number;
  byBucket: Record<string, { count: number; bytes: number }>;
}

const EMPTY_REPORT: Omit<CatalogSummary, 'ok' | 'reason'> = {
  magnets: 0, ready: 0, knownWorks: 0, unknownWorks: 0, totalCount: 0, totalBytes: 0, byBucket: {},
};

/**
 * Contrato real do bloco `catalog` / ação `catalog-report`:
 * `{ ok:true, report:{ magnets, ready, works:{known,unknown}, totals:{count,bytes}, byBucket } }`
 * ou `{ ok:false, reason, hint? }`. A versão anterior lia `cat.works`/`cat.magnets`
 * no topo do payload — nenhum desses campos existe ali, tudo saía 0.
 */
export function catalogSummary(data: Record<string, any> | null | undefined): CatalogSummary {
  if (!data) return { ok: false, reason: null, ...EMPTY_REPORT };
  if (data.ok === false) {
    const reason = String(data.reason || data.error || 'indisponível') + (data.hint ? ` — ${data.hint}` : '');
    return { ok: false, reason, ...EMPTY_REPORT };
  }
  const report = data.report || {};
  return {
    ok: true,
    reason: null,
    magnets: Number(report.magnets || 0),
    ready: Number(report.ready || 0),
    knownWorks: Number(report.works?.known || 0),
    unknownWorks: Number(report.works?.unknown || 0),
    totalCount: Number(report.totals?.count || 0),
    totalBytes: Number(report.totals?.bytes || 0),
    byBucket: report.byBucket || {},
  };
}

/**
 * Próximo estado de `catalogData` a partir do resultado de uma tentativa.
 * Falha de TRANSPORTE (HTTP 401/429/503 ou rede) NUNCA pode deixar o painel
 * preso em "Carregando catálogo…": sem relatório bom, grava `{ok:false, reason}`
 * e o botão "Atualizar Catálogo" continua disponível para o retry. Com relatório
 * bom já carregado, uma falha transitória o preserva (429 de refresh não apaga
 * o que estava na tela). HTTP 200 com `ok:false` do servidor é RESPOSTA (ex.:
 * conta do operador indisponível) e é usada como veio.
 */
export function nextCatalogState(
  prev: Record<string, any> | null,
  result: { ok: boolean; data?: Record<string, any>; error?: string },
): Record<string, any> {
  if (result.ok) {
    return result.data ?? { ok: false, reason: 'resposta vazia do servidor' };
  }
  const hasGoodReport = Boolean(prev && prev.ok !== false && prev.report);
  if (hasGoodReport) return prev as Record<string, any>;
  return { ok: false, reason: result.error || 'falha ao carregar catálogo', retry: true };
}

export function ViewLimpeza({ catalog, conta }: ViewLimpezaProps) {
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogData, setCatalogData] = useState<Record<string, any> | null>(catalog || null);
  const [previewResult, setPreviewResult] = useState<Record<string, any> | null>(null);

  const refreshCatalog = async (silent: boolean) => {
    const token = getPainelState().token;
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const res = await postAction(token, 'catalog-report');
      setCatalogData((prev) => nextCatalogState(prev, res));
      if (!res.ok && !silent) {
        setFeedback({ text: `Falha: ${res.error}`, ok: false });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // A aba monta e carrega o relatório sob demanda. `catalog` saiu do poll vital
  // rápido: `catalogStatusEnv()` varre as linhas do catálogo (O(rows)) e não
  // precisa rodar a cada refresh; a ação `catalog-report` já existe.
  //
  // O prefixo (`basePrefix()`) é fixo por carregamento de página — só o token
  // muda em runtime, e o canal `subscribePainelToken` recarrega com a
  // credencial nova. Se o prefixo mudar, é navegação nova (remonta a página).
  useEffect(() => {
    refreshCatalog(true);
    return subscribePainelToken(() => {
      refreshCatalog(true);
    });
  }, []);

  const summary = catalogSummary(catalogData);

  const handleSweepDead = async () => {
    if (!window.confirm('Executar varredura e remoção de torrents mortos no debrid ativo?')) return;
    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'sweep-dead', { confirm: true });
      if (res.ok && res.data.ok !== false) {
        const result = res.data.result || {};
        const varridos = Number(result.varridos || 0);
        const falhas = Number(result.falhas || 0);
        setFeedback({ text: `Varredura concluída: ${varridos} removido(s)${falhas ? ` · ${falhas} falha(s)` : ''}`, ok: true });
        await pollOnce(['conta', 'debrid', 'magnetdb']);
        await refreshCatalog(true);
      } else {
        setFeedback({ text: `Falha: ${res.ok ? (res.data.error || 'varredura indisponível') : res.error}`, ok: false });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDedupPreview = async () => {
    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'dedup-preview');
      if (res.ok) {
        const preview = dedupPreviewSummary(res.data);
        if (!preview.ok) {
          setFeedback({ text: `Falha: ${preview.reason}`, ok: false });
        } else {
          setPreviewResult({ t1Groups: preview.t1Groups, t2Groups: preview.t2Groups, candidates: preview.candidates });
          setFeedback({
            text: `Plano calculado: ${preview.candidates.length} alvo(s) em ${preview.t1Groups} grupo(s) T1 e ${preview.t2Groups} grupo(s) T2`,
            ok: true,
          });
        }
      } else {
        setFeedback({ text: `Falha: ${res.error}`, ok: false });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDedupApply = async () => {
    if (!window.confirm('Aplicar a deduplicação e remover releases duplicadas da conta?')) return;
    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'dedup-apply', { confirm: true });
      if (res.ok && res.data.ok !== false) {
        const removed = Number(res.data.deleted || 0);
        const falhas = Number(res.data.falhas || 0);
        setFeedback({ text: `Deduplicação aplicada: ${removed} duplicata(s) removida(s)${falhas ? ` · ${falhas} falha(s)` : ''}`, ok: true });
        setPreviewResult(null);
        await pollOnce(['conta', 'debrid', 'magnetdb']);
        await refreshCatalog(true);
      } else {
        setFeedback({ text: `Falha: ${res.ok ? (res.data.reason || 'ação indisponível') : res.error}`, ok: false });
      }
    } finally {
      setLoading(false);
    }
  };

  return html`
    <div>
      ${feedback ? html`
        <div class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}">
          ${feedback.text}
        </div>
      ` : null}

      <div class="painel-grid">
        <${Card} title="Varredura de Mortos">
          <p style="color: var(--muted); font-size: var(--font-floor); margin-bottom: var(--space-3);">
            Remove torrents com erro ou sem seeds retidos na conta de debrid.
          </p>
          <button
            class="painel-btn painel-btn-danger"
            disabled=${loading}
            onClick=${handleSweepDead}
          >
            Varrer e Limpar Mortos
          </button>
        </${Card}>

        <${Card}
          title="Catálogo da Conta (operador)"
          badge=${{ text: summary.ok ? 'OK' : 'INDISPONÍVEL', variant: summary.ok ? 'ok' : 'warn' }}
        >
          ${catalogData == null ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Carregando catálogo…</p>
          ` : !summary.ok ? html`
            <p style="color: var(--amber); font-size: var(--font-floor);">${summary.reason || 'indisponível'}</p>
            ${catalogData?.retry ? html`
              <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
                Falha de leitura — use "Atualizar Catálogo" para tentar de novo.
              </p>
            ` : null}
          ` : html`
            <${StatNumber} value=${summary.magnets} target=${summary.knownWorks} label="magnets / obras conhecidas" />
            <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
              Prontos: ${summary.ready} · Obras desconhecidas: ${summary.unknownWorks}
            </p>
            <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
              Total: ${summary.totalCount} magnets · ${formatBytes(summary.totalBytes)}
            </p>
          `}
          <button
            class="painel-btn"
            style="margin-top: var(--space-2);"
            disabled=${loading}
            onClick=${() => refreshCatalog(false)}
          >
            Atualizar Catálogo
          </button>
        </${Card}>

        <${Card} title="Deduplicação de Catálogo">
          <div style="display: flex; gap: var(--space-2); margin-top: var(--space-2);">
            <button
              class="painel-btn"
              disabled=${loading}
              onClick=${handleDedupPreview}
            >
              Prévia de Deduplicação
            </button>
            <button
              class="painel-btn painel-btn-danger"
              disabled=${loading || !previewResult}
              onClick=${handleDedupApply}
            >
              Aplicar Deduplicação
            </button>
          </div>
        </${Card}>
      </div>

      ${previewResult ? html`
        <div class="painel-grid" style="margin-top: var(--space-4);">
          <${Card} title="Prévia do Plano de Deduplicação">
            <p style="color: var(--muted); font-size: var(--font-floor); margin-bottom: var(--space-2);">
              Grupos T1 (mesmo hash): ${previewResult.t1Groups || 0} · Grupos T2 (mesmo arquivo): ${previewResult.t2Groups || 0} · Alvos: ${previewResult.candidates?.length || 0}
            </p>
            <table class="painel-table">
              <thead>
                <tr>
                  <th>Obra / ID</th>
                  <th>Motivo / Resolução</th>
                </tr>
              </thead>
              <tbody>
                ${(previewResult.candidates || []).slice(0, 10).map((c: any) => html`
                  <tr>
                    <td><code>${c.serviceId || c.id || c.hash || '—'}</code></td>
                    <td>${c.group || c.reason || 'duplicata de menor prioridade'}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          </${Card}>
        </div>
      ` : null}
    </div>
  `;
}
