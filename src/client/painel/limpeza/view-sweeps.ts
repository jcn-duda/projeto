// Cartão "Varreduras nativas (AllDebrid)" da aba Limpeza.
//
// A foto chega do bloco `debrid` do /dashboard-status.json (`debrid.sweeps`),
// espelho síncrono do `GET /sweeps` do gateway (porta admin 8711). Quem fala
// com o gateway é o poll de fundo; este cartão só desenha.
//
// REGRA DO ZERO: contador de varredura é MEDIDA. Sem a foto — gateway fora,
// primeira subida, conta BYO — o cartão diz "status nativo indisponível" e as
// contagens ficam `null` (renderizadas como "—"). Nunca zero inventado: "0
// removidos" e "não sei o que removeu" são coisas diferentes para o operador.
import { html } from '../vendor/preact.js';
import { Card, Badge, type BadgeVariant } from '../kit.js';

export interface SweepsReasonRow {
  reason: string;
  count: number;
}

export interface SweepsCardView {
  /** `false` = sem foto do gateway (o cartão vira aviso, não zeros). */
  available: boolean;
  /** Modo EFETIVO no gateway: `LEITURA` | `APLICA` | `DESLIGADO`. */
  modeLabel: string;
  modeVariant: BadgeVariant;
  scheduled: boolean;
  running: boolean;
  /** "6 h", "30 min", "—" quando o intervalo é zero/ausente. */
  intervalLabel: string;
  /** "14/10 09:20 · manual" | "—". */
  lastTickLabel: string;
  /** "14/10 15:20" | "—". */
  nextDueLabel: string;
  planned: number | null;
  swept: number | null;
  sweptUndubbed: number | null;
  failed: number | null;
  blocked: number | null;
  /** Até 3 motivos mais frequentes (contagem decrescente). */
  topReasons: SweepsReasonRow[];
  /** Por que o agendador está parado (`cleanup_off`, `interval_zero`, …). */
  disabledReason: string | null;
}

const MUTED_LINE = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--muted);';
const WARN_LINE = 'margin: 0 0 var(--space-2); font-size: var(--font-floor); color: var(--amber);';

const MODES: Record<string, { label: string; variant: BadgeVariant }> = {
  apply: { label: 'APLICA', variant: 'warn' },
  read_only: { label: 'LEITURA', variant: 'ok' },
  off: { label: 'DESLIGADO', variant: 'neutral' },
};

function emptyView(): SweepsCardView {
  return {
    available: false,
    modeLabel: 'SEM STATUS',
    modeVariant: 'neutral',
    scheduled: false,
    running: false,
    intervalLabel: '—',
    lastTickLabel: '—',
    nextDueLabel: '—',
    planned: null,
    swept: null,
    sweptUndubbed: null,
    failed: null,
    blocked: null,
    topReasons: [],
    disabledReason: null,
  };
}

/** Número medido ou `null` — `undefined`/`NaN` nunca viram 0. */
function measured(value: unknown): number | null {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : null;
}

/** Data/hora local curta, no fuso do operador que está olhando o painel. */
function stamp(at: number | null): string {
  if (at == null || at <= 0) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Intervalo em unidade legível; zero/ausente não vira "0 s". */
function every(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  if (ms >= 3_600_000) return `${Math.round(ms / 360_000) / 10} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

/** `last` do gateway: quando o último tick rodou e se foi manual. */
function lastTick(last: any): string {
  if (!last || typeof last !== 'object') return '—';
  const at = measured(last.at);
  if (at == null) return '—';
  return `${stamp(at)} · ${last.manual === true ? 'manual' : 'agendado'}`;
}

/** Os 3 motivos mais frequentes; empate desempata pelo nome (ordem estável). */
export function topSweepReasons(raw: unknown, limit = 3): SweepsReasonRow[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .map(([reason, count]) => ({ reason, count: measured(count) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, Math.max(0, limit));
}

/**
 * Traduz `debrid.sweeps` (snapshot da ponte) para o cartão. Aceita `null`,
 * `undefined` e qualquer corpo estranho: sem `ok`/`mode` não há foto confiável,
 * e o cartão se declara indisponível em vez de mostrar meia-verdade.
 */
export function sweepsCardView(sweeps: Record<string, any> | null | undefined): SweepsCardView {
  if (!sweeps || typeof sweeps !== 'object') return emptyView();
  const mode = MODES[String(sweeps.mode ?? '')];
  if (!mode) return emptyView();
  const counters = sweeps.counters && typeof sweeps.counters === 'object' ? sweeps.counters : {};
  return {
    available: true,
    modeLabel: mode.label,
    modeVariant: mode.variant,
    scheduled: sweeps.scheduled === true,
    running: sweeps.running === true,
    intervalLabel: every(measured(sweeps.intervalMs)),
    lastTickLabel: lastTick(sweeps.last),
    nextDueLabel: stamp(measured(sweeps.nextDueAt)),
    planned: measured(counters.planned),
    swept: measured(counters.swept),
    // Atalho do contrato; quando o gateway não manda, é medido em byKind.
    sweptUndubbed: measured(counters.sweptUndubbed) ?? measured(counters.byKind?.sweepUndubbed?.swept),
    failed: measured(counters.failed),
    blocked: measured(counters.blocked),
    topReasons: topSweepReasons(counters.reasons),
    disabledReason: sweeps.disabledReason == null ? null : String(sweeps.disabledReason),
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
            status nativo indisponível: o painel ainda não recebeu a foto do gateway de varreduras.
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
        ${view.running ? html`· <${Badge} text="EM VOO" variant="warn" />` : ''}
      </p>
      ${view.disabledReason ? html`<p style=${WARN_LINE}>Desligado no gateway: ${view.disabledReason}</p>` : null}
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
      <p style=${MUTED_LINE}>Último tick: ${view.lastTickLabel} · próximo previsto: ${view.nextDueLabel}</p>
      ${view.topReasons.length === 0
        ? html`<p style=${MUTED_LINE}>Motivos: nenhum registrado.</p>`
        : html`<p style=${MUTED_LINE}>Motivos mais frequentes: ${view.topReasons.map((r) => `${r.reason} (${r.count})`).join(' · ')}</p>`}
    </${Card}>
  `;
}
