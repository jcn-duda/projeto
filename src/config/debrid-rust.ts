// Fronteira RUST do debrid (sidecar `adom-debrid`, 127.0.0.1:8710; e o
// `adom-search` in-process no gateway).
//
// Só flags que pertencem ao OUTRO processo mas que o Node precisa espelhar
// para decidir o que preparar/enviar. Quem executa a decisão continua sendo o
// Rust, que relê a mesma env.

export const debridRust = () => ({
  // `DEBRID_AL_CLEANUP` (default do corte ON no compose; ver
  // docs/debrid-al-check-rust.md §8). O Node usa a flag só para decidir se
  // PREPARA os fatos do check nativo (hold volátil + inventário). Com OFF, o
  // caminho sem limpeza não ganha leitura extra de `/magnet/status` e o corpo
  // do check fica idêntico ao anterior. A lista de valores é a MESMA que o
  // Rust aceita (`CleanupMode::parse`).
  alCleanup: ['on', '1', 'true', 'yes', 'rust'].includes(
    String(process.env.DEBRID_AL_CLEANUP || '').trim().toLowerCase(),
  ),
});
