import config from '../config.js';
import { MICO_ID } from './mico.js';
import { SAFE_INDEXER_ID } from './live-indexer-state.js';

/**
 * Quem a coleta consulta, POR FONTE, a partir da seleção da request.
 *
 * É a régua única do `wants` do `collectRaw` (o mesmo `mode`/`providers`/`ji`)
 * reusada pela rota read-only da sombra. Fonte que a coleta normal não
 * consultaria tem de responder `eligible:false` na sombra — senão o vazio
 * proposital do Node viraria "divergência de fonte" contra o nativo.
 *
 * BLUDV e Mico NÃO são tokens de `providers`: o primeiro depende só do
 * kill-switch do operador, o segundo da seleção `ji` (card virtual) mais o
 * `jackettMode`. Tratá-los como provider era o que os deixava sempre
 * inelegíveis na sombra.
 */
export type SourceName = 'jackett' | 'prowlarr' | 'torrentio' | 'bludv' | 'mico' | 'account';

export interface CollectionSelection {
  providers: string[];
  /** `both` ou o primeiro provider (mesma conta do `collectRaw`). */
  mode: string;
  jackettMode: boolean;
  skipSources: ReadonlySet<string>;
  /** Lista efetiva do `ji` (override da sombra ou o `ji` da request). */
  rawSelected: string[];
}

/**
 * `indexersOverride` só vale na sombra (read-only); no caminho de resposta é
 * `null` e a seleção é o `ji` do encoded — exatamente como antes.
 */
export function collectionSelection(
  options: { providers?: unknown; jackettIndexers?: unknown },
  skipSources: ReadonlySet<string> = new Set<string>(),
  indexersOverride: string[] | null = null,
): CollectionSelection {
  const providers = Array.isArray(options.providers) ? options.providers.map(String) : [];
  const mode = providers.includes('both') ? 'both' : providers[0] || config.provider;
  const requestIndexers = Array.isArray(options.jackettIndexers) ? options.jackettIndexers.map(String) : [];
  const selected = indexersOverride !== null ? indexersOverride : requestIndexers;
  const rawSelected = [...new Set(selected.filter((id) => SAFE_INDEXER_ID.test(String(id))))].map(String);
  return {
    providers,
    mode,
    jackettMode: mode === 'both' || providers.includes('jackett'),
    skipSources,
    rawSelected,
  };
}

function providerSelected(selection: CollectionSelection, name: string): boolean {
  return selection.mode === 'both' || selection.providers.includes(name);
}

/**
 * Espelha o `wants`/ramo de cada fonte do `collectRawLive`. `account` nunca é
 * fonte de sombra (inventário com efeitos) — fica de fora por definição.
 */
export function sourceWanted(source: SourceName | string, selection: CollectionSelection): boolean {
  if (selection.skipSources.has(source)) return false;
  // `demo` é o ramo isolado do `collectRaw` (responde do próprio lote antes de
  // qualquer tarefa): nenhuma fonte real é consultada nesse modo.
  if (selection.mode === 'demo') return false;
  switch (source) {
    case 'jackett':
    case 'prowlarr':
      return providerSelected(selection, source);
    case 'torrentio':
      return providerSelected(selection, 'torrentio') && config.torrentio.enabled;
    case 'mico':
      // Card virtual no `ji`; sem `ji`, vale o default do operador. Só existe
      // com o Jackett selecionado (é dele que o Mico herda a seleção).
      return selection.jackettMode
        && config.mico.enabled
        && (selection.rawSelected.length > 0
          ? selection.rawSelected.includes(MICO_ID)
          : config.mico.default);
    case 'bludv':
      // Fonte BR independente do PROVIDER: só o kill-switch do operador.
      return config.bludv.enabled;
    default:
      return false;
  }
}
