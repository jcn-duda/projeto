// Rotas da ponte do colhedor NATIVO usadas pelos testes de ações do painel.
//
// A pausa/drenagem é do gateway Rust: o mock ECOA o pedido para a rota conferir
// o contrato de "estado efetivo" em vez de uma fila local que não existe mais.
export function harvestDashboardRoutes() {
  return [
    {
      match: '/harvest/pause',
      handler: (_url: string, init?: RequestInit) => ({
        paused: JSON.parse(String(init?.body || '{}')).paused === true,
      }),
    },
    { match: '/harvest/drain', handler: () => ({ drained: 0 }) },
    { match: '/harvest/clear', handler: () => ({ cleared: 0 }) },
    {
      match: /\/harvest(\?|$)/,
      handler: () => ({
        ok: true,
        enabled: true,
        paused: false,
        intervalMs: 60_000,
        maxPerHour: 10,
        queriesThisHour: 0,
        depth: 0,
        inflight: false,
        preview: [],
        last: [],
        counters: { drained: 0, failed: 0 },
        store: 'data/streams.db',
      }),
    },
  ];
}
