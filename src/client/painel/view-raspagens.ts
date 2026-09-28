import { html, useState } from './vendor/preact.js';
import { Card, StatNumber, ProgressBar, Badge } from './kit.js';
import { useAction, actionError, type ActionOutcome, type ActionRequest } from './action.js';
import { LiveConfigCard } from './view-config.js';
import { SiteConfigCard } from './view-raspagem-site-config.js';
import { SiteHistory } from './view-raspagem-site-history.js';
import {
  crawlSummary,
  crawlSiteCards,
  motorBadge,
  nextDiscoveryLabel,
  phaseLabel,
  siteStateLabel,
  runDurationMs,
  etaLabel,
  type CrawlSummary,
  type CrawlSiteCard,
} from './raspagens-model.js';
import { probeBadge, probeText, skipText, type SiteConfigForm } from './raspagens-site.js';
import { crawlCatalog, SitesCatalogCard, type CatalogEntry } from './raspagens-catalog.js';

export interface ViewRaspagensProps {
  crawl?: Record<string, any>;
}

/** Ações do site enviadas ao `/dashboard-action.json` (nome histórico do
 * backend). `site` é o id do card do Jackett — igual às demais telas. */
const REPROCESS_ACTION = 'crawl-reprocess-errors';
const RESET_ACTION = 'crawl-reset';
/** Ajuste POR SITE (Fase 8). São ações NOVAS, separadas das globais de config
 * de propósito: o cartão `LiveConfigCard` de baixo continua mexendo no global
 * e não precisa saber que existe override por site. */
const SITE_SET_ACTION = 'crawl-site-config-set';
const SITE_RESET_ACTION = 'crawl-site-config-reset';
const SITE_PAUSE_ACTION = 'crawl-site-pause';

export function ViewRaspagens({ crawl }: ViewRaspagensProps) {
  const c = crawl || {};
  const summary = crawlSummary(c);
  const sites = crawlSiteCards(c);
  const catalog = crawlCatalog(c);
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
            ${summary.cursors.movie || summary.cursor ? html` · Cursor filmes: <code>${summary.cursors.movie || summary.cursor}</code>` : null}
            ${summary.cursors.tv_show ? html` · Cursor séries: <code>${summary.cursors.tv_show}</code>` : html` · Cursor séries: — (carga inicial)`}
            ${summary.nextDiscoveryAt != null && !summary.runOpen ? html` · Próxima descoberta: ${nextDiscoveryLabel(summary.nextDiscoveryAt)}` : null}
            ${summary.runOpen ? html` · Rodada aberta` : null}
          </p>
        </${Card}>

        <${Card} title="Vazão e Freios">
          <${StatNumber} value=${summary.pagesThisHour} target=${summary.maxPerHour || undefined} label="req / h" />
          <p style="color: var(--muted); margin-top: var(--space-2); font-size: var(--font-floor);">
            Pausa entre páginas: ${summary.delayMs}ms · Janela de ociosidade: ${summary.idleWindowMs}ms
          </p>
          <p style="color: var(--muted); margin-top: var(--space-1); font-size: var(--font-floor);">
            Erros seguidos: ${summary.errorStreak} · Canário de layout: ${summary.canaryStreak}
            · Sonda obrigatória: ${summary.probeBlock ? 'sim — só site com GO entra na rotação' : 'não'}
          </p>
        </${Card}>

      </div>

      <div style="margin-top: var(--space-4);">
        <${SitesCatalogCard}
          catalog=${catalog}
          cards=${sites}
          summary=${summary}
          pending=${pending}
          onToggle=${(entry: CatalogEntry) => handle(
            SITE_SET_ACTION,
            { site: entry.id, patch: { enabled: !entry.enabled } },
            undefined,
            entry.enabled ? `Site ${entry.id} desligado` : `Site ${entry.id} ligado`,
          )}
        />
      </div>

      ${sites.length === 0 ? html`
        <div class="painel-grid" style="margin-top: var(--space-4);">
          <${Card} title="Sites">
            <p style="color: var(--muted); font-size: var(--font-floor);">
              Sem estado de site — o motor ainda não abriu o <code>crawl.db</code> ou nenhum site está configurado.
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
            onTogglePause=${() => handle(
              SITE_PAUSE_ACTION,
              { site: card.id, paused: !card.paused },
              undefined,
              card.paused ? `Site ${card.id} retomado` : `Site ${card.id} pausado`,
            )}
          />
          <div style="margin-top: var(--space-3);">
            <${SiteConfigCard}
              key=${card.id + ':ajuste'}
              card=${card}
              summary=${summary}
              pending=${pending}
              onApply=${(patch: Partial<SiteConfigForm>) => handle(
                SITE_SET_ACTION,
                { site: card.id, patch },
                undefined,
                `Ajuste do site ${card.id} aplicado (${Object.keys(patch).length} campo(s))`,
              )}
              onReset=${() => handle(
                SITE_RESET_ACTION,
                { site: card.id },
                {
                  title: 'Voltar ao ajuste global',
                  message: `Descartar o ajuste próprio do site "${card.label}"?`,
                  detail: 'O site volta a herdar o global (ritmo, teto por hora, simulação e liga/desliga). O estado já raspado NÃO é tocado.',
                  confirmLabel: 'Voltar ao global',
                  danger: true,
                },
                `Ajuste do site ${card.id} descartado`,
              )}
            />
          </div>
        </div>
      `)}

      <div style="margin-top: var(--space-4);">
        <${LiveConfigCard}
          title="Configuração ao vivo da Raspagem"
          getAction="crawl-config-get"
          setAction="crawl-config-set"
          resetAction="crawl-config-reset"
          pollBlocks=${['crawl']}
          description="Ajustes do motor aplicados ao vivo (persistidos no SQLite, sem restart) — valem para TODOS os sites. Ligar/desligar cada site fica no cartão 'Sites da Raspagem' (o .env CRAWL_SITES é só o padrão); o ajuste próprio de cada site fica no cartão dele, acima. Campo divergente do .env aparece marcado como 'ao vivo'."
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
  /** Pausa manual do SITE (`crawl-site-pause`) — distinta da pausa do motor. */
  onTogglePause: () => void;
}

