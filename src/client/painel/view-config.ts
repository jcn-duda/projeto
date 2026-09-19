import { html, useState, useEffect } from './vendor/preact.js';
import { Card } from './kit.js';
import { useAction, actionError } from './action.js';
import { ToggleField, NumberField, Button, FormActions } from './form.js';
import {
  configSnapshot,
  configRowsFromSnapshot,
  configGroups,
  configFormSeed,
  configDiff,
  validateConfigForm,
  configFieldId,
  type ConfigSnapshot,
  type ConfigRow,
  type ConfigValidationError,
} from './config-model.js';

/** Erros de validação devolvidos pelo backend (`errors: string[]`). O cliente
 * valida antes do POST, mas o servidor é a autoridade (clamps/patch) e a recusa
 * dele precisa aparecer — não pode virar só "validation_error". A chave sai da
 * mensagem quando citada entre aspas; sem ela a linha não aponta campo. */
export function configBackendErrors(data: Record<string, any> | null | undefined): ConfigValidationError[] {
  const list = Array.isArray(data?.errors) ? data!.errors : [];
  return list
    .map((raw: unknown) => String(raw ?? '').trim())
    .filter(Boolean)
    .map((message: string, index: number) => {
      const quoted = message.match(/"([^"]+)"/);
      return {
        key: quoted ? quoted[1] : `backend-${index}`,
        label: 'Validação do servidor',
        reason: 'backend' as const,
        message,
      };
    });
}

/**
 * Card "Configuração ao vivo" reutilizado por Chupim e Colhedor. É 100%
 * dirigido pelo payload de `*-config-get`: as linhas nascem do schema que o
 * backend devolve (`configRowsFromSnapshot`) e nenhum campo é hardcoded aqui —
 * um knob novo no servidor aparece no formulário sem tocar este módulo.
 *
 * Três invariantes que vêm do `config-model` e não podem ser quebradas aqui:
 * - o diff é SÓ o delta contra `effective` (aplicar sem mudança não existe);
 * - validação local usa type/min/max do schema antes do POST;
 * - campo ausente nunca vira envDefault/0/false (o controle fica bloqueado).
 */

/** Rótulos de grupo do schema. Grupo novo fora do mapa cai no próprio id — a
 * lista de CAMPOS continua vindo do backend; só a legenda é curada. */
const GROUP_LABELS: Record<string, string> = {
  sources: 'Fontes',
  volume: 'Volume',
  protection: 'Proteção',
  lifecycle: 'Ciclo de vida',
  traffic: 'Tráfego',
  queue: 'Fila',
  seed: 'Sementes',
};

function groupLabel(group: string | null): string {
  if (!group) return 'Geral';
  return GROUP_LABELS[group] || group;
}

function isEditableRow(row: ConfigRow): boolean {
  return row.inSchema && (row.type === 'boolean' || row.type === 'number');
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? 'ligado' : 'desligado';
  return String(value);
}

/** Seed só das linhas editáveis: drift (`paused`, `pausedSince`, campos que o
 * schema não declara) não entra no formulário nem no patch. */
function seedEditable(rows: ConfigRow[]): Record<string, unknown> {
  return configFormSeed(rows.filter(isEditableRow));
}

