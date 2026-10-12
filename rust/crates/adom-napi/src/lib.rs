//! Bindings NAPI-RS do `adom-core`.
//!
//! Este módulo expõe funções Rust críticas para o Node via NAPI. Cada função
//! pública é anotada com `#[napi]` para gerar automaticamente o binding C-ABI
//! e o `.d.ts` correspondente.
//!
//! ## Funções expostas
//!
//! - `normalize_title`: normaliza títulos (paridade com o TS).
//! - `sign_resolve`: assina URLs de /resolve (delega ao `adom-core`).
//! - `verify_resolve`: verifica assinaturas em tempo constante (delega ao `adom-core`).
//!
//! ## Responsabilidade
//!
//! Este crate SÓ faz wrapping. Lógica real vive em `adom-core`. Funções que
//! dependem de segredo (sign/verify) recebem o segredo como parâmetro — o
//! lado Node é responsável por fornecê-lo via `config`/`runtime`.

use napi_derive::napi;

/// Normaliza um título de obra (paridade com o TS `normalizeTitle`).
///
/// Expõe `adom_core::normalize_title` para o Node. A função Rust já tem todos
/// os testes de paridade com o golden, então o wrapper só repassa.
///
/// # Exemplo (Node)
///
/// ```js
/// import { normalizeTitle } from '../rust/adom-napi/index.js';
/// const normalized = normalizeTitle('Star Wars: The Clone Wars');
/// ```
#[napi]
pub fn normalize_title(title: String) -> String {
    adom_core::normalize_title(&title)
}

/// Assina uma URL de /resolve com HMAC-SHA256.
///
/// Delega ao `adom_core::sign_resolve` — a lógica criptográfica (payload,
/// ordem de chaves, chave vazia) vive lá, com golden e testes de paridade.
///
/// ## Parâmetros
///
/// - `secret`: segredo HMAC (vem de `config.debrid.resolveSecret` ou
///   `opts().debridApiKey`).
/// - `info_hash`: hash do torrent (ID público do indexer).
/// - `ep`: episódio (string vazia se não aplicável).
/// - `hint`: dica de obra em JSON (string vazia se não houver).
///
/// ## Retorno
///
/// Hex do HMAC-SHA256. String vazia se `secret` for vazio.
#[napi]
pub fn sign_resolve(secret: String, info_hash: String, ep: String, hint: String) -> String {
    adom_core::sign_resolve(&info_hash, &ep, &hint, &secret)
}

/// Verifica uma assinatura de /resolve em tempo constante.
///
/// Delega ao `adom_core::verify_resolve` — a comparação constant-time e as
/// guardas (chave vazia, sig ausente, uppercase) vivem lá.
///
/// ## Parâmetros
///
/// - `secret`: segredo HMAC (mesmo de `sign_resolve`).
/// - `info_hash`: hash do torrent.
/// - `ep`: episódio.
/// - `sig`: assinatura a verificar (hex).
/// - `hint`: dica de obra (mesma de `sign_resolve`).
///
/// ## Retorno
///
/// `true` se a assinatura for válida. `false` otherwise.
#[napi]
pub fn verify_resolve(
    secret: String,
    info_hash: String,
    ep: String,
    sig: String,
    hint: String,
) -> bool {
    adom_core::verify_resolve(&info_hash, &ep, Some(&sig), &hint, &secret)
}
