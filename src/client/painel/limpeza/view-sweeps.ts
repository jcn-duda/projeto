// Cartão "Varreduras nativas (AllDebrid)" da aba Limpeza.
//
// A foto chega do bloco `debrid` do /dashboard-status.json (`debrid.sweeps`),
// espelho síncrono do `GET /sweeps` do gateway (porta admin 8711). Quem fala
// com o gateway é o poll de fundo; este cartão só desenha.
//
// REGRA DO ZERO: contador de varredura é MEDIDA. Sem a foto — gateway fora,
// primeira subida, conta BYO, corpo sem `ok` — o cartão diz "status nativo
// indisponível" e as contagens ficam `null` (renderizadas como "—"). Contador
// de processo zerado (`mode:"off"`, agendador parado, nenhum `last` e `runs` 0)
// também não é medida: "0 removidos" e "não rodei" são coisas diferentes para
// o operador.
import { html } from '../vendor/preact.js';
import { Card, Badge, type BadgeVariant } from '../kit.js';
import { sweepReasonLabel } from '../limpeza-model.js';

export interface SweepsReasonRow {
  /** Chave crua do gateway (`ready`, `quota`, …). */
  reason: string;
  /** O mesmo motivo em PT-BR (fallback "motivo: <chave>"). */
  label: string;
  count: number;
}

export interface SweepsCardView {
  /** `false` = foto ausente ou inválida (o cartão vira aviso, não zeros). */
  available: boolean;
  /** Por que não há foto — `null` quando disponível. */
  unavailableReason: string | null;
  /** Modo EFETIVO no gateway: `LEITURA` | `APLICA` | `DESLIGADO`. */
  modeLabel: string;
  modeVariant: BadgeVariant;
  scheduled: boolean;
  running: boolean;
  /** `true` só quando existe RODADA medida (ver `hasMeasuredRound`). */
  measured: boolean;
  /** "6 h", "30 min", "—" quando o intervalo é zero/ausente. */
  intervalLabel: string;
  /** "14/10 09:20 · manual" | "—". */
  lastTickLabel: string;
  /** "14/10 15:20" | "—". */
  nextDueLabel: string;
  /** `counters.runs` (+ manuais): "3 · 1 manual" | "—". */
  runsLabel: string;
  /** Quando o processo/gateway subiu. */
  startedLabel: string;
  /** Quando ESTA ponte tirou a foto (`pulledAt`). */
  pulledLabel: string;
  /** Kinds sem varredura na última rodada; `null` quando nada faltou. */
  missingLabel: string | null;
  /** Última rodada interrompida (`stopped` por kind), em PT-BR; `null` se inteira. */
  stoppedLabel: string | null;
  planned: number | null;
  swept: number | null;
  sweptUndubbed: number | null;
  failed: number | null;
  blocked: number | null;
  /** Até 3 motivos mais frequentes (contagem decrescente), já em PT-BR. */
  topReasons: SweepsReasonRow[];
  /** Chave crua do motivo do agendador parado (`cleanup_off`, …). */
  disabledReason: string | null;
  /** O mesmo motivo em PT-BR; `null` quando o agendador não está parado. */
  disabledReasonLabel: string | null;
}

const MUTED_LINE = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);';
const WARN_LINE = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--amber);';

/**
 * `Map`, não objeto: o `mode` vem da rede e um objeto indexado responderia
 * `constructor`/`__proto__` herdados — o cartão pintaria "modo válido" com
 * `label`/`variant` `undefined`.
 */
const MODES = new Map<string, { label: string; variant: BadgeVariant }>([
  ['apply', { label: 'APLICA', variant: 'warn' }],
  ['read_only', { label: 'LEITURA', variant: 'ok' }],
  ['off', { label: 'DESLIGADO', variant: 'neutral' }],
]);

/** Selo da rodada em voo. NEUTRO de propósito: `running`/`busy` é ESPERA, não
 * falha — o vermelho do painel é do erro de verdade. */
export const SWEEPS_RUNNING_BADGE: { text: string; variant: BadgeVariant } = {
  text: 'EM VOO · AGUARDE',
  variant: 'neutral',
};

function emptyView(unavailableReason: string): SweepsCardView {
  return {
    available: false,
    unavailableReason,
    modeLabel: 'SEM STATUS',
    modeVariant: 'neutral',
    scheduled: false,
    running: false,
    measured: false,
    intervalLabel: '—',
    lastTickLabel: '—',
    nextDueLabel: '—',
    runsLabel: '—',
    startedLabel: '—',
    pulledLabel: '—',
    missingLabel: null,
    stoppedLabel: null,
    planned: null,
    swept: null,
    sweptUndubbed: null,
    failed: null,
    blocked: null,
    topReasons: [],
    disabledReason: null,
    disabledReasonLabel: null,
  };
}

/** Número medido ou `null` — `undefined`/`NaN` nunca viram 0. */
function measured(value: unknown): number | null {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : null;
}