function hintFor(row: ConfigRow): string | undefined {
  const parts: string[] = [];
  if (row.unit) parts.push('(' + row.unit + ')');
  if (row.description) parts.push(row.description);
  if (row.overridden && row.hasEnvDefault) parts.push('padrão .env: ' + formatValue(row.envDefault));
  else if (row.overridden) parts.push('sobreposto ao vivo nesta instância');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function rowsFrom(snapshot: ConfigSnapshot | null): ConfigRow[] {
  return configRowsFromSnapshot(snapshot);
}

export interface LiveConfigCardProps {
  title: string;
  getAction: string;
  setAction: string;
  resetAction: string;
  /** Blocos de status recarregados DEPOIS de set/reset (o GET do config não
   * entra no poll: é lido sob demanda quando a aba abre). */
  pollBlocks: string[];
  description?: string;
}

export function LiveConfigCard(props: LiveConfigCardProps) {
  const { title, getAction, setAction, resetAction, pollBlocks, description } = props;
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [errors, setErrors] = useState<ConfigValidationError[]>([]);
  const { pending, run } = useAction();

  const rows = rowsFrom(snapshot);
  const editable = rows.filter(isEditableRow);
  const drift = rows.filter((row) => !row.inSchema);
  const groups = configGroups(editable);
  const changed = configDiff(form, snapshot?.effective || {});
  const changedCount = changed.changedKeys.length;

  const seedFrom = (next: ConfigSnapshot) => {
    setSnapshot(next);
    setForm(seedEditable(rowsFrom(next)));
    setErrors([]);
  };

  const load = async () => {
    setErrors([]);
    setFeedback(null);
    const outcome = await run({ action: getAction, failureFallback: 'não foi possível carregar a configuração' });
    if (!outcome.ok) {
      const error = actionError(outcome);
      if (error) setFeedback({ text: `Falha ao carregar: ${error}`, ok: false });
      return;
    }
    const next = configSnapshot(outcome.data);
    if (!next) {
      setFeedback({ text: 'Resposta sem bloco de configuração.', ok: false });
      return;
    }
    seedFrom(next);
    setFeedback(null);
  };

  // Sob demanda: a leitura acontece quando a aba monta, nunca no poll de
  // status (o GET de config não está nos VITAL_BLOCKS e não deve entrar).
  useEffect(() => {
    void load();
  }, []);

  const setField = (key: string, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const discard = () => {
    if (!snapshot) return;
    setForm(seedEditable(rowsFrom(snapshot)));
    setErrors([]);
    setFeedback(null);
  };

  const apply = async () => {
    if (!snapshot) return;
    // Aplica SÓ o delta: `changedKeys` vazio não gera POST (botão desabilitado).
    const { patch, changedKeys } = configDiff(form, snapshot.effective);
    if (changedKeys.length === 0) {
      setFeedback({ text: 'Nenhuma alteração para aplicar.', ok: false });
      return;
    }
    const validation = validateConfigForm(patch, snapshot.schema);
    if (!validation.ok) {
      setErrors(validation.errors);
      setFeedback({ text: 'Corrija os campos destacados antes de aplicar.', ok: false });
      return;
    }
    setErrors([]);
    const outcome = await run({
      action: setAction,
      body: { patch },
      poll: pollBlocks,
      successToast: `Configuração aplicada (${changedKeys.length} campo(s))`,
      failureFallback: 'não foi possível aplicar a configuração',
    });
    if (outcome.ok) {
      const data = outcome.data;
      const next: ConfigSnapshot = {
        ...snapshot,
        effective: asRecord(data.effective) || snapshot.effective,
        overriddenKeys: Array.isArray(data.overriddenKeys)
          ? data.overriddenKeys.map((key: unknown) => String(key))
          : snapshot.overriddenKeys,
      };
      seedFrom(next);
      setFeedback({ text: 'Configuração salva ao vivo.', ok: true });
      return;
    }
    // A recusa autoritativa do servidor (400 com `errors[]`) vira linha de erro
    // por campo, como a validação local — sem isso o operador só via o genérico
    // "validation_error".
    const backendErrors = configBackendErrors(outcome.data);
    if (backendErrors.length > 0) {
      setErrors(backendErrors);
      setFeedback({ text: `Recusado pelo servidor: ${backendErrors.map((e) => e.message).join(' ')}`, ok: false });
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha ao aplicar: ${error}`, ok: false });
  };

  const reset = async () => {
    const outcome = await run({
      action: resetAction,
      // Reset é destrutivo no backend (DESTRUCTIVE_ACTIONS): usa o modal real,
      // nunca `window.confirm`, e `run` injeta `confirm: true` no corpo.
      confirm: {
        title: 'Restaurar configuração ao vivo',
        message: 'Restaurar todos os parâmetros ao padrão do .env?',
        detail: 'Os ajustes feitos no painel serão descartados e a configuração volta imediatamente ao valor do .env.',
        confirmLabel: 'Restaurar padrões',
        danger: true,
      },
      poll: pollBlocks,
      successToast: 'Padrões do .env restaurados',
      failureFallback: 'não foi possível restaurar a configuração',
    });
    if (outcome.ok) {
      const base: ConfigSnapshot = snapshot || { effective: {}, envDefaults: {}, overriddenKeys: [], schema: [] };
      const next: ConfigSnapshot = {
        ...base,
        effective: asRecord(outcome.data.effective) || base.effective,
        overriddenKeys: [],
      };
      seedFrom(next);
      setFeedback({ text: 'Configuração restaurada ao .env.', ok: true });
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha ao restaurar: ${error}`, ok: false });
  };

  const renderControl = (row: ConfigRow) => {
    if (!row.hasValue) {
      // Ausência é preservada: não inventa 0/false nem rebatiza o envDefault.
      return html`
        <div class="painel-field">
          <span class="painel-field-label">${row.label}</span>
          <span class="painel-field-hint">Sem valor no snapshot — não editável aqui.</span>
        </div>
      `;
    }
    if (row.type === 'boolean') {
      return html`
        <${ToggleField}
          key=${row.key}
          label=${row.label}
          checked=${Boolean(form[row.key])}
          hint=${hintFor(row)}
          onChange=${(next: boolean) => setField(row.key, next)}
        />
      `;
    }
    const raw = form[row.key];
    const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
    return html`
      <${NumberField}
        key=${row.key}
        label=${row.label}
        value=${Number.isFinite(numeric) ? numeric : 0}
        min=${row.min ?? undefined}
        max=${row.max ?? undefined}
        step=${row.step ?? undefined}
        hint=${hintFor(row)}
        onChange=${(next: number) => setField(row.key, next)}
      />
    `;
  };

  return html`
    <${Card}
      title=${title}
      badge=${{ text: changedCount > 0 ? `${changedCount} alteração(ões)` : 'em dia', variant: changedCount > 0 ? 'warn' : 'ok' }}
    >
      ${description ? html`<p class="painel-field-hint">${description}</p>` : null}

      ${feedback
        ? html`<div class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}">${feedback.text}</div>`
        : null}

      ${!snapshot
        ? html`
            <p class="painel-field-hint">A configuração é lida sob demanda (não entra no poll de status).</p>
            <${FormActions}>
              <${Button} variant="accent" pending=${pending} onClick=${() => { void load(); }}>Carregar configuração</${Button}>
            </${FormActions}>
          `
        : html`
            ${groups.map((group) => html`
              <div class="painel-config-group" key=${group.group ?? '__geral'}>
                <h4 class="painel-config-group-title">${groupLabel(group.group)}</h4>
                <div class="painel-form-row painel-form-grid">
                  ${group.rows.map((row) => html`
                    <div class="painel-config-field" id=${configFieldId(row.key)} key=${row.key} tabIndex=${-1}>
                      ${row.overridden ? html`<span class="painel-badge painel-badge-warn">ao vivo</span>` : null}
                      ${renderControl(row)}
                    </div>
                  `)}
                </div>
              </div>
            `)}

            ${errors.length > 0
              ? html`
                  <ul class="painel-config-errors">
                    ${errors.map((error) => html`<li key=${error.key}>${error.message}</li>`)}
                  </ul>
                `
              : null}

            ${drift.length > 0
              ? html`
                  <details class="painel-config-drift">
                    <summary>${drift.length} campo(s) fora do schema (somente leitura)</summary>
                    <ul>
                      ${drift.map((row) => html`<li key=${row.key}><code>${row.key}</code>: ${formatValue(row.value)}</li>`)}
                    </ul>
                  </details>
                `
              : null}

            <${FormActions}>
              <${Button} variant="accent" pending=${pending} disabled=${changedCount === 0} onClick=${() => { void apply(); }}>
                Aplicar alterações${changedCount > 0 ? ` (${changedCount})` : ''}
              </${Button}>
              <${Button} disabled=${changedCount === 0 || pending} onClick=${discard}>Descartar</${Button}>
              <${Button} disabled=${pending} onClick=${() => { void load(); }}>Recarregar</${Button}>
              <${Button} variant="danger" disabled=${pending} onClick=${() => { void reset(); }}>
                Restaurar padrões do .env
              </${Button}>
            </${FormActions}>
          `}
    </${Card}>
  `;
}
