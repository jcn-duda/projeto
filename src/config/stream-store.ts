// Ponte do Node com o store NATIVO de `streams:v21` (API administrativa do
// gateway, `adom-server::store_admin` em loopback).
//
// O SWR do corte mora no processo Rust (`data/streams.db`). Três coisas do Node
// precisam alcançá-lo: a invalidação por obra do `/resolve` (e dos workers), o
// `clear-cache` do painel e a leitura do `/stream-trace.json`. Quem executa é o
// Rust; aqui ficam só o interruptor e o endereço.
//
// `STREAM_STORE_RUST` nasce LIGADO (o corte nativo é o default desde o F4.4).
// Rollback: `STREAM_STORE_RUST=off` — o Node volta a limpar só o próprio L1 e o
// painel avisa que o cache nativo não foi limpo. A flag desliga o lado Rust
// também (ele lê a MESMA env).
export const streamStore = () => {
  const flag = String(process.env.STREAM_STORE_RUST || '').trim().toLowerCase();
  const timeoutMs = Number(process.env.STREAM_STORE_ADMIN_TIMEOUT_MS);
  const backoffMs = Number(process.env.STREAM_STORE_RUST_BACKOFF_MS);
  return {
    // Só um valor FALSO desliga, como as outras flags do operador.
    rust: !['off', 'false', '0', 'no', 'disabled'].includes(flag),
    url: (process.env.STREAM_STORE_ADMIN_URL || 'http://127.0.0.1:8711').trim(),
    // Token próprio; sem ele, os mesmos fallbacks do lado Rust
    // (`DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`, lido em tempo de chamada).
    token: String(process.env.STREAM_STORE_ADMIN_TOKEN || process.env.DEBRID_INTERNAL_TOKEN || '').trim(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 2000,
    // Depois de falhar em sequência, o cliente sossega (evita martelar um
    // gateway antigo/sem a rota a cada busca).
    backoffMs: Number.isFinite(backoffMs) && backoffMs >= 0 ? backoffMs : 30000,
  };
};
