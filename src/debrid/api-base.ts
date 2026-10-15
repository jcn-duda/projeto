/**
 * Base da API lida na hora da chamada, não na carga do módulo.
 * Sem a env, permanece o default de produção. Env presente porém vazia,
 * ou com host/esquema recusado, não cai nesse default: quem chama falha
 * aqui, antes de qualquer HTTP (o mesmo preço do lado Rust).
 * `https` vale em qualquer host; `http` só em 127.0.0.1 ou localhost.
 */
const REJECTED = /[\s\u0000-\u001f\u007f-\u009f@\\#?]/;

export function apiBaseFromEnv(envName: string, fallback: string): string {
  if (!Object.hasOwn(process.env, envName)) return fallback;
  const trimmed = String(process.env[envName] ?? '').trim().replace(/\/+$/, '');
  const sep = trimmed.indexOf('://');
  const scheme = sep > 0 ? trimmed.slice(0, sep).toLowerCase() : '';
  const rest = sep > 0 ? trimmed.slice(sep + 3) : '';
  const authority = rest.split('/')[0] ?? '';
  const colon = authority.indexOf(':');
  const host = colon === -1 ? authority : authority.slice(0, colon);
  const port = colon === -1 ? '' : authority.slice(colon + 1);
  const portOk = colon === -1 || /^[0-9]+$/.test(port);
  const loopback = host.toLowerCase() === '127.0.0.1' || host.toLowerCase() === 'localhost';
  const allowed = trimmed.length > 0
    && !REJECTED.test(trimmed)
    && rest.length > 0
    && host.length > 0
    && portOk
    && (scheme === 'https' || (scheme === 'http' && loopback));
  if (!allowed) {
    throw new Error(`${envName} só aceita https ou http em 127.0.0.1/localhost`);
  }
  return `${scheme}://${rest}`;
}
