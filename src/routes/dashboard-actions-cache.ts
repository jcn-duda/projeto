// Ação `clear-cache` do /dashboard-action.json.
//
// Extraída de dashboard-actions.ts para o arquivo não passar da catraca de 400
// linhas (regra do repositório: dividir, não bless) quando o F4.4a acrescentou a
// limpeza do `streams.db` nativo.
//
// Três escopos do painel, com alvos diferentes em cada lado:
//
// | `scope` | L1 do Node | store NATIVO (`streams.db`) |
// |---|---|---|
// | ausente (global) | `cache.clear()` | limpa o namespace todo |
// | `{namespace}` | aquele namespace | só quando é `streams` |
// | `{installation:true}` | chaves `streams:*` do segmento | chaves com o MESMO `:<scope>` |
//
// A limpeza do nativo é best-effort e o resultado vai no campo `native` da
// resposta: o operador tem que VER que o SWR do corte não foi limpo (gateway
// antigo/sem a rota, ou ponte em backoff) em vez de supor que foi.
import type { AppServices } from './types.js';
import type express from 'express';
import { streamsCacheScope } from '../utils/request-key.js';
import { clearNativeStreams, type NativeClearResult } from '../utils/streams-store-native.js';

export type ClearCacheDeps = {
  services: AppServices;
  req: express.Request;
  res: express.Response;
  action: string;
};

type AppliedScope = { kind: 'global' | 'namespace' | 'installation'; namespace?: string };

/** Resposta do `clear-cache`; `native` só é omitido quando o escopo não o alcança. */
export async function clearCache({ services, req, res, action }: ClearCacheDeps): Promise<express.Response> {
  const entriesBefore = services.cache.size();
  const scope = req.body?.scope as { namespace?: unknown; installation?: unknown } | null | undefined;
  let removed = entriesBefore;
  let appliedScope: AppliedScope = { kind: 'global' };
  // Escopo efetivo no store NATIVO: `{suffix?}` = limpa (tudo ou a instalação);
  // `null` = este escopo não alcança o cache do corte.
  let nativeScope: { suffix?: string } | null = {};
  if (scope != null) {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      return res.status(400).json({ ok: false, error: 'escopo de cache inválido' });
    }
    const namespace = typeof scope.namespace === 'string' ? scope.namespace : '';
    const installation = scope.installation === true;
    if (namespace && installation) {
      return res.status(400).json({ ok: false, error: 'escolha namespace ou instalação, não os dois' });
    }
    if (namespace) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(namespace)) {
        return res.status(400).json({ ok: false, error: 'namespace de cache inválido' });
      }
      removed = services.cache.clearNamespace(namespace);
      appliedScope = { kind: 'namespace', namespace };
      // O store nativo só tem o namespace `streams`.
      nativeScope = namespace === 'streams' ? {} : null;
    } else if (installation) {
      if (!services.runtime.prefix()) {
        return res.status(400).json({ ok: false, error: 'escopo por instalação exige URL configurada' });
      }
      const suffix = `:${streamsCacheScope(services.runtime.opts())}`;
      removed = services.cache.clearWhere((key) => key.startsWith('streams:') && key.endsWith(suffix));
      appliedScope = { kind: 'installation' };
      // A chave nativa termina no MESMO `:<scope>`; o sufixo também recorta por
      // instalação no `streams.db`.
      nativeScope = { suffix };
    } else {
      return res.status(400).json({ ok: false, error: 'escopo de cache inválido' });
    }
  } else {
    services.cache.clear();
  }
  const native: NativeClearResult = nativeScope == null
    ? { attempted: false, ok: false, removed: 0, error: 'escopo fora do store nativo' }
    : await clearNativeStreams(nativeScope);
  services.metrics.count('dashboard.cache.clear');
  return res.json({
    ok: true,
    action,
    scope: appliedScope,
    removed,
    entriesBefore,
    entriesAfter: services.cache.size(),
    native,
  });
}
