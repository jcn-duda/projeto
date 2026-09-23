import { html, useState } from './vendor/preact.js';
import { Card, StatNumber, ProgressBar } from './kit.js';
import { useAction, actionError } from './action.js';
import { pushPainelToast } from './store.js';
import { formatDurationMs, formatAgeFromTimestamp } from './fmt.js';
import {
  jevModel,
  jevDisagreementsModel,
  overlayBlockedLabel,
  type JevModel,
  type JevQuestionView,
  type JevOverlayView,
  type JevDisagreementView,
} from './jev-model.js';

export interface ViewJevProps {
  typesafe?: Record<string, any>;
  metrics?: Record<string, any>;
}

/** Estado → badge da pergunta: pausa vence (é o estado operacional ativo),
 * depois o kill-switch de config. */
function questionBadge(q: JevQuestionView): { text: string; variant: 'ok' | 'warn' | 'neutral' } {
  if (q.paused) return { text: 'PAUSADO', variant: 'warn' };
  if (q.enabled) return { text: 'ATIVO', variant: 'ok' };
  return { text: 'INATIVO', variant: 'neutral' };
}

function usedPercent(used: number, cap: number): number {
  return cap > 0 ? Math.round((used / cap) * 100) : 0;
}

function budgetVariant(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warn';
  return 'ok';
}

function cooldownText(ms: number): string {
  return ms > 0 ? formatDurationMs(ms) : 'sem';
}

function rateSuffix(rate: number | null): string {
  return rate == null ? '' : ` (${Math.round(rate * 100)}%)`;
}

interface QuestionCardProps {
  title: string;
  q: JevQuestionView;
  /** Nome do lado da divergência na língua da pergunta ('PT-BR' / 'lie'). */
  sideLabel: string;
}

/** Uma pergunta shadow: fila, concordância e a linha de estado. O ORÇAMENTO e o
 * breaker saem daqui de propósito — são um só para as duas perguntas
 * (`SharedBudgetCard`), então não se repetem por card. */
function QuestionCard({ title, q, sideLabel }: QuestionCardProps) {
  const ratePct = q.agreementRate == null ? 0 : Math.round(q.agreementRate * 100);
  return html`
    <${Card} title=${title} badge=${questionBadge(q)}>
      <div style="display: flex; gap: var(--space-4); flex-wrap: wrap;">
        <${StatNumber} value=${q.queueDepth} label="na fila" />
        <${StatNumber} value=${q.inFlight} label="em voo" />
      </div>

      <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
        Modelo: ${q.model || '—'} @ ${q.promptVersion || '—'}
      </p>

      <div style="margin-top: var(--space-2);">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--muted);">Concordância shadow</span>
          <span style="font-weight: 600;">${q.agree} concordam · ${q.disagree} divergem${rateSuffix(q.agreementRate)}</span>
        </div>
        <${ProgressBar} percent=${ratePct} variant="ok" />
        <p style="color: var(--muted); margin-top: var(--space-1); font-size: var(--font-floor);">
          Divergências: IA afirma ${sideLabel}: ${q.aiSide} · regra afirma ${sideLabel}: ${q.ruleSide}
        </p>
      </div>
    </${Card}>
  `;
}

/** Orçamento/breaker ÚNICO das duas perguntas (mesma chave/limite do provedor).
 * O bloco `typesafe` traz os MESMOS números em `audioClassify` e `dubLie`; o
 * card aparece uma vez, não por pergunta. */
function SharedBudgetCard({ q }: { q: JevQuestionView }) {
  const hourPct = usedPercent(q.hourlyUsed, q.hourlyCap);
  const dayPct = usedPercent(q.dailyUsed, q.dailyCap);
  return html`
    <${Card}
      title="Orçamento compartilhado"
      badge=${{ text: 'AS DUAS PERGUNTAS', variant: 'neutral' as const }}
    >
      <div style="margin-top: var(--space-2);">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--muted);">Orçamento hora</span>
          <span style="font-weight: 600;">${q.hourlyUsed}/${q.hourlyCap}</span>
        </div>
        <${ProgressBar} percent=${hourPct} variant=${budgetVariant(hourPct)} />
      </div>

      <div style="margin-top: var(--space-2);">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--muted);">Orçamento dia</span>
          <span style="font-weight: 600;">${q.dailyUsed}/${q.dailyCap}</span>
        </div>
        <${ProgressBar} percent=${dayPct} variant=${budgetVariant(dayPct)} />
      </div>

      <p style="color: var(--muted); margin: var(--space-2) 0 0; font-size: var(--font-floor);">
        Um só orçamento e um só breaker para as duas perguntas (mesma chave, mesmo limite do provedor):
        rate/auth em qualquer pergunta arma o cooldown das duas. Cooldown: ${cooldownText(q.cooldownMs)} ·
        falhas consecutivas: ${q.consecutiveFail}. Contadores por processo — zeram no restart.
      </p>
    </${Card}>
  `;
}

