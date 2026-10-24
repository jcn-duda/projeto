// Timer do crawler (Fase 4 do plano "Raspagem total"): cadência VIVA
// rearmável. Extraído de `crawler.ts` pela catraca de 400 linhas. O timer não
// pode ficar preso ao valor estático do `.env`: o painel muda o ritmo sem
// restart, então `rearm` compara o valor vivo com o armado e faz clear+set.
// Módulo sem estado global: a fábrica devolve as operações sobre um timer
// próprio, e o motor injeta `isStarted`/`tick` por closure (sem ciclo).
import type { CrawlerEffectiveConfig } from '../utils/crawler-live-schema.js';

export interface CrawlSchedulerDeps {
  isStarted(): boolean;
  tick(): Promise<void>;
  warn(message: string): void;
  onDisabled(): void;
}

/** Cadência: acompanha o delay vivo, com piso (não martelar) e teto. */
function intervalMs(live: CrawlerEffectiveConfig): number {
  return Math.max(500, Math.min(live.delayMs, 60_000));
}

export function createCrawlScheduler(deps: CrawlSchedulerDeps) {
  let timer: NodeJS.Timeout | null = null;
  let armedMs = 0;

  function disarm(): void {
    if (timer) clearInterval(timer);
    timer = null;
    armedMs = 0;
  }

  /** Rearma quando a cadência viva diverge da armada. Nunca cria um segundo
   * timer: se há um armado, ele é `clear`ado antes do novo `set`; e uma config
   * DESLIGADA não arma nada — quem liga é o `sync` (via `onConfigChange`). */
  function rearm(live: CrawlerEffectiveConfig): void {
    if (!deps.isStarted() || !live.enabled) return;
    const next = intervalMs(live);
    if (timer && next === armedMs) return;
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      deps.tick().catch((err) => deps.warn(err instanceof Error ? err.message : String(err)));
    }, next);
    timer.unref();
    armedMs = next;
  }

  /** Alinha ao critério vivo (start e `onConfigChange` do crawler-live). */
  function sync(live: CrawlerEffectiveConfig): void {
    if (!deps.isStarted()) return;
    if (!live.enabled) {
      if (timer) {
        disarm();
        deps.onDisabled();
      }
      return;
    }
    rearm(live);
  }

  return { rearm, disarm, sync };
}
