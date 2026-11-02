// Cobertura BR ⚡ da coorte popular, medida pelo gateway (`GET /br-coverage` na
// admin 8711, `adom-server::br_coverage`). O Node só lê para o bloco `f3` do
// painel; admin fora devolve "não medido", nunca 0% falso.
import config from '../config.js';

type NativeBrCoverage = Record<string, unknown>;

const notMeasured = (): NativeBrCoverage => ({
  enabled: config.f3.enabled && config.f3.br.enabled,
  baselineAt: 0,
  samples: 0,
  latest: null,
  popularCoverage: null,
  brWarmRate: null,
  discoveryRate: null,
  counters: { sample: 0 },
  _origem: { popularCoverage: 'naomedido', brWarmRate: 'naomedido', discoveryRate: 'naomedido' },
});

export async function brCoverageStatus(): Promise<NativeBrCoverage> {
  const base = String(config.streamStore.url || '').trim().replace(/\/+$/, '');
  const token = config.streamStore.token || config.jackett.testToken || '';
  if (!base || !token) return notMeasured();
  try {
    const resp = await fetch(`${base}/br-coverage`, {
      headers: { 'X-Indexer-Test-Token': token },
      signal: AbortSignal.timeout(config.streamStore.timeoutMs),
    });
    if (!resp.ok) return notMeasured();
    const body = await resp.json() as NativeBrCoverage | null;
    return body && typeof body === 'object' && 'samples' in body ? body : notMeasured();
  } catch {
    return notMeasured();
  }
}
