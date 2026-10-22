// Métricas do gateway Rust que o PAINEL lê (Fase 0.7 — "mais Rust, menos TS").
//
// Com o `/stream` no gateway, os contadores `search.*` do Node congelam. As
// métricas reais vivem em DUAS superfícies, com regras diferentes:
//
// - `:7000/metrics` — público, SEM token (`adom-server::proxy`): `account.*`,
//   `index.*`/`bank.*` e `debrid.al.*`.
// - `:8710/metrics` — API interna do debrid, token no header
//   `X-Indexer-Test-Token`: `rust.debrid.*` e a limpeza da AllDebrid.
//
// O painel não pode depender de nenhuma delas: prazo curto e fail-open. Sem
// resposta, o bloco `metrics` sai sem `native` — nunca com zero inventado.
export const nativeMetrics = () => {
  const timeoutMs = Number(process.env.GATEWAY_METRICS_TIMEOUT_MS);
  return {
    // Endereço do gateway. Porta própria de propósito: no container o gateway
    // ocupa a 7000 e o Node nasce na 7100 (`PORT=7100` no entrypoint).
    gatewayUrl: (process.env.GATEWAY_METRICS_URL || 'http://127.0.0.1:7000').trim(),
    // Mesma URL/token do adaptador Rust (`rust-remote.ts`): a 8710 é uma só.
    debridUrl: (process.env.DEBRID_INTERNAL_URL || 'http://127.0.0.1:8710').trim(),
    // Vazio cai em `JACKETT_TEST_TOKEN` na hora da chamada — a MESMA ordem do
    // `adom-debrid` (`DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`).
    token: String(process.env.DEBRID_INTERNAL_TOKEN || '').trim(),
    // Curto: é leitura de painel, não caminho de busca. Um gateway travado
    // atrasa o poll em no máximo isto (as duas fontes vão em paralelo).
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 400,
  };
};
