import { html } from './vendor/preact.js';
import { Card } from './kit.js';
import { configFieldId } from './config-model.js';

export interface ViewGateProps {
  gate?: Record<string, any>;
  /** Abre a aba dona do campo e foca o `cfg-field` correspondente. Sem o
   * callback o link ainda navega pelo hash VÁLIDO da aba (progressive
   * enhancement): nunca inventamos um hash de campo que o router ignoraria. */
  onNavigateField?: (key: string, owner: string | null) => void;
}

interface GateDiff {
  key: string;
  owner?: string;
  effective: any;
  envDefault: any;
}

/** Dono da chave: o backend manda `owner` por diff (e `fieldOwner` como mapa);
 * sem os dois, o Chupim é o fallback — é a config que origina o gate. */
function diffOwner(g: Record<string, any>, diff: GateDiff): string | null {
  if (typeof diff.owner === 'string' && diff.owner) return diff.owner;
  const map = g.fieldOwner;
  if (map && typeof map === 'object' && typeof map[diff.key] === 'string') return map[diff.key] as string;
  return null;
}

function ownerLabel(owner: string | null): string {
  return owner === 'colhedor' ? 'Colhedor' : 'Chupim';
}

export function ViewGate({ gate, onNavigateField }: ViewGateProps) {
  const g = gate || {};
  const isOverridden = g.isAutoFetchPauseAtOverridden;
  const effectivePauseAt = g.autoFetchPauseAt ?? '—';
  const envPauseAt = g.envAutoFetchPauseAt ?? '—';
  const diffs: GateDiff[] = Array.isArray(g.diffs) ? g.diffs : [];

  return html`
    <div class="painel-grid">
      <${Card}
        title="Gate de Ocupação (autoFetchPauseAt)"
        badge=${isOverridden ? { text: 'MODIFICADO AO VIVO', variant: 'warn' } : { text: 'PADRÃO .ENV', variant: 'ok' }}
      >
        <div class="painel-stat-group">
          <span class="painel-stat-num">${effectivePauseAt}</span>
          <span class="painel-stat-target">.env: ${envPauseAt}</span>
        </div>
        <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
          ${isOverridden
            ? 'O gate efetivo em memória diverge do padrão configurado no .env.'
            : 'O gate está operando com o valor padrão do .env sem overrides em memória.'}
        </p>
      </${Card}>

      <${Card} title="Status do Gate Autofetch">
        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Estado Operacional</span>
            <span class=${'painel-badge ' + (g.paused ? 'painel-badge-err' : 'painel-badge-ok')}>
              ${g.paused ? 'PAUSADO' : 'ATIVO'}
            </span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>Chaves Modificadas em Memória</span>
            <strong style="font-family: var(--font-mono);">${diffs.length}</strong>
          </div>
        </div>
      </${Card}>
    </div>

    ${diffs.length > 0 ? html`
      <${Card} title="Divergências ao Vivo vs .env (${diffs.length})">
        <p style="color: var(--muted); margin: 0 0 var(--space-2); font-size: var(--font-floor);">
          Cada chave abre a aba dona (Chupim ou Colhedor) e foca o campo correspondente.
        </p>
        <div class="painel-diff-list">
          ${diffs.map(
            (d) => {
              const owner = diffOwner(g, d);
              return html`
                <div class="painel-diff-item" key=${d.key}>
                  <span class="painel-diff-key">
                    <a
                      class="painel-diff-link"
                      href=${'#' + (owner || 'chupim')}
                      data-field-id=${configFieldId(d.key)}
                      title=${'Ir para o campo na configuração ao vivo do ' + ownerLabel(owner)}
                      onClick=${(e: any) => {
                        e.preventDefault();
                        onNavigateField?.(d.key, owner);
                      }}
                    >${d.key}</a>
                    <span class="painel-badge painel-badge-neutral">${ownerLabel(owner)}</span>
                  </span>
                  <div style="display: flex; gap: var(--space-3); align-items: center;">
                    <span style="color: var(--muted); font-size: var(--font-floor);">.env: ${String(d.envDefault)}</span>
                    <span class="painel-badge painel-badge-warn">ao vivo: ${String(d.effective)}</span>
                  </div>
                </div>
              `;
            },
          )}
        </div>
      </${Card}>
    ` : null}
  `;
}
