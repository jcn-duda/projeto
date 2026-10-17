/**
 * Magnet URI do post — sanitização e montagem do magnet padrão.
 *
 * A URI ORIGINAL do post (com `dn=` e trackers do tracker) é guardada no banco
 * permanente (`utils/magnet-bank.ts`), que não tem TTL nem cota. Aqui ficam só
 * as regras PURAS que o banco usa ao gravar — e elas decidem INTEIRAS no
 * núcleo (`rust/crates/adom-napi/src/lib.rs`: `sanitizeMagnet`/`defaultMagnet`;
 * lógica em `adom-core::magnet_uri`, golden `magnet_uri` contra o TS do `esm`).
 *
 * Contrato (mantido na borda):
 * - Só aceita `magnet:?` cujo `xt=urn:btih:` bate com o hash da chave — o
 *   `extractInfoHash` genérico aceitava `btih:` em qualquer ponto e deixava
 *   `dn=btih:<hash>` forjar a identidade; a fonte aqui é SÓ o `xt=`.
 * - Trackers com credencial (parâmetro nomeado ou token de 16+ chars no
 *   caminho/query) saem; o piso de TRACKERS é garantido e há teto REAL de
 *   2048 bytes, com o `dn=` truncado por code point.
 * - Devolve `null` se o resultado equivale ao `defaultMagnet(hash)`.
 */
import { nativeCore } from './native-core.js';

/** Funções de magnet no `.node` (camelCase do napi-rs). */
type MagnetCore = {
  sanitizeMagnet(uri: string | null, infoHash: string): string | null;
  defaultMagnet(infoHash: string): string;
};

const magnetCore = () => nativeCore<MagnetCore>();

/** Magnet padrão (mesmo formato de common.ts, sem importar). */
function defaultMagnet(infoHash: string): string {
  return magnetCore().defaultMagnet(infoHash);
}

/**
 * Sanitiza a URI de magnet: valida o hash pelo `xt`, remove credenciais,
 * deduplica e remonta com xt/dn/tr sob teto real de bytes. Devolve null se
 * equivaler ao magnet padrão.
 */
function sanitizeMagnet(uri: string, hash: string): string | null {
  return magnetCore().sanitizeMagnet(uri || null, hash) ?? null;
}

export { sanitizeMagnet, defaultMagnet };
