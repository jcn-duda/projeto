//! Identificador do run do colhedor (T1-B3).
//!
//! O mesmo id vai para a lease do slot durável ([`crate::lease::Lease`]) e para
//! o journal ([`crate::journal`]) da MESMA execução — é esse par que permite ao
//! replay de boot saber se o run interrompido ainda tem obra no slot.
//!
//! O sufixo é o pid: o id é legível no log e diz de qual processo ele veio, o
//! que separa "run desta sessão" de "run de uma sessão que morreu".

use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Prefixo de todo run (`h-` de harvest) — o teste do contrato amarra.
pub const RUN_ID_PREFIX: &str = "h-";

/// `h-<now_ms>-<seq>-<pid>`: único no processo e ordenável no tempo.
pub fn new_run_id(now_ms: i64) -> String {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{RUN_ID_PREFIX}{now_ms}-{seq}-{}", std::process::id())
}