export interface JevViewProps {
  /** Modelo pronto (saída de `jevModel`) — o corpo é puro apresentação. */
  model: JevModel;
  pending?: boolean;
  /** Feedback inline do card de controles (erro da ação). */
  feedback?: { text: string; ok: boolean } | null;
  onPauseToggle?: () => void;
  onDrain?: () => void;
  onCooldownReset?: () => void;
  /** Resposta crua da ação `jev-disagreements` (null antes do clique). */
  disagreements?: Record<string, any> | null;
  disagreementsPending?: boolean;
  onLoadDisagreements?: () => void;
}

/** ETAPA C — overlay gateado: leitura cache-only no termo fraco do DUB
 * genérico. Sem ação própria (o knob é do .env do operador). O badge mostra a
 * verdade operacional: flag ligada com portão fechado é BLOQUEADO (com o
 * motivo), não "GATEADO ON". */
function OverlayCard({ overlay }: { overlay: JevOverlayView }) {
  const coberto = overlay.consulted > 0 ? Math.round(((overlay.consulted - overlay.cacheMiss) / overlay.consulted) * 100) : 0;
  const bloqueado = overlay.enabled && !overlay.active;
  const motivo = bloqueado ? overlayBlockedLabel(overlay.blockedReason) : '';
  const badge = !overlay.enabled
    ? { text: 'OFF', variant: 'neutral' as const }
    : overlay.active
      ? { text: 'GATEADO ON', variant: 'warn' as const }
      : { text: 'BLOQUEADO', variant: 'warn' as const };
  return html`
    <${Card}
      title="Overlay Jev (ETAPA C)"
      badge=${badge}
    >
      ${bloqueado ? html`
        <p style="color: var(--status-warn-text, var(--muted)); margin: 0 0 var(--space-2); font-weight: 600;">
          Bloqueado: ${motivo || overlay.blockedReason} — não decide nada enquanto o portão estiver fechado.
        </p>
      ` : null}
      <div style="display: flex; gap: var(--space-4); flex-wrap: wrap;">
        <${StatNumber} value=${overlay.consulted} label="chamadas" />
        <${StatNumber} value=${overlay.cacheMiss} label="chamadas sem cache" />
        <${StatNumber} value=${overlay.applied} label="títulos derrubados" />
      </div>
      <p style="color: var(--muted); margin: var(--space-2) 0 0; font-size: var(--font-floor);">
        Unidades diferentes: <strong>chamadas</strong> e <strong>chamadas sem cache</strong> contam cada
        leitura (lookup); <strong>títulos derrubados</strong> conta TÍTULO DISTINTO — um por julgamento,
        com dedupe por fingerprint, então o mesmo título re-consultado não infla.
      </p>
      <div style="margin-top: var(--space-2);">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: var(--muted);">Cobertura do cache</span>
          <span style="font-weight: 600;">${coberto}%</span>
        </div>
        <${ProgressBar} percent=${coberto} variant="ok" />
      </div>
      <p style="color: var(--muted); margin: var(--space-2) 0 0; font-size: var(--font-floor);">
        Cache-only e monotônico: nasce DESLIGADO (opt-in explícito no .env) e, com o cache vazio, é no-op (miss preserva true).
        Uma negativa confiante do Jev (noul ≤ 0.15) derruba true→false SOMENTE no generic DUB isolado —
        PT explícito é imune, e nada é buscado, enfileirado ou escrito aqui. A decisão também exige runtime
        ligado, chave presente, Jev não pausado, modelo versionado (jev-x.y.z — alias móvel falha fechado) e
        julgamento cujo eco do modelo confere com o ID configurado. O índice, o catálogo e a evidência de
        arquivo persistidos ficam determinísticos ({overlay:false}) e os caminhos destrutivos não são influenciados.
      </p>
    </${Card}>
  `;
}

