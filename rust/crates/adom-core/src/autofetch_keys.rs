//! Porte puro de `src/providers/autofetch-keys.ts` — a chave FOLHA do registro
//! de mortas do Chupim.
//!
//! O fonte TS existe para quebrar o ciclo de inicialização de `debrid/index`:
//! consumidores de baixo nível precisam da chave sem importar o registry. Aqui a
//! mesma razão vale — a chave é só montagem de string sobre [`crate::cache_keys`],
//! sem conhecer adapter, conta nem rede.
//!
//! Paridade: `${prefix('autofetch')}dead:${adapterId}:${account}:${hash.toLowerCase()}`.
//! Só o `infoHash` é normalizado (minúsculas, o `String(infoHash || '')` do TS);
//! `adapter` e `account` entram VERBATIM, como no fonte.

use crate::cache_keys::cache_key;

/// Chave do registro de mortas: `autofetch:v3:dead:<adapter>:<conta>:<hash>`.
///
/// O `info_hash` vai em minúsculas (hex de infoHash não distingue caixa, e o TS
/// já normalizava). `adapter`/`account` NÃO são normalizados — quem os produz é
/// o chamador, exatamente como no fonte.
pub fn dead_key(adapter: &str, account: &str, info_hash: &str) -> String {
    let hash = info_hash.to_lowercase();
    cache_key("autofetch", &["dead", adapter, account, &hash])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chave_usa_o_prefixo_versionado_do_namespace() {
        assert_eq!(
            dead_key("premiumize", "acc1", "aabbcc"),
            "autofetch:v3:dead:premiumize:acc1:aabbcc"
        );
    }

    #[test]
    fn hash_vai_em_minusculas_adapter_e_conta_nao() {
        // O `String(infoHash || '').toLowerCase()` do TS: só o hash normaliza.
        assert_eq!(
            dead_key("Premiumize", "Acc", "AABBCCDD"),
            "autofetch:v3:dead:Premiumize:Acc:aabbccdd"
        );
    }

    #[test]
    fn hash_vazio_compoe_a_chave_com_segmento_vazio() {
        assert_eq!(
            dead_key("torbox", "acc", ""),
            "autofetch:v3:dead:torbox:acc:"
        );
    }
}