/** Card presentacional de UM site — sem hooks e sem fetch; a casca passa as
 * ações já ligadas ao `useAction`. */
export function SiteCard({ card, summary, pending, onReprocess, onReset, onTogglePause }: SiteCardProps) {
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
  const probe = probeBadge(card.probe);

  return html`
    <${Card} title=${card.label} badge=${badge}>
      <div class="painel-progress-row" style="display: flex; align-items: center; gap: var(--space-2);">
        <div style="flex: 1;"><${ProgressBar} percent=${card.progressPercent} variant=${card.progressPercent >= 100 ? 'ok' : 'warn'} /></div>
        <span style="font-weight: 600;">${card.progressPercent}%</span>
      </div>

      ${card.probe.verdict != null || card.probe.block ? html`
        <div class="painel-raspagem-probe" style="display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); flex-wrap: wrap;">
          <${Badge} text=${probe.text} variant=${probe.variant} />
          <span style="color: var(--muted); font-size: var(--font-floor);">${probeText(card.probe)}</span>
        </div>
      ` : null}

      <div style="display: flex; gap: var(--space-4); flex-wrap: wrap; margin-top: var(--space-3);">
        <${StatNumber} value=${card.magnetsFound} label="magnets vistos" />
        <${StatNumber} value=${card.newReleases} label="novos no índice" />
        <${StatNumber} value=${card.torrentPercent} label="% torrent (nas processadas)" />
        <${StatNumber} value=${card.ratePerHour} label="teto req / h" />
        <${StatNumber} value=${card.pendingRemaining === 0 && card.total > 0 ? 'concluído' : etaLabel(card.etaHours)} label="ETA" />
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
      ${card.partial > 0 ? html`
        <p style="color: var(--warn, #b58900); margin-top: var(--space-1); font-size: var(--font-floor);">
          ${card.partial} página(s) de série em andamento — retomam pelos cards já lidos${card.partialWork.length ? html` (${card.partialWork.map((p) => `${p.done}/${p.total}`).join(', ')})` : ''}.
        </p>
      ` : null}
      ${card.probe.skip ? html`
        <p style="color: var(--muted); margin-top: var(--space-1); font-size: var(--font-floor);">
          Pulado nesta volta: ${skipText(card.probe.skip)}.
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
        <button
          class="painel-btn ${card.paused ? 'painel-btn-accent' : ''}"
          disabled=${pending}
          onClick=${onTogglePause}
        >
          ${card.paused ? 'Retomar site' : 'Pausar site'}
        </button>
        <button class="painel-btn painel-btn-danger" disabled=${pending} onClick=${onReset}>
          Zerar Site
        </button>
      </div>

      <${SiteHistory} card=${card} />
    </${Card}>
  `;
}
