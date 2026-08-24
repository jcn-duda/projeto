import config from '../config.js';

interface StreamResultMeta {
  streams?: any[];
  partial?: boolean;
  needsDebridRefresh?: boolean;
  debridKnown?: boolean;
}

const ORIGIN_HOSTNAME_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const ORIGIN_HOST_V6_RE = /^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

function streamsNeedRevalidation({ streams = [], partial, needsDebridRefresh, debridKnown }: StreamResultMeta = {}) {
  return !streams.length || partial || needsDebridRefresh || debridKnown === false;
}

/** Origin alcançável pelo próprio cliente; Host é validado antes de voltar no aviso. */
function originOf(req: { get(name: string): string | undefined; protocol: string }) {
  if (config.debrid.publicUrl) return config.debrid.publicUrl;
  const host = req.get('host');
  if (!host) return null;
  if (ORIGIN_HOSTNAME_RE.test(host) || ORIGIN_HOST_V6_RE.test(host)) {
    return `${req.protocol}://${host}`;
  }
  return null;
}

export { originOf, streamsNeedRevalidation };
