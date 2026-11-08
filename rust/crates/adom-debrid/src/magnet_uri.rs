//! URI rica do magnet (nome + trackers) para os uploads da AllDebrid.
//!
//! O banco de magnets (`magnets.db`) mora no `adom-store`, que este crate não
//! conhece: o gateway instala a leitura no boot ([`install`]). Sem ela tudo
//! segue subindo o hash puro, como antes.
//!
//! Por que importa: com só o hash a AllDebrid acha pares pela DHT, e torrent BR
//! que depende dos trackers do magnet fica em "Downloading 0%", sem nome, para
//! sempre. E o PRIMEIRO upload define o magnet na conta: a checagem de cache
//! sobe antes do Chupim, e o upload rico do Chupim caía no mesmo id sem nome
//! (medido no Docker local em 2026-11-08: 7 de 9 sem nome).

use std::sync::{Arc, OnceLock};

/// Hash → URI gravada (ou `None`).
pub type MagnetUriFn = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

static LOOKUP: OnceLock<MagnetUriFn> = OnceLock::new();

/// Instala a leitura do banco (uma vez por processo; a segunda é ignorada).
pub fn install(lookup: MagnetUriFn) -> bool {
    LOOKUP.set(lookup).is_ok()
}

/// URI gravada para o hash, se o banco estiver instalado e a tiver.
pub fn lookup(hash: &str) -> Option<String> {
    LOOKUP.get().and_then(|read| read(hash))
}

/// O que vai em `magnets[]`: o magnet rico quando a URI é do MESMO hash, senão
/// o hash puro.
pub fn upload_value(hash: &str, uri: Option<&str>) -> String {
    let stored;
    let uri = match uri {
        Some(uri) => Some(uri),
        None => {
            stored = lookup(hash);
            stored.as_deref()
        }
    };
    uri.and_then(|uri| crate::alldebrid::rich_magnet(hash, uri))
        .unwrap_or_else(|| hash.to_string())
}