/** Chave textual vinda da rede; primitivo só, para não virar "[object Object]". */
function keyOf(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 60);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function hasOwn(obj: unknown, key: string): boolean {
  return Boolean(obj) && typeof obj === 'object'
    && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Data/hora local curta, no fuso do operador que está olhando o painel. */
function stamp(at: number | null): string {
  if (at == null || at <= 0) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `pulledAt` chega em ISO; data inválida não vira "Invalid Date" na tela. */
function isoStamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Intervalo em unidade legível; zero/ausente não vira "0 s". */
function every(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  if (ms >= 3_600_000) return `${Math.round(ms / 360_000) / 10} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** `last.at` (com o fallback `lastTickAt`): quando a última rodada rodou e se
 * foi manual. `last` nulo não inventa "agendado". */
function lastTick(last: any, fallback: number | null): string {
  if (!last || typeof last !== 'object') return stamp(fallback);
  const at = measured(last.at) ?? fallback;
  if (at == null) return '—';
  return `${stamp(at)} · ${last.manual === true ? 'manual' : 'agendado'}`;
}

/** Kinds que a última rodada não varreu (`last.missing`) e, sem a lista, a
 * contagem de `counters.missing`. `null` quando nada faltou. */
function missingOf(last: any, counters: any): string | null {
  const kinds = Array.isArray(last?.missing)
    ? last.missing.map((kind: unknown) => keyOf(kind)).filter(Boolean)
    : [];
  if (kinds.length > 0) return kinds.join(', ');
  const count = hasOwn(counters, 'missing') ? measured(counters.missing) : null;
  return count != null && count > 0 ? `${count} tipo(s)` : null;
}

/** Varreduras interrompidas na última rodada (`stopped` é POR kind). */
function stoppedOf(last: any): string | null {
  const rows = Array.isArray(last?.outcomes) ? last.outcomes : [];
  const parts: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || row.stopped == null) continue;
    const kind = keyOf(row.kind) || 'varredura';
    parts.push(`${kind}: ${sweepReasonLabel(row.stopped)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * `sweptUndubbed` do atalho ou de `byKind.sweepUndubbed.swept`. Leitura por
 * `hasOwn`: `byKind` vem da rede e herdar `constructor` daria número inventado.
 */
function undubbed(counters: any): number | null {
  const direct = hasOwn(counters, 'sweptUndubbed') ? measured(counters.sweptUndubbed) : null;
  if (direct != null) return direct;
  if (!hasOwn(counters, 'byKind') || !hasOwn(counters.byKind, 'sweepUndubbed')) return null;
  const row = counters.byKind.sweepUndubbed;
  return hasOwn(row, 'swept') ? measured(row.swept) : null;
}

/** Os 3 motivos mais frequentes; empate desempata pelo nome (ordem estável). */
export function topSweepReasons(raw: unknown, limit = 3): SweepsReasonRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([reason, count]) => ({ reason, label: sweepReasonLabel(reason), count: measured(count) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, Math.max(0, limit));
}

/**
 * Traduz `debrid.sweeps` (snapshot da ponte) para o cartão. Aceita `null`,
 * `undefined` e qualquer corpo estranho. Sem foto, sem `ok:true` ou com `mode`
 * fora do contrato não há medida confiável: o cartão se declara indisponível em
 * vez de mostrar meia-verdade.
 */
export function sweepsCardView(sweeps: Record<string, any> | null | undefined): SweepsCardView {
  if (!sweeps || typeof sweeps !== 'object' || Array.isArray(sweeps)) {
    return emptyView('o painel ainda não recebeu a foto do gateway de varreduras');
  }
  // `ok:false`/ausente = corpo malformado ou recusa: nada nele é medida.
  if (sweeps.ok !== true) {
    return emptyView('o gateway respondeu sem `ok` (foto inválida)');
  }
  const modeKey = keyOf(sweeps.mode);
  const mode = MODES.get(modeKey);
  if (!mode) return emptyView(`modo desconhecido no gateway: "${modeKey || 'vazio'}"`);

  const counters = sweeps.counters && typeof sweeps.counters === 'object' ? sweeps.counters : {};
  const last = sweeps.last && typeof sweeps.last === 'object' && !Array.isArray(sweeps.last) ? sweeps.last : null;
  const disabledReason = keyOf(sweeps.disabledReason) || null;
  const runs = hasOwn(counters, 'runs') ? measured(counters.runs) ?? 0 : 0;
  const manualRuns = hasOwn(counters, 'manualRuns') ? measured(counters.manualRuns) ?? 0 : 0;
  // Rodada de verdade = o gateway registrou um tick (`last`) ou já contou
  // rodada. Fora disso o zero é RAM recém-nascida, não medida.
  const hasMeasuredRound = (last != null || runs > 0) && modeKey !== 'off' && disabledReason == null;
  return {
    available: true,
    unavailableReason: null,
    modeLabel: mode.label,
    modeVariant: mode.variant,
    scheduled: sweeps.scheduled === true,
    running: sweeps.running === true,
    measured: hasMeasuredRound,
    intervalLabel: every(measured(sweeps.intervalMs)),
    lastTickLabel: lastTick(last, measured(sweeps.lastTickAt)),
    nextDueLabel: stamp(measured(sweeps.nextDueAt)),
    runsLabel: hasMeasuredRound ? `${runs}${manualRuns > 0 ? ` · ${manualRuns} manual(is)` : ''}` : '—',
    startedLabel: stamp(measured(sweeps.startedAt)),
    pulledLabel: stamp(isoStamp(sweeps.pulledAt)),
    missingLabel: missingOf(last, counters),
    stoppedLabel: stoppedOf(last),
    planned: hasMeasuredRound ? measured(counters.planned) : null,
    swept: hasMeasuredRound ? measured(counters.swept) : null,
    // Atalho do contrato; quando o gateway não manda, é medido em byKind.
    sweptUndubbed: hasMeasuredRound ? undubbed(counters) : null,
    failed: hasMeasuredRound ? measured(counters.failed) : null,
    blocked: hasMeasuredRound ? measured(counters.blocked) : null,
    topReasons: topSweepReasons(counters.reasons),
    disabledReason,
    disabledReasonLabel: disabledReason == null ? null : sweepReasonLabel(disabledReason),
  };
}

function value(v: number | null): string {
  return v == null ? '—' : String(v);
}

const COUNTER_ROWS: Array<{ key: keyof SweepsCardView; label: string }> = [
  { key: 'planned', label: 'Planejados (planned)' },
  { key: 'swept', label: 'Varridos e removidos (swept)' },
  { key: 'sweptUndubbed', label: 'Varridos sem dublagem (sweptUndubbed)' },
  { key: 'failed', label: 'Falhas (failed)' },
  { key: 'blocked', label: 'Bloqueados (blocked)' },
];

export interface SweepsCardProps {
  /** `debrid.sweeps` do /dashboard-status.json. */
  sweeps?: Record<string, any> | null;
}

/**
 * Cartão compacto do agendador NATIVO. Só leitura: pedir varredura continua
 * sendo o botão destrutivo acima.
 */
export function SweepsCard({ sweeps }: SweepsCardProps) {
  const view = sweepsCardView(sweeps);
  if (!view.available) {
    return html`
      <${Card} title="Varreduras nativas (AllDebrid)" badge=${{ text: view.modeLabel, variant: view.modeVariant }}>
        <div class="painel-empty painel-empty-sm">
          <p style=${MUTED_LINE}>
            status nativo indisponível: ${view.unavailableReason}
          </p>
          <p style=${MUTED_LINE}>
            Contadores ficam em branco de propósito — sem a foto, nenhum número foi medido.
          </p>
        </div>
      </${Card}>
    `;
  }
  return html`
    <${Card} title="Varreduras nativas (AllDebrid)" badge=${{ text: view.modeLabel, variant: view.modeVariant }}>
      <p style=${MUTED_LINE}>
        ${view.scheduled ? 'Agendador ligado' : 'Agendador parado'} · a cada ${view.intervalLabel}
        ${view.running
          ? html`· <${Badge} text=${SWEEPS_RUNNING_BADGE.text} variant=${SWEEPS_RUNNING_BADGE.variant} />`
          : ''}
      </p>
      ${view.disabledReasonLabel
        ? html`<p style=${WARN_LINE}>Agendador fora: ${view.disabledReasonLabel}</p>`
        : null}
      ${view.stoppedLabel
        ? html`<p style=${WARN_LINE}>Última rodada interrompida — ${view.stoppedLabel}</p>`
        : null}
      ${view.measured
        ? null
        : html`<p style=${MUTED_LINE}>Não rodou nesta configuração: contadores em branco, nada foi medido.</p>`}
      <table class="painel-table">
        <thead><tr><th>Contador (processo)</th><th>Valor</th></tr></thead>
        <tbody>
          ${COUNTER_ROWS.map((row) => html`
            <tr key=${row.key}>
              <td>${row.label}</td>
              <td>${value(view[row.key] as number | null)}</td>
            </tr>
          `)}
        </tbody>
      </table>
      <p style=${MUTED_LINE}>Última rodada: ${view.lastTickLabel} · próxima prevista: ${view.nextDueLabel}</p>
      <p style=${MUTED_LINE}>
        Rodadas: ${view.runsLabel} · processo desde ${view.startedLabel} · foto tirada em ${view.pulledLabel}
      </p>
      ${view.missingLabel
        ? html`<p style=${WARN_LINE}>Sem varredura na última rodada: ${view.missingLabel}</p>`
        : null}
      ${view.topReasons.length === 0
        ? html`<p style=${MUTED_LINE}>Motivos: nenhum registrado.</p>`
        : html`<p style=${MUTED_LINE}>Motivos mais frequentes: ${view.topReasons.map((r) => `${r.label} (${r.count})`).join(' · ')}</p>`}
    </${Card}>
  `;
}
