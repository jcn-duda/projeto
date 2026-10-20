import config from '../config.js';

const ORIGIN_HOSTNAME_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const ORIGIN_HOST_V6_RE = /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

/**
 * Origin alcançável pelo próprio cliente; Host é validado antes de voltar no
 * aviso. O `streamsNeedRevalidation` que morava aqui saiu no F4.4: ele decidia
 * o `cacheMaxAge` do `/stream` do Node, que agora é do gateway nativo (a régua
 * equivalente é `cache_max_age_for_finish` no Rust).
 */
function originOf(req: { get(name: string): string | undefined; protocol: string }) {
  if (config.debrid.publicUrl) return config.debrid.publicUrl;
  const host = req.get('host');
  if (!host) return null;
  if (ORIGIN_HOSTNAME_RE.test(host) || ORIGIN_HOST_V6_RE.test(host)) {
    return `${req.protocol}://${host}`;
  }
  return null;
}

export { originOf };
