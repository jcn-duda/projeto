import { html, useState } from './vendor/preact.js';
import { Badge, Card, StatNumber, ProgressBar } from './kit.js';
import { useAction, actionError } from './action.js';
import { formatBytes } from './fmt.js';

export interface ViewCacheProps {
  cache?: Record<string, any>;
  metrics?: Record<string, any>;
}

/** Foto nativa do `streams.db` (`cache.native` do bloco `cache`): campos
 * opcionais de verdade — ausente no gateway fica ausente aqui ('—', nunca 0). */
export interface CacheNativeSummary {
  source: 'gateway';
  entries?: number;
  quota?: number;
  hit?: number;
  staleServed?: number;
  miss?: number;
  writes?: number;
  hitRate?: number | null;
  degraded?: boolean;
}

export interface CacheSummary {
  hits: number;
  misses: number;
  totalQueries: number;
  /**
   * Hit-rate EXIBIDO: o do gateway (`native.hitRate`) quando medido — quem
   * mede o SWR do corte é o `data/streams.db`; sem fonte nativa, o rate do L1
   * local só existe com consultas reais; sem NENHUMA é `null` — '—' no card,
   * nunca 0% inventado.
   */
  hitRate: number | null;
  hitRateSource: 'gateway' | 'local' | null;
  l1Entries: number;
  l1Max: number;
  l2Bytes: number;
  l2WalBytes: number;
  l2Pending: number;
  l2Enabled: boolean;
  persistent: boolean;
  native: CacheNativeSummary | null;
}

/** Contrato real: `cache.snapshot()` devolve `entries`/`maxEntries` (L1);
 * `l2Stats()` devolve `enabled`/`fileSizeBytes`/`walSizeBytes`/`pendingWrites`.
 * A versão anterior lia `max`/`l2.sizeBytes`/`l2.entries`, que não existem. */
export function cacheSummary(c: Record<string, any> | null | undefined): CacheSummary {
  const x = c || {};
  const hits = Number(x.hits || 0);
  const misses = Number(x.misses || 0);
  const totalQueries = hits + misses;
  const native = x.native && typeof x.native === 'object' && x.native.source === 'gateway'
    ? (x.native as CacheNativeSummary)
    : null;
  const gatewayRate = native != null
    && typeof native.hitRate === 'number' && Number.isFinite(native.hitRate)
    ? native.hitRate
    : null;
  const hitRate = gatewayRate != null ? gatewayRate : totalQueries > 0 ? hits / totalQueries : null;
  return {
    hits,
    misses,
    totalQueries,
    hitRate,
    hitRateSource: gatewayRate != null ? 'gateway' : totalQueries > 0 ? 'local' : null,
    l1Entries: Number(x.entries || 0),
    l1Max: Number(x.maxEntries || 0),
    l2Bytes: Number(x.l2?.fileSizeBytes || 0),
    l2WalBytes: Number(x.l2?.walSizeBytes || 0),
    l2Pending: Number(x.l2?.pendingWrites || 0),
    l2Enabled: Boolean(x.l2?.enabled ?? x.persistent),
    persistent: Boolean(x.persistent),
    native,
  };
}

/** Número com fonte ou '—' (honestidade: ausente nunca vira 0). */
function orDash(value: number | undefined | null): string | number {
  return typeof value === 'number' && Number.isFinite(value) ? value : '—';
}

/**
 * Cards de NÚMEROS da aba cache — função pura (sem hooks), o teste renderiza
 * direto. O hit-rate prefere o gateway (`cache.native.hitRate`, badge com a
 * nota "gateway"); sem NATIVO e sem consultas locais é '—' com badge neutro,
 * nunca 0% falso. O card "Store nativo (gateway)" só existe com a ponte viva;
 * os dois cards locais ficam rotulados para não se passarem pelo SWR.
 */