/**
 * Tabela do anel de UMA pergunta. Sem linha: aviso curto — o anel nasce vazio
 * e só é populado por divergências reais. A amostra (`sample`) é a descrição
 * humana que a pergunta montou; o título SÓ aparece aqui, atrás do token.
 */
function DisagreementTable({ title, rows }: { title: string; rows: JevDisagreementView[] }) {
  if (rows.length === 0) {
    return html`<p class="painel-empty painel-empty-sm">${title}: nenhuma discordância registrada.</p>`;
  }
  return html`
    <h4 style="margin: var(--space-3) 0 var(--space-1);">${title}</h4>
    <table class="painel-table">
      <thead>
        <tr><th>Quando</th><th>Lado</th><th>noul</th><th>Origem</th><th>Amostra</th></tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => html`
          <tr key=${i}>
            <td>${formatAgeFromTimestamp(r.at)}</td>
            <td>${r.side}</td>
            <td>${r.n.toFixed(2)}</td>
            <td>${r.dim}</td>
            <td style="word-break: break-all;">${r.sample}</td>
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

/**
 * Corpo PRESENTACIONAL da aba (sem hooks, como `MagnetBankView`): recebe o
 * modelo pronto e os callbacks — a casca `ViewJev` é quem tem estado/ação.
 */
export function JevView({ model: m, pending = false, feedback = null, onPauseToggle, onDrain, onCooldownReset, disagreements = null, disagreementsPending = false, onLoadDisagreements }: JevViewProps) {
  // Pausa GLOBAL: o controle do operador é único (custo/instabilidade do
  // serviço de uma vez), então qualquer pergunta pausada liga o estado.
  const pausedGlobal = m.audioClassify.paused || m.dubLie.paused;
  const filaTotal = m.audioClassify.queueDepth + m.dubLie.queueDepth;
  const cooldownAtivo =
    m.audioClassify.cooldownMs > 0 || m.dubLie.cooldownMs > 0 ||
    m.audioClassify.consecutiveFail > 0 || m.dubLie.consecutiveFail > 0;
  const dModel = jevDisagreementsModel(disagreements);

  return html`
    <div>
      ${feedback ? html`
        <div class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}">
          ${feedback.text}
        </div>
      ` : null}

      <div class="painel-grid">
        <${Card}
          title="Controles do Jev"
          badge=${{
            text: pausedGlobal ? 'PAUSADO' : m.enabled ? 'ATIVO' : 'INATIVO',
            variant: pausedGlobal ? 'warn' : m.enabled ? 'ok' : 'neutral',
          }}
        >
          <p style="color: var(--muted); margin: 0; font-size: var(--font-floor);">
            Runtime SHADOW-ONLY: mede e nunca decide — a concordância é só métrica, nenhum stream muda por causa dela.
          </p>
          <div style="display: flex; gap: var(--space-2); margin-top: var(--space-2); flex-wrap: wrap;">
            ${pausedGlobal ? html`
              <button class="painel-btn painel-btn-accent" disabled=${pending} onClick=${onPauseToggle}>
                Retomar Jev
              </button>
            ` : html`
              <button class="painel-btn painel-btn-danger" disabled=${pending} onClick=${onPauseToggle}>
                Pausar Jev
              </button>
            `}
            <button class="painel-btn" disabled=${pending || filaTotal === 0} onClick=${onDrain}>
              Drenar Fila (${filaTotal})
            </button>
            <button class="painel-btn" disabled=${pending || !cooldownAtivo} onClick=${onCooldownReset}>
              Zerar Cooldown
            </button>
          </div>
          <p style="color: var(--muted); margin: var(--space-2) 0 0; font-size: var(--font-floor);">
            A pausa é GLOBAL (as duas perguntas) e efêmera: a fila sobrevive para o pós-retomar drenar. Os knobs do Jev são do .env do operador — não há config ao vivo nesta aba.
          </p>
        </${Card}>
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${SharedBudgetCard} q=${m.audioClassify} />
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${QuestionCard} title="Pergunta 1 · audio-classify (is_ptbr_dub)" q=${m.audioClassify} sideLabel="PT-BR" />
        <${QuestionCard} title="Pergunta 2 · dub-lie (is_dub_lie)" q=${m.dubLie} sideLabel="lie" />
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${OverlayCard} overlay=${m.overlay} />
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${Card} title="Últimas discordâncias (memória)">
          <p style="color: var(--muted); margin: 0 0 var(--space-2); font-size: var(--font-floor);">
            Anel em memória (teto de 50 por pergunta) — some no restart. Leitura pura: nada é gravado nem apagado.
            O título só sai nesta resposta autenticada; as métricas continuam com labels fechados.
          </p>
          <button class="painel-btn painel-btn-accent" disabled=${disagreementsPending} onClick=${onLoadDisagreements}>
            ${disagreementsPending ? 'Carregando…' : 'Ver discordâncias'}
          </button>
          ${disagreements
            ? html`
              <div style="margin-top: var(--space-2);">
                <${DisagreementTable}
                  title="Pergunta 1 · audio-classify (is_ptbr_dub)"
                  rows=${dModel.audioClassify}
                />
                <${DisagreementTable} title="Pergunta 2 · dub-lie (is_dub_lie)" rows=${dModel.dubLie} />
              </div>
            `
            : null}
        </${Card}>
      </div>
    </div>
  `;
}

