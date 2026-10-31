// Ponte do Node com o store NATIVO de `streams:v21` (API administrativa do
// gateway, `adom-server::store_admin` em loopback).
//
// O SWR do corte mora no processo Rust (`data/streams.db`). Três coisas do Node
// precisam alcançá-lo: a invalidação por obra do `/resolve` (e dos workers), o
// `clear-cache` do painel e a leitura do `/stream-trace.json`. Quem executa é o
// Rust; aqui ficam só o endereço e o token.
//
// Não há interruptor: o store nativo é incondicional desde o F4.4. Rollback é
// imagem/commit anterior, nunca env.
export const streamStore = () => {
  const timeoutMs = Number(process.env.STREAM_STORE_ADMIN_TIMEOUT_MS);
  const backoffMs = Number(process.env.STREAM_STORE_RUST_BACKOFF_MS);
  const drainTimeoutMs = Number(process.env.HARVEST_DRAIN_BRIDGE_TIMEOUT_MS);
  // A varredura manual da AllDebrid (`POST /sweeps/run`) também só responde
  // depois de varrer a conta inteira. Prazo próprio e longo; o GET do status
  // continua no `timeoutMs` curto.
  const sweepTimeoutMs = Number(process.env.SWEEP_RUN_BRIDGE_TIMEOUT_MS);
  // A drenagem manual do warmer do RD (`POST /rd-warm/drain`) também só responde
  // depois de sondar a conta inteira. Prazo próprio e longo; o GET do status
  // continua no `timeoutMs` curto.
  const rdWarmDrainTimeoutMs = Number(process.env.RD_WARM_DRAIN_BRIDGE_TIMEOUT_MS);
  // Catálogo da conta (`/account-catalog/*` na 8711). Leituras têm prazo curto;
  // o status é polled pelo painel a cada 3 s; varredura, auditoria e deleção
  // andam a conta inteira (com backoff), então o prazo é longo. Vencer não
  // pausa a ponte: a operação segue no gateway.
  const catalogReadTimeoutMs = Number(process.env.ACCOUNT_CATALOG_READ_TIMEOUT_MS);
  const catalogStatusTimeoutMs = Number(process.env.ACCOUNT_CATALOG_STATUS_TIMEOUT_MS);
  const catalogRunTimeoutMs = Number(process.env.ACCOUNT_CATALOG_RUN_TIMEOUT_MS);
  return {
    url: (process.env.STREAM_STORE_ADMIN_URL || 'http://127.0.0.1:8711').trim(),
    // Token próprio; sem ele, os mesmos fallbacks do lado Rust
    // (`DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`, lido em tempo de chamada).
    token: String(process.env.STREAM_STORE_ADMIN_TOKEN || process.env.DEBRID_INTERNAL_TOKEN || '').trim(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000,
    // Depois de falhar em sequência, o cliente sossega (evita martelar um
    // gateway antigo/sem a rota a cada busca).
    backoffMs: Number.isFinite(backoffMs) && backoffMs >= 0 ? backoffMs : 30000,
    // O `POST /harvest/drain` só responde DEPOIS de drenar (uma obra consulta
    // ~20 indexers com pausa entre eles: dezenas de segundos). Com os 2 s das
    // outras rotas o botão "Drenar" nunca respondia. Fica abaixo dos 300 s do
    // `requestTimeout` do servidor HTTP do Node, que cortaria a ação antes.
    drainTimeoutMs: Number.isFinite(drainTimeoutMs) && drainTimeoutMs > 0 ? drainTimeoutMs : 270_000,
    // Fica também abaixo dos 300 s do `requestTimeout` do servidor HTTP do Node.
    sweepTimeoutMs: Number.isFinite(sweepTimeoutMs) && sweepTimeoutMs > 0 ? sweepTimeoutMs : 120_000,
    // O drain sonda a fila item a item na API do RD: dezenas de segundos. Fica
    // abaixo dos 300 s do `requestTimeout` do servidor HTTP do Node.
    rdWarmDrainTimeoutMs: Number.isFinite(rdWarmDrainTimeoutMs) && rdWarmDrainTimeoutMs > 0 ? rdWarmDrainTimeoutMs : 90_000,
    catalogReadTimeoutMs: Number.isFinite(catalogReadTimeoutMs) && catalogReadTimeoutMs > 0 ? catalogReadTimeoutMs : 5_000,
    catalogStatusTimeoutMs: Number.isFinite(catalogStatusTimeoutMs) && catalogStatusTimeoutMs > 0 ? catalogStatusTimeoutMs : 3_000,
    catalogRunTimeoutMs: Number.isFinite(catalogRunTimeoutMs) && catalogRunTimeoutMs > 0 ? catalogRunTimeoutMs : 270_000,
  };
};
