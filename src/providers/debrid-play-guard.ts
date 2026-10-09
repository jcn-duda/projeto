import type { Stream } from '../../types/domain.js';

/**
 * Decisão de SAÍDA de um stream após a checagem de cache. Ponto ÚNICO da regra
 * "pack multiobra ADMITIDO nunca vira torrent P2P inteiro": o cliente baixaria
 * a coleção toda e tocaria o MAIOR arquivo, quase sempre o filme errado.
 * A marca é `_multiWorkAdmitted` (feature BR_MULTIWORK_PACKS, nativa por
 * padrão; `false` é o kill-switch), nunca o
 * `_multiWork` genérico: com o kill-switch desligado nada é admitido e o
 * comportamento anterior é preservado. Extraída do `debrid-pipeline-core`
 * (que está no teto de 400 linhas) para manter a regra auditável e testável.
 *
 * - `resolve`: sai pela URL /resolve (debrid). Cached, ou não-cached com
 *   `resolveUncached=true` — o contrato explícito do operador é respeitado.
 * - `p2p`: torrent puro (comportamento antigo, só sem admissão multiobra).
 * - `drop`: multiobra admitida fora do cache sem `resolveUncached`; não vai à lista.
 *
 * `degraded` é o ramo `known:false` do `applyDebrid`: como o serviço não soube
 * informar cache, o comportamento histórico manda TUDO pelo `/resolve`. O pack
 * admitido continua fora dessa regra — uma coleção fria só resolve com
 * `resolveUncached`; sem o knob ela é descartada, nunca oferecida.
 */
export type PlayDisposition = 'resolve' | 'p2p' | 'drop';

function playDisposition(
  stream: Stream,
  { cached, resolveUncached, degraded = false }: { cached: boolean; resolveUncached: boolean; degraded?: boolean },
): PlayDisposition {
  if (stream.infoHash && cached) return 'resolve';
  if (stream._multiWorkAdmitted) return resolveUncached ? 'resolve' : 'drop';
  if (degraded) return 'resolve';
  return resolveUncached ? 'resolve' : 'p2p';
}

export { playDisposition };
