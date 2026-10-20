// Fronteira RUST do debrid (sidecar `adom-debrid`, 127.0.0.1:8710; e o
// `adom-search` in-process no gateway).
//
// Só flags que pertencem ao OUTRO processo mas que o Node precisa espelhar
// para decidir o que preparar/enviar. Quem executa a decisão continua sendo o
// Rust, que relê a mesma env.

/** Modo da checagem AllDebrid nativa — espelho de `adom_debrid::alldebrid_mode::AlRustMode`. */
export type AlRustMode = 'off' | 'on' | 'shadow';

const AL_RUST_ON = ['on', '1', 'true', 'yes', 'rust'];
const AL_RUST_SHADOW = ['shadow', 'sombra'];

/**
 * `DEBRID_AL_RUST`, com os MESMOS apelidos de `AlRustMode::parse` no Rust.
 *
 * Lido por REQUISIÇÃO de propósito: é o gate da rota de reserva
 * (`/internal/debrid/check` responde 410 no modo `on`) e o rollback por env
 * (`DEBRID_AL_RUST=off`) tem que valer sem depender de quando o processo
 * carregou este módulo.
 *
 * O default do CÓDIGO continua `off` (é o mesmo do Rust); o default do CORTE
 * (`on`) vive no `docker-compose.yml`, onde Node e Rust leem a mesma env. Um
 * processo iniciado sem compose (teste, CLI) segue no caminho Node.
 */
export function alRustMode(): AlRustMode {
  const raw = String(process.env.DEBRID_AL_RUST || '').trim().toLowerCase();
  if (AL_RUST_ON.includes(raw)) return 'on';
  if (AL_RUST_SHADOW.includes(raw)) return 'shadow';
  return 'off';
}

export const debridRust = () => ({
  // `DEBRID_AL_CLEANUP` (default do corte ON no compose; ver
  // docs/debrid-al-check-rust.md §8). O Node usa a flag só para decidir se
  // PREPARA os fatos do check nativo (hold volátil + inventário). Com OFF, o
  // caminho de paridade (`DEBRID_AL_RUST=on` sem limpeza) não ganha leitura
  // extra de `/magnet/status` e o corpo do check fica idêntico ao anterior. A
  // lista de valores é a MESMA que o Rust aceita (`CleanupMode::parse`).
  alCleanup: ['on', '1', 'true', 'yes', 'rust'].includes(
    String(process.env.DEBRID_AL_CLEANUP || '').trim().toLowerCase(),
  ),
});
