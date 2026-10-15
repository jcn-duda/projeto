/**
 * Contrato mínimo do `stremio-addon-sdk` — só o que os e2e sintéticos usam,
 * não uma tipagem completa da lib. O pacote não publica tipos próprios; ele
 * fica em devDependencies como referência do protocolo, enquanto produção usa
 * o router Express de src/routes/addon-router.ts.
 *
 * `getRouter` devolve `any` de propósito: o router legado não casa com os
 * tipos `RequestHandler` do Express, e os e2e o montam somente como referência.
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
     * Retorna a interface que o `getRouter` transforma em rotas Express. O
     * shape interno do SDK não é contrato de produção deste projeto.
     */
    getInterface(): any;
  }

  function getRouter(addonInterface: unknown): any;
}
