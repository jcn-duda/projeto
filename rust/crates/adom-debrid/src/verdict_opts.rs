//! Montagem do `CheckOpts` da AllDebrid a partir do modo de limpeza, dos fatos
//! do feed de holds e do leitor durável. Extraído de `verdict.rs` para caber no
//! teto de linhas; o comportamento é o mesmo.

use std::time::Duration;

use crate::alldebrid::CheckOpts;
use crate::alldebrid_cleanup::{account_scope, env_truthy, CleanupMode, DurablePeek};
use crate::holds_feed::HoldsFacts;

use super::now_ms;

/// `CheckOpts` da AllDebrid nesta rodada. Três estados, do mais seguro ao mais
/// permissivo:
///
/// - limpeza OFF (default): read-only para APAGAR; fatos e `drop_*` são
///   ignorados. O filtro de upload (`adrm`) continua valendo;
/// - ON **sem** fatos: `inventory_loaded:false` + `holds_complete:false` — a
///   nativa segue read-only (`holds_incomplete`), como antes do feed;
/// - ON **com** fatos: drops do gateway (ou env), inventário/`knownBefore` e held
///   do lote; `holds_complete` só com [`HoldsFacts::covers`] (o flag
///   sozinho não autoriza).
///
/// `durable` é o leitor do `cache.db` do Node e é lido ANTES do early return:
/// o `adrm:v1` (anti-reenchimento) é filtro de UPLOAD, leitura read-only sem
/// efeito colateral, e vale mesmo com a limpeza desligada — sem ele a checagem
/// re-sobe ao `/magnet/upload` o hash que a limpeza apagou de propósito. Só o
/// `CheckOpts.durable` (a guarda `adprot`/`adsub` da limpeza) depende da flag.
pub(crate) fn alldebrid_opts(
    cleanup: CleanupMode,
    timeout: Option<Duration>,
    facts: Option<&HoldsFacts>,
    hashes: &[String],
    api_key: &str,
    durable: &DurablePeek,
) -> CheckOpts {
    let mut opts = CheckOpts {
        timeout,
        cleanup,
        blocked: durable.blocked_hashes(&account_scope(api_key), now_ms()),
        ..CheckOpts::default()
    };
    if !cleanup.is_on() {
        // READ-ONLY para apagar: nem o inventário próprio é lido (`cleanup_run`
        // sai no primeiro portão) e o `adprot`/`adsub` não entra no `CheckOpts`.
        return opts;
    }
    opts.durable = Some(std::sync::Arc::new(durable.clone()));
    match facts {
        Some(facts) => {
            opts.drop_ready = facts
                .drop_ready
                .unwrap_or_else(|| env_truthy("DEBRID_DROP_READY", true));
            opts.drop_uncached = facts
                .drop_uncached
                .unwrap_or_else(|| env_truthy("DEBRID_DROP_UNCACHED", true));
            opts.inventory_loaded = facts.inventory_loaded;
            opts.known_before = facts.known_before_set();
            opts.held = facts.held_set();
            // Reconfere a cobertura do lote: `holdsComplete` sem `evaluated`
            // cobrindo os hashes não vale nada.
            opts.holds_complete = facts.covers(hashes);
        }
        None => {
            // Sem feed: os `drop_*` do ambiente ficam como antes, mas
            // `holds_complete:false` suprime o plano (`holds_incomplete`).
            opts.drop_ready = env_truthy("DEBRID_DROP_READY", true);
            opts.drop_uncached = env_truthy("DEBRID_DROP_UNCACHED", true);
        }
    }
    opts
}
