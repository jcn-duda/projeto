// GET /internal/activity — retorna se houve tráfego de usuário recente, para
// o sidecar Rust frear a raspagem quando o addon estiver sendo usado. Rota
// SEM config (montada antes de /:userConfig no register.ts). Autenticação:
// X-Indexer-Test-Token no header (mesmo token do painel).
import { Router } from 'express';
import { asyncRoute } from './async.js';
import type { AppServices } from './types.js';
import { recentUserTraffic } from '../providers/activity.js';
import * as log from '../utils/logger.js';

/** Default: 10 minutos — a mesma janela que o colhedor usa para considerar
 *  o addon "em uso" e frear a coleta contínua. */
const DEFAULT_WINDOW_MS = 600_000;

/**
 * Registra a rota GET /internal/activity no router fornecido.
 * O maestro (register.ts) monta esta rota ANTES do overlay /:userConfig.
 */
export function registerInternalActivity(router: Router, services: AppServices): void {
  router.get('/internal/activity',
    asyncRoute(async (req, res) => {
      // 1. Valida token (mesmo gate do painel)
      if (!services.config.jackett.testToken) {
        return res.status(503).json({ ok: false, error: 'diagnóstico desativado pelo operador' });
      }
      if (!services.authorized(services.config.jackett.testToken, req.get('X-Indexer-Test-Token'))) {
        return res.status(401).json({ ok: false, error: 'token de diagnóstico inválido' });
      }

      // 2. Lê window_ms da query (default 600_000 = 10 min)
      const rawWindow = req.query.window_ms;
      const windowMs = rawWindow != null ? Number(rawWindow) : DEFAULT_WINDOW_MS;
      if (!Number.isFinite(windowMs) || windowMs <= 0) {
        return res.status(400).json({ ok: false, error: 'window_ms deve ser um número positivo' });
      }

      // 3. Consulta a janela deslizante de tráfego de usuário
      const recent = recentUserTraffic(windowMs);
      log.debug(`[internal-crawl] activity: recent=${recent} window_ms=${windowMs}`);
      return res.json({ recent });
    })
  );
}