export function ViewJev({ typesafe, metrics }: ViewJevProps) {
  const model = jevModel(typesafe, metrics);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [disagreements, setDisagreements] = useState<Record<string, any> | null>(null);
  const [loadingDisagreements, setLoadingDisagreements] = useState(false);
  const { pending, run } = useAction();

  const handleAction = async (action: string, successMsg: string) => {
    const outcome = await run({
      action,
      poll: ['typesafe', 'metrics'],
      successToast: successMsg,
    });
    // O erro fica no card (feedback inline); o sucesso sai como toast global.
    const error = actionError(outcome);
    setFeedback(error ? { text: `Falha: ${error}`, ok: false } : null);
  };

  // Drenagem com o Jev PAUSADO é NO-OP: o backend responde `drained:false` com
  // `reason:'paused'` (união fechada) e o toast de sucesso mentiria. Aqui o
  // toast é escolhido pelo corpo: `info` quando nada foi drenado.
  const handleDrain = async () => {
    const outcome = await run({ action: 'jev-drain', poll: ['typesafe', 'metrics'] });
    if (outcome.ok) {
      const pausado = outcome.data.drained === false;
      pushPainelToast(
        pausado
          ? 'Jev pausado: a fila não foi drenada — retome para esvaziá-la.'
          : 'Drenagem das filas do Jev reagendada',
        pausado ? 'info' : 'ok',
      );
      return;
    }
    const error = actionError(outcome);
    if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
  };

  // Leitura SOB DEMANDA (fora do poll): só no clique, e sem `poll` — o anel é
  // memória e o status não o carrega. O resultado fica no estado da casca.
  const handleDisagreements = async () => {
    setLoadingDisagreements(true);
    try {
      const outcome = await run({ action: 'jev-disagreements' });
      if (outcome.ok) {
        setDisagreements(outcome.data);
        setFeedback(null);
      } else {
        const error = actionError(outcome);
        if (error) setFeedback({ text: `Falha: ${error}`, ok: false });
      }
    } finally {
      setLoadingDisagreements(false);
    }
  };

  const pausedGlobal = model.audioClassify.paused || model.dubLie.paused;

  return html`
    <${JevView}
      model=${model}
      pending=${pending}
      feedback=${feedback}
      onPauseToggle=${() => handleAction(pausedGlobal ? 'jev-resume' : 'jev-pause', pausedGlobal ? 'Jev retomado' : 'Jev pausado')}
      onDrain=${handleDrain}
      onCooldownReset=${() => handleAction('jev-cooldown-reset', 'Cooldown do Jev zerado')}
      disagreements=${disagreements}
      disagreementsPending=${loadingDisagreements}
      onLoadDisagreements=${handleDisagreements}
    />
  `;
}