export function cacheCards(c: Record<string, any> | null | undefined) {
  const { hits, misses, totalQueries, hitRate, hitRateSource, l1Entries, l1Max, l2Bytes, l2WalBytes, l2Pending, l2Enabled, native } = cacheSummary(c);
  const pct = hitRate != null ? Math.round(hitRate * 100) : null;
  const badgeVariant: 'ok' | 'warn' | 'neutral' = pct == null ? 'neutral' : pct >= 70 ? 'ok' : 'warn';
  const badgeText = pct != null ? `${pct}% HIT${hitRateSource === 'gateway' ? ' (gateway)' : ''}` : '—';

  return html`
    <div class="painel-grid">
      <${Card}
        title="Hit-Rate e Eficiência"
        badge=${{ text: badgeText, variant: badgeVariant }}
      >
        <${StatNumber}
          value=${pct != null ? `${pct}%` : '—'}
          target=${totalQueries > 0 ? totalQueries : undefined}
          label=${pct != null ? (hitRateSource === 'gateway' ? 'hits (gateway)' : 'hits (local)') : 'sem medição'}
        />
        ${pct != null ? html`<${ProgressBar} percent=${pct} variant=${pct >= 70 ? 'ok' : 'warn'} />` : null}
        <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
          Misses: ${misses}
        </p>
      </${Card}>

      ${native ? html`
        <${Card}
          title="Store nativo (gateway)"
          badge=${{ text: native.degraded ? 'degradado' : 'streams.db', variant: native.degraded ? 'warn' : 'ok' }}
        >
          <${StatNumber} value=${orDash(native.entries)} target=${native.quota} label="entradas / cota" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            SWR servido stale: ${orDash(native.staleServed)} · escritas: ${orDash(native.writes)}
          </p>
          ${native.degraded ? html`
            <p style="margin-top: var(--space-1);">
              <${Badge} text="gateway degradado — estatísticas possivelmente parciais" variant="warn" />
            </p>
          ` : null}
        </${Card}>
      ` : null}

      <${Card} title="Ocupação L1 — local (Node)">
        <${StatNumber} value=${l1Entries} target=${l1Max} label="entradas" />
        <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
          Teto configurado: ${l1Max} slots voláteis
        </p>
      </${Card}>

      <${Card} title="Persistência L2 — local (Node)">
        <${StatNumber} value=${formatBytes(l2Bytes)} label="${l2Enabled ? 'banco ativo' : 'desligado'}" />
        <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
          WAL: ${formatBytes(l2WalBytes)} · ${l2Pending} escrita(s) pendente(s)
        </p>
      </${Card}>
    </div>
  `;
}

export function ViewCache({ cache, metrics }: ViewCacheProps) {
  const c = cache || {};
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const { pending, run } = useAction();
  const [targetNamespace, setTargetNamespace] = useState('');

  const handleClear = async (scope?: { namespace?: string; installation?: boolean }) => {
    const confirmMsg = scope?.namespace
      ? `Limpar todo o namespace "${scope.namespace}" do cache?`
      : scope?.installation
      ? 'Limpar o cache desta instalação de usuário?'
      : 'ATENÇÃO: Limpar todo o cache global do sistema?';
    const outcome = await run({
      action: 'clear-cache',
      body: scope ? { scope } : {},
      confirm: { message: confirmMsg, danger: true, confirmLabel: 'Limpar cache' },
      poll: ['cache', 'metrics'],
      successToast: (data) => {
        // F4.4a: o SWR do corte é o `streams.db` do gateway, limpo pela MESMA
        // ação. Sem separar os dois, o operador lia "0 entradas removidas"
        // (o L1 do Node nasce vazio no corte) e não sabia se o nativo foi
        // limpo — ou se sequer foi alcançado.
        const l1 = Number(data?.removed || 0);
        const native = Number(data?.native?.removed || 0);
        const parts: string[] = [];
        if (l1) parts.push(`${l1} no L1`);
        if (native) parts.push(`${native} no SWR nativo`);
        const resumo = parts.length ? ` (${parts.join(' + ')})` : '';
        const aviso = data?.native?.attempted === true && data?.native?.ok === false
          ? ' — o SWR nativo NÃO foi limpo'
          : '';
        return `Cache limpo com sucesso${resumo}${aviso}`;
      },
    });
    // O erro fica no card (feedback inline); o sucesso sai como toast global.
    const error = actionError(outcome);
    setFeedback(error ? { text: `Falha: ${error}`, ok: false } : null);
  };

  return html`
    <div>
      ${feedback ? html`
        <div class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}">
          ${feedback.text}
        </div>
      ` : null}

      ${cacheCards(c)}

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
                disabled=${pending || !targetNamespace.trim()}
                onClick=${() => handleClear({ namespace: targetNamespace.trim() })}
              >
                Limpar Namespace
              </button>
            </div>

            <div style="display: flex; gap: var(--space-2); margin-top: var(--space-2); border-top: 1px solid var(--border); padding-top: var(--space-3);">
              <button
                class="painel-btn painel-btn-danger"
                disabled=${pending}
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
