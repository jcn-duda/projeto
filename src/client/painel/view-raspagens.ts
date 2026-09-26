import { html, useState } from './vendor/preact.js';
import { Card, StatNumber, ProgressBar } from './kit.js';
import { useAction, actionError, type ActionOutcome, type ActionRequest } from './action.js';
import { LiveConfigCard } from './view-config.js';
import { formatAgeFromTimestamp } from './fmt.js';
import {
  crawlSummary,
  crawlSiteCards,
  motorBadge,
  nextDiscoveryLabel,
  phaseLabel,
  siteStateLabel,
  workLabel,
  runDurationMs,
  etaLabel,
  type CrawlSummary,
  type CrawlSiteCard,
} from './raspagens-model.js';

export interface ViewRaspagensProps {
  crawl?: Record<string, any>;
}

/** Ações do site enviadas ao `/dashboard-action.json` (nome histórico do
 * backend). `site` é o id do card do Jackett — igual às demais telas. */
const REPROCESS_ACTION = 'crawl-reprocess-errors';
const RESET_ACTION = 'crawl-reset';

export function ViewRaspagens({ crawl }: ViewRaspagensProps) {
  const c = crawl || {};
  const summary = crawlSummary(c);
  const sites = crawlSiteCards(c);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const { pending, run } = useAction();

  const handle = async (
    action: string,
    body: Record<string, any> = {},
    confirmMsg?: ActionRequest['confirm'],
    successToast: string | ((data: Record<string, any>) => string) = 'Ação executada',
  ): Promise<ActionOutcome> => {
    const outcome = await run({
      action,
      body,
      confirm: confirmMsg,
      poll: ['crawl'],
      successToast,
      failureFallback: 'ação indisponível — o motor pode estar ocupado ou sem adaptador',
    });
    const error = actionError(outcome);
    setFeedback(error ? { text: `Falha: ${error}`, ok: false } : null);
    return outcome;
  };

  const badge = motorBadge(summary);

  return html`
    <div>
      ${feedback ? html`
        <div
          class="painel-feedback ${feedback.ok ? 'painel-feedback-ok' : 'painel-feedback-err'}"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          ${feedback.text}
        </div>
      ` : null}

      <div class="painel-grid">
        <${Card} title="Estado do Motor" badge=${badge}>
          <div style="display: flex; gap: var(--space-2); margin-top: var(--space-2); flex-wrap: wrap;">
            <button
              class="painel-btn ${summary.paused ? 'painel-btn-accent' : 'painel-btn-danger'}"
              disabled=${pending}
              onClick=${() => handle(
                'crawl-pause',
                { paused: !summary.paused },
                undefined,
                summary.paused ? 'Raspagem retomada' : 'Raspagem pausada',
              )}
            >
              ${summary.paused ? 'Retomar' : 'Pausar'}
            </button>
            <button
              class="painel-btn"
              disabled=${pending}
              onClick=${() => handle(
                'crawl-simulate',
                { max: 20 },
                undefined,
                (data) => Number(data.pages || 0) > 0
                  ? `Simulação: ${data.pages} página(s) processada(s) em dry-run`
                  : 'Simulação sem páginas elegíveis',
              )}
            >
              Simular 20
            </button>
          </div>
          ${summary.autoPause ? html`
            <p class="painel-field-hint" style="color: var(--red); margin-top: var(--space-2);">
              Pausa automática (${summary.autoPause.reason || 'motivo não informado'}): ${summary.autoPause.detail || '—'}
            </p>
          ` : null}
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Engine: ${summary.engine || '—'} · Site ativo: ${summary.site || '—'}${summary.siteReady ? '' : ' (adaptador ainda não resolvido)'}
            ${summary.cursor ? html` · Cursor: <code>${summary.cursor}</code>` : null}
            ${summary.nextDiscoveryAt != null && !summary.runOpen ? html` · Próxima descoberta: ${nextDiscoveryLabel(summary.nextDiscoveryAt)}` : null}
            ${summary.runOpen ? html` · Rodada aberta` : null}
          </p>
        </${Card}>

        <${Card} title="Vazão e Freios">
          <${StatNumber} value=${summary.pagesThisHour} target=${summary.maxPerHour || undefined} label="páginas / h" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Pausa entre páginas: ${summary.delayMs}ms · Janela de ociosidade: ${summary.idleWindowMs}ms
          </p>
          <p style="color: var(--muted); margin-top: var(--space-1); font-size: var(--font-floor);">
            Erros seguidos: ${summary.errorStreak} · Canário de layout: ${summary.canaryStreak}
          </p>
        </${Card}>

        <${Card} title="Sites Configurados">
          ${summary.sitesConfigured.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhum site em CRAWL_SITES.</p>
          ` : html`
            <ul class="painel-list">
              ${summary.sitesConfigured.map((id) => html`
                <li key=${id}><code>${id}</code>${id === summary.site ? ' · ativo' : ''}</li>
              `)}
            </ul>
          `}
        </${Card}>
      </div>

      ${sites.length === 0 ? html`
        <div class="painel-grid" style="margin-top: var(--space-4);">
          <${Card} title="Sites">
            <p style="color: var(--muted); font-size: var(--font-floor);">
              Sem estado de site — o motor ainda não abriu o \`crawl.db\` ou nenhum site está configurado.
            </p>
          </${Card}>
        </div>
      ` : sites.map((card) => html`
        <div style="margin-top: var(--space-4);">
          <${SiteCard}
            key=${card.id}
            card=${card}
            summary=${summary}
            pending=${pending}
            onReprocess=${() => handle(
              REPROCESS_ACTION,
              { site: card.id },
              undefined,
              (data) => `Erros reprocessados em ${card.id}: ${data.requeued ?? 0} URL(s)`,
            )}
            onReset=${() => handle(
              RESET_ACTION,
              { site: card.id },
              {
                title: 'Zerar site da raspagem',
                message: `Zerar TODO o estado do site "${card.label}" no crawl.db?`,
                detail: 'A fila e as rodadas gravadas daquele site somem; o acervo de magnets NÃO é tocado.',
                confirmLabel: 'Zerar site',
                danger: true,
              },
              `Site ${card.id} zerado`,
            )}
          />
        </div>
      `)}

      <div style="margin-top: var(--space-4);">
        <${LiveConfigCard}
          title="Configuração ao vivo da Raspagem"
          getAction="crawl-config-get"
          setAction="crawl-config-set"
          resetAction="crawl-config-reset"
          pollBlocks=${['crawl']}
          description="Ajustes do motor aplicados ao vivo (persistidos no SQLite, sem restart). A lista de sites vem do .env (CRAWL_SITES) e não é editável aqui. Campo divergente do .env aparece marcado como 'ao vivo'."
        />
      </div>
    </div>
  `;
}

export interface SiteCardProps {
  card: CrawlSiteCard;
  summary: CrawlSummary;
  pending: boolean;
  onReprocess: () => void;
  onReset: () => void;
}

/** Card presentacional de UM site — sem hooks e sem fetch; a casca passa as
 * ações já ligadas ao `useAction`. */
export function SiteCard({ card, summary, pending, onReprocess, onReset }: SiteCardProps) {
  const badge = {
    text: `${siteStateLabel(card, summary)} · ${phaseLabel(card.phase)}`,
    variant: siteStateLabel(card, summary) === 'pausa automática'
      ? ('err' as const)
      : siteStateLabel(card, summary) === 'ativo'
        ? ('ok' as const)
        : ('neutral' as const),
  };
  const last = card.latestRun;
  const lastDuration = runDurationMs(last);

  return html`
    <${Card} title=${card.label} badge=${badge}>
      <div class="painel-progress-row" style="display: flex; align-items: center; gap: var(--space-2);">
        <div style="flex: 1;"><${ProgressBar} percent=${card.progressPercent} variant=${card.progressPercent >= 100 ? 'ok' : 'warn'} /></div>
        <span style="font-weight: 600;">${card.progressPercent}%</span>
      </div>

      <div style="display: flex; gap: var(--space-4); flex-wrap: wrap; margin-top: var(--space-3);">
        <${StatNumber} value=${card.magnetsFound} label="magnets vistos" />
        <${StatNumber} value=${card.newReleases} label="novos no índice" />
        <${StatNumber} value=${card.torrentPercent} label="% torrent (nas processadas)" />
        <${StatNumber} value=${card.ratePerHour} label="páginas / h" />
        <${StatNumber} value=${etaLabel(card.etaHours)} label="ETA" />
      </div>

      <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
        Total: ${card.total} · feitas: ${card.done} · pendentes: ${card.pending} · inflight: ${card.inflight}
        · sem torrent: ${card.noTorrent} · sem obra: ${card.noWork} · erros: ${card.error}
      </p>
      ${card.simulated > 0 ? html`
        <p style="color: var(--warn, #b58900); margin-top: var(--space-1); font-size: var(--font-floor);">
          ${card.simulated} simulada(s) aguardando gravação — desligue o modo simulação para gravá-las.
        </p>
      ` : null}
      <p style="color: var(--muted); margin-top: var(--space-1); font-size: var(--font-floor);">
        Última rodada:
        ${last
          ? html`${phaseLabel(last.phase)} · início ${last.startedAt ? new Date(last.startedAt).toLocaleString() : '—'}${last.finishedAt ? html` · durou ${lastDuration != null ? Math.round(lastDuration / 1000) + 's' : '—'}` : html` · em andamento`}`
          : '—'}
      </p>

      <div style="display: flex; gap: var(--space-2); margin-top: var(--space-3); flex-wrap: wrap;">
        <button class="painel-btn" disabled=${pending || card.error === 0} onClick=${onReprocess}>
          Reprocessar Erros (${card.error})
        </button>
        <button class="painel-btn painel-btn-danger" disabled=${pending} onClick=${onReset}>
          Zerar Site
        </button>
      </div>

      <div class="painel-grid" style="margin-top: var(--space-4);">
        <${Card} title="Últimas Obras">
          ${card.recentWorks.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma obra recente registrada.</p>
          ` : html`
            <table class="painel-table">
              <thead><tr><th>Obra</th><th>Visto</th></tr></thead>
              <tbody>
                ${card.recentWorks.map((w) => html`
                  <tr key=${w.url}>
                    <td title=${w.url}>${workLabel(w)}</td>
                    <td>${w.checkedAt ? formatAgeFromTimestamp(w.checkedAt) : '—'}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </${Card}>

        <${Card} title="Sem Obra Identificada">
          ${card.noWorkList.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhuma página sem obra.</p>
          ` : html`
            <table class="painel-table">
              <thead><tr><th>Página</th><th>Visto</th></tr></thead>
              <tbody>
                ${card.noWorkList.map((w) => html`
                  <tr key=${w.url}>
                    <td title=${w.url}>${w.url}</td>
                    <td>${w.checkedAt ? formatAgeFromTimestamp(w.checkedAt) : '—'}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
        </${Card}>
      </div>

      <div style="margin-top: var(--space-4);">
        <${Card} title="Erros Agrupados">
          ${card.errorGroups.length === 0 ? html`
            <p style="color: var(--muted); font-size: var(--font-floor);">Nenhum erro no estado do site.</p>
          ` : html`
            <table class="painel-table">
              <thead><tr><th>Motivo</th><th>Ocorrências</th></tr></thead>
              <tbody>
                ${card.errorGroups.map((g) => html`
                  <tr key=${g.reason}>
                    <td>${g.reason}</td>
                    <td>${g.count}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
          ${card.errors.length > 0 ? html`
            <details style="margin-top: var(--space-3);">
              <summary>${card.errors.length} erro(s) recente(s)</summary>
              <table class="painel-table">
                <thead><tr><th>URL</th><th>Erro</th><th>Tentativas</th><th>Visto</th></tr></thead>
                <tbody>
                  ${card.errors.map((e) => html`
                    <tr key=${e.url}>
                      <td title=${e.url}>${e.url}</td>
                      <td>${e.error || '—'}</td>
                      <td>${e.tries}</td>
                      <td>${e.checkedAt ? formatAgeFromTimestamp(e.checkedAt) : '—'}</td>
                    </tr>
                  `)}
                </tbody>
              </table>
            </details>
          ` : null}
        </${Card}>
      </div>
    </${Card}>
  `;
}
