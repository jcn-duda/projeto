/**
 * Contrato mínimo do `stremio-addon-sdk` — só o que este projeto usa, não uma
 * tipagem completa da lib. O pacote não publica tipos próprios, então o módulo
 * é declarado aqui POR NOME (declaração ambiente) para que o
 * `require('stremio-addon-sdk')` de `src/app.js` tipe em vez de virar `any`.
 *
 * `getRouter` devolve `any` de propósito: o router do SDK não casa com os
 * tipos `RequestHandler` do Express, e forçar a compatibilidade só para o
 * `app.use(getRouter(...))` tipar viraria atrito sem ganho real.
 */

declare module 'stremio-addon-sdk' {
  interface StreamArgs {
    type: string;
    id: string;
  }

  interface StreamResponse {
    streams: unknown[];
    cacheMaxAge?: number;
    staleRevalidate?: number;
    staleError?: number;
  }

  class addonBuilder {
    constructor(manifest: unknown);

    defineStreamHandler(
      handler: (args: StreamArgs) => StreamResponse | Promise<StreamResponse>,
    ): void;

    /**
     * Retorna a interface que o `getRouter` transforma em rotas Express. É
     * `any` porque `src/addon.js` a muta (`module.exports.manifest =`) e não
     * modelamos o shape interno do SDK.
     */
    getInterface(): any;
  }

  function getRouter(addonInterface: unknown): any;
}
