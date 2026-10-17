/**
 * Guarda SSRF do link de download (`isSafeDownloadUrl`): a regra INTEIRA decide
 * no núcleo (`adom_core::is_safe_download_url`, golden contra o corpus do TS do
 * `esm` em `rust/golden/net-safety.jsonl`). Aqui é só a ponte napi; o que é
 * I/O (resolução de DNS pelo fetch, o fetch em si com `redirect: 'manual'`)
 * segue com o chamador.
 */
import { requireCore } from './rust-core.js';

/** Porte do `isSafeDownloadUrl` no `.node`. */
type NetSafetyCore = {
  isSafeDownloadUrlNapi(raw: string, allowPrivate: boolean): boolean;
};

function isSafeDownloadUrl(raw: string, allowPrivate = false): boolean {
  const core = requireCore() as unknown as NetSafetyCore;
  return core.isSafeDownloadUrlNapi(String(raw), allowPrivate === true);
}

export { isSafeDownloadUrl };
