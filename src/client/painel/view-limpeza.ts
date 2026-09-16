import { html, useState } from './vendor/preact.js';
import { Card, StatNumber } from './kit.js';
import { postAction } from './api.js';
import { getPainelState } from './store.js';
import { pollOnce } from './poll.js';

export interface ViewLimpezaProps {
  catalog?: Record<string, any>;
  conta?: Record<string, any>;
}

export function ViewLimpeza({ catalog, conta }: ViewLimpezaProps) {
  const cat = catalog || {};
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<Record<string, any> | null>(null);

  const totalWorks = Number(cat.works || 0);
  const totalMagnets = Number(cat.magnets || 0);
  const duplicates = Number(cat.duplicates || 0);

  const handleSweepDead = async () => {
    if (!window.confirm('Executar varredura e remoção de torrents mortos no debrid ativo?')) return;
    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'sweep-dead', { confirm: true });
      if (res.ok) {
        setFeedback({ text: `Varredura concluída: ${JSON.stringify(res.data.result || res.data)}`, ok: true });
        await pollOnce(['conta', 'catalog', 'debrid']);
      } else {
        setFeedback({ text: `Falha: ${res.error}`, ok: false });
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
        const p = res.data.plan || {};
        const t1Kills = (p.t1 || []).flatMap((g: any) => (g.kill || []).map((k: any) => ({ ...k, group: 'T1 (mesmo hash)', keep: g.keep })));
        const t2Kills = (p.t2 || []).flatMap((g: any) => (g.kill || []).map((k: any) => ({ ...k, group: 'T2 (mesmo arquivo)', keep: g.keep })));
        const allCandidates = res.data.candidates || [...t1Kills, ...t2Kills];
        setPreviewResult({ ...res.data, candidates: allCandidates });
        setFeedback({ text: `Plano calculado: ${allCandidates.length} candidato(s) para deduplicação`, ok: true });
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
      if (res.ok) {
        setFeedback({ text: `Deduplicação aplicada: ${res.data.removed || 0} duplicata(s) removida(s)`, ok: true });
        setPreviewResult(null);
        await pollOnce(['conta', 'catalog', 'debrid']);
      } else {
        setFeedback({ text: `Falha: ${res.error}`, ok: false });
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

        <${Card} title="Catálogo e Duplicatas">
          <${StatNumber} value=${totalMagnets} target=${totalWorks} label="magnets / obras" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Duplicatas detectadas: ${duplicates}
          </p>
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
              Avaliados: ${previewResult.scanned || 0} · Duplicatas a remover: ${previewResult.candidates?.length || 0}
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
