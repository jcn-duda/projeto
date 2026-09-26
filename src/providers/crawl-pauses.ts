// Política de pausa automática do motor de raspagem (plano "Raspagem total",
// Fase 3) — funções e estado PUROS, sem rede e sem armazenamento. O motor
// (crawler.ts) alimenta os desfechos de página e consulta as decisões daqui;
// separar a política torna o canário e o streak de erros testáveis sem subir
// o motor nem o adaptador.
//
// Duas pausas automáticas, ambas conservadoras:
//
//   - STREAK DE ERROS do site: 403/429/5xx, `blocked_host` e o desafio do
//     Cloudflare provam que o SITE está fora/bloqueando, não que uma página
//     quebrou. N erros SEGUIDOS nessa classe pausam o site. Timeout, DNS e
//     quebra de parse de UMA página NÃO entram: pausar a raspagem inteira por
//     um botão quebrado seria pior que o defeito.
//
//   - CANÁRIO DE LAYOUT: N páginas SEGUIDAS que antes publicavam torrent e
//     agora respondem "sem botão nenhum" pausam com "layout mudou?". O sinal
//     "antes publicava" NÃO pode vir do store: o refresh de lastmod zera
//     `releases` (o conteúdo mudou, o dado antigo não vale), então o canário
//     mantém a própria memória por URL (última visita que VALIDOU torrents).
//     Ela é do processo e re-aprende depois de restart — limitação honesta:
//     o canário precisa de uma passada que valide torrents por processo.

/** Classe de erro que prova o site indisponível/bloqueando (não a página). */
const SITE_LEVEL_ERROR_RE = /\b403\b|\b429\b|\b5\d{2}\b|blocked_host|challenge|cloudflare|just a moment/i;

/**
 * O texto do erro pertence à classe "site fora/bloqueado"? Casa status HTTP
 * (403/429/5xx), host bloqueado pela segurança do resolver (`blocked_host:…`)
 * e o desafio do Cloudflare. Sem rede, só string.
 */
export function isSiteLevelError(text: string): boolean {
  return SITE_LEVEL_ERROR_RE.test(String(text || ''));
}

/**
 * Maior lastmod (ISO) da leva descoberta; `''` quando nenhum é legível.
 * Compara por `Date.parse` (ISO-8601 ordena, mas a data pode vir torta do
 * sitemap) e, com ilegíveis misturados, mantém o primeiro — não inventa data
 * nem deixa um lastmod corrompido regredir o cursor.
 */
export function maxLastmod(urls: readonly { lastmod?: string }[]): string {
  let best = '';
  let bestTime = -Infinity;
  for (const entry of Array.isArray(urls) ? urls : []) {
    const lastmod = String(entry?.lastmod || '');
    if (!lastmod) continue;
    const time = Date.parse(lastmod);
    if (Number.isFinite(time)) {
      if (time > bestTime) {
        bestTime = time;
        best = lastmod;
      }
    } else if (!best) {
      best = lastmod;
    }
  }
  return best;
}

/** Motivo de pausa automática (a pausa manual é outra coisa: `setPaused`). */
export type AutoPauseReason = 'error-streak' | 'layout';

export interface PauseLimits {
  /** Erros de site SEGUIDOS que pausam (CRAWL_ERROR_PAUSE_STREAK). */
  errorPauseStreak: number;
  /** Páginas SEGUIDAS que perderam os botões (CRAWL_LAYOUT_CANARY). */
  layoutCanary: number;
}

/** Desfecho de UMA página, na forma que a política entende. */
export interface PageOutcomeSignal {
  kind: 'done' | 'no-torrent' | 'no-work' | 'error' | 'simulated';
  siteLevelError?: boolean;
  releases?: number;
}

/** Teto da memória do canário (URLs): ~50k números, alguns MB no pior caso. */
const PRIOR_MAX = 50_000;

/**
 * Estado da pausa automática de UM site. `observePage` é o coração: recebe o
 * desfecho já classificado pelo motor e devolve o motivo de pausa (ou null).
 */
export class CrawlPausePolicy {
  private errorStreak = 0;
  private canaryStreak = 0;
  private priorReleases = new Map<string, number>();

  /** Erros de site SEGUIDOS até agora (observabilidade do painel). */
  get errorStreakCount(): number { return this.errorStreak; }

  /** Páginas SEGUIDAS sem botões (com torrent na visita anterior). */
  get canaryStreakCount(): number { return this.canaryStreak; }

  /**
   * Registra o desfecho de uma página. Regras:
   * - erro de site → streka; atinge o limite → `error-streak`;
   * - erro comum (timeout/parse) → não conta e não zera o canário (indefinido);
   * - `done`/`no-work` provam que o layout respondeu → zera AMBOS os streaks;
   * - `no-torrent` sem torrent prévio é página só-streaming: não é evento do
   *   canário, mas prova que o site respondeu → zera só o streak de erros;
   * - `no-torrent` com torrent prévio é evento do canário.
   */
  observePage(url: string, signal: PageOutcomeSignal, limits: PauseLimits): AutoPauseReason | null {
    const key = String(url || '');
    if (signal.kind === 'error') {
      if (signal.siteLevelError) {
        this.errorStreak += 1;
        if (this.errorStreak >= Math.max(1, limits.errorPauseStreak)) return 'error-streak';
      }
      return null;
    }
    if ((signal.kind === 'done' || signal.kind === 'simulated') && (signal.releases ?? 0) > 0) {
      this.rememberPrior(key, signal.releases as number);
    }
    // `simulated` provou o MESMO layout com botões que o `done` (leu releases);
    // só não gravou — para o canário e o streak ela vale como página sã.
    if (signal.kind === 'done' || signal.kind === 'no-work' || signal.kind === 'simulated') {
      this.errorStreak = 0;
      this.canaryStreak = 0;
      return null;
    }
    // no-torrent
    this.errorStreak = 0;
    const prior = this.priorReleases.get(key) || 0;
    if (prior <= 0) return null;
    this.canaryStreak += 1;
    return this.canaryStreak >= Math.max(1, limits.layoutCanary) ? 'layout' : null;
  }

  /** Falha da descoberta entra no MESMO streak (é o site que não responde). */
  observeSiteFailure(text: string, limits: PauseLimits): AutoPauseReason | null {
    if (!isSiteLevelError(text)) return null;
    this.errorStreak += 1;
    return this.errorStreak >= Math.max(1, limits.errorPauseStreak) ? 'error-streak' : null;
  }

  /** Descoberta bem-sucedida prova que o site respondeu: zera o streak. */
  observeSiteSuccess(): void {
    this.errorStreak = 0;
  }

  reset(): void {
    this.errorStreak = 0;
    this.canaryStreak = 0;
    this.priorReleases.clear();
  }

  private rememberPrior(url: string, releases: number): void {
    this.priorReleases.delete(url);
    this.priorReleases.set(url, releases);
    while (this.priorReleases.size > PRIOR_MAX) {
      const oldest = this.priorReleases.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.priorReleases.delete(oldest);
    }
  }
}
