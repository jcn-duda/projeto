//! A decisão de apagar. O Node é quem chama a API.

use napi_derive::napi;

#[napi(catch_unwind)]
pub fn debrid_may_delete(inventory_loaded: bool, known_before: bool, protected_hash: bool) -> bool {
    adom_core::may_delete(adom_core::DeleteFacts {
        inventory_loaded,
        known_before,
        protected: protected_hash,
    })
}
