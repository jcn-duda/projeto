/**
 * Guarda SSRF do link de download (`isSafeDownloadUrl`): a regra INTEIRA decide
 * no núcleo (`adom_core::is_safe_download_url`, golden contra o corpus do TS do
 * `esm` em `rust/golden/net-safety.jsonl`). Aqui é só a ponte napi; o que é
 * I/O (resolução de DNS pelo fetch, o fetch em si com `redirect: 'manual'`)
 * segue com o chamador.
 */
import { isIP } from 'node:net';
import { requireCore } from './rust-core.js';

/** Porte do `isSafeDownloadUrl` no `.node`. */
type NetSafetyCore = {
  isSafeDownloadUrlNapi(raw: string, allowPrivate: boolean): boolean;
};

function isSafeDownloadUrl(raw: string, allowPrivate = false): boolean {
  const core = requireCore() as unknown as NetSafetyCore;
  return core.isSafeDownloadUrlNapi(String(raw), allowPrivate === true);
}

/** Hosts de loopback literais; o IPv6 chega do parser entre colchetes. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * `true` só para base `http(s)` servida em loopback — a MESMA régua do
 * `adom_debrid::holds_feed::ensure_loopback`, que guarda o token interno do
 * lado Rust. Quem manda credencial para rota interna (`X-Indexer-Test-Token`)
 * consulta isto ANTES de anexar o header: destino externo desliga a fonte.
 *
 * Sem regex de host: o parser do WHATWG normaliza IPv4 (`127.1` vira
 * `127.0.0.1`) e devolve IPv6 entre colchetes (`[::1]`), e `isIP` distingue um
 * endereço de um domínio que apenas PARECE IP (`127.0.0.1.example.com` não é
 * loopback). Fora de `http(s)`, base vazia ou lixo: `false`.
 */
export function isLoopbackBase(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(String(raw ?? '').trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 127.0.0.0/8 inteiro, como o `IpAddr::is_loopback` do Rust.
  return isIP(host) === 4 && host.startsWith('127.');
}

export { isSafeDownloadUrl };
