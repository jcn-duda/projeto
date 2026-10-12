//! Porte fiel de `signResolve` / `verifyResolve` (`src/utils/sign.ts`).
//!
//! Contrato HMAC-SHA256 da rota `/resolve`:
//! - payload: `${infoHash}${ep}${hint ? '&w=' + hint : ''}`
//!   - `infoHash`: 40 hex (a caixa é preservada como recebida; o JS não baixa)
//!   - `ep`: filme = `""`; série = `"?s=${season}&e=${episode}"` (o `?` faz parte)
//!   - `hint`: JSON cru (ordem de chaves importa, NUNCA sort)
//! - chave: fallback `resolveSecret || debridApiKey || ''` — aqui recebida como
//!   parâmetro `key` (sem acesso a config/runtime no crate puro)
//! - saída: hex minúsculo; chave vazia → `""` (rota não assinável)
//! - verificação: length + comparação constant-time (XOR accumulation);
//!   uppercase NÃO casa, sig de tamanho diferente retorna falso, sig não-string
//!   (null/número) retorna falso.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// Monta o payload e produz o HMAC-SHA256 em hex minúsculo.
///
/// Retorna `String::new()` quando `key` é vazia (mesmo comportamento do TS:
/// sem segredo ativo a rota não é assinável).
fn build_payload(info_hash: &str, ep: &str, hint: &str) -> String {
    if hint.is_empty() {
        // Sem dica: payload idêntico ao antigo (URLs cacheadas sem `w` continuam válidas).
        let mut out = String::with_capacity(info_hash.len() + ep.len());
        out.push_str(info_hash);
        out.push_str(ep);
        out
    } else {
        let mut out =
            String::with_capacity(info_hash.len() + ep.len() + 3 + hint.len());
        out.push_str(info_hash);
        out.push_str(ep);
        out.push_str("&w=");
        out.push_str(hint);
        out
    }
}

/// Assina a rota `/resolve`.
///
/// `key` é o segredo efetivo (resolveSecret ou debridApiKey); o crate não lê
/// config — cabe ao chamador resolver a precedência.
pub fn sign_resolve(info_hash: &str, ep: &str, hint: &str, key: &str) -> String {
    if key.is_empty() {
        return String::new();
    }
    let payload = build_payload(info_hash, ep, hint);
    let mut mac =
        HmacSha256::new_from_slice(key.as_bytes()).expect("HMAC aceita chave de qualquer tamanho");
    mac.update(payload.as_bytes());
    let result = mac.finalize().into_bytes();
    // Hex minúsculo — mesmo formato do `digest('hex')` do Node.
    let mut out = String::with_capacity(result.len() * 2);
    for b in result.as_slice() {
        out.push(char::from_digit(u32::from(b >> 4), 16).unwrap());
        out.push(char::from_digit(u32::from(b & 0x0f), 16).unwrap());
    }
    out
}

/// Comparação constant-time via `subtle::ConstantTimeEq` (OR dos XORs acumulado
/// sem branches por byte — evita curto-circuito que vaze informação por timing).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    // `ct_eq` devolve `Choice`; `into()` transforma em `bool`.
    a.ct_eq(b).into()
}

/// Verifica a assinatura da rota `/resolve`.
///
/// Retorna `false` quando:
/// - `key` é vazia (sem segredo → não há assinatura válida)
/// - `sig` é `None` (null/undefined no TS) ou não-string (número etc.)
/// - `sig` tem tamanho diferente do esperado
/// - `sig` está em uppercase (não casa — o TS também rejeita)
///
/// O caso `sig` não-string é modelado em Rust recebendo `Option<&str>`: o
/// chamador que recebe `serde_json::Value` faz a coerção antes.
pub fn verify_resolve(
    info_hash: &str,
    ep: &str,
    sig: Option<&str>,
    hint: &str,
    key: &str,
) -> bool {
    let expected = sign_resolve(info_hash, ep, hint, key);
    if expected.is_empty() {
        return false;
    }
    let Some(sig_str) = sig else {
        return false;
    };
    // TS: `typeof sig !== 'string'` → false. Aqui o tipo já garante, mas o
    // golden cobre null/número modelados como `None` no chamador.
    constant_time_eq(expected.as_bytes(), sig_str.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chave_vazia_retorna_string_vazia() {
        assert_eq!(sign_resolve("aa", "", "", ""), "");
    }

    #[test]
    fn payload_sem_hint_nao_tem_w() {
        // Caso rs-001: payload = infoHash + ep (sem "&w=").
        let sig = sign_resolve(
            "0123456789abcdef0123456789abcdef01234567",
            "",
            "",
            "adom-golden-resolve-sign-FAKE-primary-v1-NOT-A-REAL-SECRET",
        );
        assert_eq!(
            sig,
            "23352ecd914e898541f933896763444987786540ac4282ed677ac17449f9568b"
        );
    }

    #[test]
    fn verify_rejeita_sig_null() {
        assert!(!verify_resolve(
            "0123456789abcdef0123456789abcdef01234567",
            "",
            None,
            "",
            "adom-golden-resolve-sign-FAKE-primary-v1-NOT-A-REAL-SECRET",
        ));
    }

    #[test]
    fn verify_rejeita_uppercase() {
        // rs-017: uppercase não casa (o TS também rejeita).
        assert!(!verify_resolve(
            "0123456789abcdef0123456789abcdef01234567",
            "",
            Some("23352ECD914E898541F933896763444987786540AC4282ED677AC17449F9568B"),
            "",
            "adom-golden-resolve-sign-FAKE-primary-v1-NOT-A-REAL-SECRET",
        ));
    }

    #[test]
    fn verify_rejeita_tamanho_diferente() {
        // rs-018: um caractere a menos.
        assert!(!verify_resolve(
            "0123456789abcdef0123456789abcdef01234567",
            "",
            Some("23352ecd914e898541f933896763444987786540ac4282ed677ac17449f9568"),
            "",
            "adom-golden-resolve-sign-FAKE-primary-v1-NOT-A-REAL-SECRET",
        ));
    }
}
