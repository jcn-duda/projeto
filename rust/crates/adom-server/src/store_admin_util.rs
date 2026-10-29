//! Utilitários do `store_admin`, fora do roteador por causa da catraca.
//!
//! Duas funções puras que o `store_admin` usa para a sonda live e para o
//! relógio da graça. Sem estado, sem env, sem I/O. Mais a comparação de token,
//! que veio para cá pela catraca e é reexportada (`store_admin::tokens_match`).

/// Hash do item para a sonda live: o campo quando existe (item P2P); senão o
/// segmento de 40 hex da URL relativa de `/resolve`.
pub(super) fn stream_hash(info_hash: Option<&str>, url: Option<&str>) -> String {
    if let Some(hash) = info_hash.filter(|h| !h.is_empty()) {
        return hash.to_ascii_lowercase();
    }
    let Some(url) = url else {
        return String::new();
    };
    url.split(|c: char| !c.is_ascii_hexdigit())
        .find(|part| part.len() == 40 && part.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Comparação em tempo constante (sem dependência nova): só o TAMANHO vaza, e
/// o tamanho de um token não é segredo. A rota DESTRUTIVA das varreduras usa a
/// MESMA função na segunda credencial (`al_sweeps_admin`).
pub(crate) fn tokens_match(expected: &str, got: &str) -> bool {
    let (expected, got) = (expected.as_bytes(), got.as_bytes());
    if expected.len() != got.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(got) {
        diff |= a ^ b;
    }
    diff == 0
}
