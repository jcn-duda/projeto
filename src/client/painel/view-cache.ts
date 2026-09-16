import { html, useState } from './vendor/preact.js';
import { Card, StatNumber, ProgressBar } from './kit.js';
import { postAction } from './api.js';
import { getPainelState } from './store.js';
import { pollOnce } from './poll.js';
import { formatBytes } from './fmt.js';

export interface ViewCacheProps {
  cache?: Record<string, any>;
  metrics?: Record<string, any>;
}

export interface CacheSummary {
  hits: number;
  misses: number;
  totalQueries: number;
  hitRate: number;
  l1Entries: number;
  l1Max: number;
  l2Bytes: number;
  l2WalBytes: number;
  l2Pending: number;
  l2Enabled: boolean;
  persistent: boolean;
  swrServed: number;
}

/** Contrato real: `cache.snapshot()` devolve `entries`/`maxEntries` (L1);
 * `l2Stats()` devolve `enabled`/`fileSizeBytes`/`walSizeBytes`/`pendingWrites`.
 * A versão anterior lia `max`/`l2.sizeBytes`/`l2.entries`, que não existem. */
export function cacheSummary(c: Record<string, any> | null | undefined): CacheSummary {
  const x = c || {};
  const hits = Number(x.hits || 0);
  const misses = Number(x.misses || 0);
  const totalQueries = hits + misses;
  return {
    hits,
    misses,
    totalQueries,
    hitRate: totalQueries > 0 ? hits / totalQueries : 0,
    l1Entries: Number(x.entries || 0),
    l1Max: Number(x.maxEntries || 0),
    l2Bytes: Number(x.l2?.fileSizeBytes || 0),
    l2WalBytes: Number(x.l2?.walSizeBytes || 0),
    l2Pending: Number(x.l2?.pendingWrites || 0),
    l2Enabled: Boolean(x.l2?.enabled ?? x.persistent),
    persistent: Boolean(x.persistent),
    swrServed: Number(x.swrServed || 0),
  };
}

export function ViewCache({ cache, metrics }: ViewCacheProps) {
  const c = cache || {};
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [targetNamespace, setTargetNamespace] = useState('');

  const { hits, misses, totalQueries, l1Entries, l1Max, l2Bytes, l2WalBytes, l2Pending, l2Enabled } = cacheSummary(c);
  const hitRate = totalQueries > 0 ? Math.round((hits / totalQueries) * 100) : 0;

  const handleClear = async (scope?: { namespace?: string; installation?: boolean }) => {
    const confirmMsg = scope?.namespace
      ? `Limpar todo o namespace "${scope.namespace}" do cache?`
      : scope?.installation
      ? 'Limpar o cache desta instalação de usuário?'
      : 'ATENÇÃO: Limpar todo o cache global do sistema?';
    if (!window.confirm(confirmMsg)) return;

    const token = getPainelState().token;
    if (!token) return;

    setLoading(true);
    setFeedback(null);
    try {
      const res = await postAction(token, 'clear-cache', {
        confirm: true,
        ...(scope ? { scope } : {}),
      });
      if (res.ok) {
        setFeedback({ text: `Cache limpo com sucesso (${res.data.removed} entradas removidas)`, ok: true });
        await pollOnce(['cache', 'metrics']);
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
        <${Card}
          title="Hit-Rate e Eficiência"
          badge=${{
            text: `${hitRate}% HIT`,
            variant: hitRate >= 70 ? 'ok' : hitRate > 0 ? 'warn' : 'neutral',
          }}
        >
          <${StatNumber} value=${hits} target=${totalQueries} label="${hitRate}% hits" />
          <${ProgressBar} percent=${hitRate} variant=${hitRate >= 70 ? 'ok' : 'warn'} />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Misses: ${misses} · SWR Servidos: ${c.swrServed || 0}
          </p>
        </${Card}>

        <${Card} title="Ocupação L1 (Memória)">
          <${StatNumber} value=${l1Entries} target=${l1Max} label="entradas" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Teto configurado: ${l1Max} slots voláteis
          </p>
        </${Card}>

        <${Card} title="Persistência L2 (Disco / SQLite)">
          <${StatNumber} value=${formatBytes(l2Bytes)} label="${l2Enabled ? 'banco ativo' : 'desligado'}" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            WAL: ${formatBytes(l2WalBytes)} · ${l2Pending} escrita(s) pendente(s)
          </p>
        </${Card}>
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${Card} title="Gerenciamento e Limpeza Seletiva">
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <div style="display: flex; gap: var(--space-2); align-items: center;">
              <input
                type="text"
                class="painel-token-input"
                placeholder="Ex: streams, meta, imdb..."
                value=${targetNamespace}
                onInput=${(e: any) => setTargetNamespace(e.target.value)}
              />
              <button
                class="painel-btn"
                disabled=${loading || !targetNamespace.trim()}
                onClick=${() => handleClear({ namespace: targetNamespace.trim() })}
              >
                Limpar Namespace
              </button>
            </div>

            <div style="display: flex; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--border); padding-top: var(--space-3);">
              <button
                class="painel-btn painel-btn-danger"
                disabled=${loading}
                onClick=${() => handleClear()}
              >
                Limpar Todo o Cache Global
              </button>
            </div>
          </div>
        </${Card}>
      </div>
    </div>
  `;
}
