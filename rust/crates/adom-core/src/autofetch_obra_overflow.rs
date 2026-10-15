//! Porte puro de `src/providers/autofetch-obra-overflow.ts` — overflow de
//! UPGRADE do teto por obra (C11).
//!
//! A decisão é PURA: recebe o registro persistido da obra (mais as reservas
//! vivas, que o chamador já mesclou em [`ObraEntry`]) e o candidato, e diz se
//! cabe UMA reserva extra (cap+1). Não lê config, cache, conta nem rede — o
//! teto (`cap`) e a contagem de vagas ficam no chamador (`reserveObra` no TS),
//! que só recorre a esta função quando `current === cap`.
//!
//! # Divergência deliberada de assinatura
//!
//! O pedido sugeria `quality_rank -> u8` e um parâmetro `cap`. Nenhum dos dois
//! casa com o fonte, que é o oráculo do golden:
//! - `qualityRank` devolve `-1` para faixa desconhecida ("não prova"), então o
//!   tipo é [`i64`], não `u8` — `u8` não representa o `-1` e quebraria a paridade.
//! - `overflowUpgradeAllowed(entries, input)` NÃO recebe `cap`: o `cap` já foi
//!   aplicado pelo chamador antes de chegar aqui. Por isso a assinatura leva o
//!   `pool` e a `quality` do candidato (os campos de `input` que a função lê),
//!   não um `cap`.

use crate::br_pool_selection::is_autofetch_target_quality;

/// Entrada do registro da obra vista pela decisão de overflow.
///
/// Só os campos que `overflowUpgradeAllowed` lê: `pool`, `quality` e o flag
/// `overflow`. `quality` vazia = faixa desconhecida (entrada antiga, sem prova).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObraEntry {
    pub pool: String,
    pub quality: String,
    pub overflow: bool,
}

/// Peso de faixa para comparar o upgrade; faixa desconhecida = `-1` (não prova).
///
/// Paridade com `qualityRank` do TS: `String(q || '').toLowerCase()` antes de
/// comparar, então a caixa não importa. Escala própria deste módulo
/// (2160p=4 … sd=0), distinta do peso de resolução dos pools.
pub fn quality_rank(quality: &str) -> i64 {
    match quality.to_lowercase().as_str() {
        "2160p" => 4,
        "1080p" => 3,
        "720p" => 2,
        "480p" => 1,
        "sd" => 0,
        _ => -1,
    }
}

/// Overflow de UPGRADE (C11): com o cap do pool `br` cheio, concede UMA reserva
/// extra quando o candidato é faixa-alvo AUSENTE no registro e SUPERIOR ao pior
/// BR já registrado.
///
/// Conservador por construção: exige prova de faixa (algum BR com qualidade
/// conhecida), só vale para o pool `br` e para faixa-alvo do Chupim, e recusa se
/// já houver reserva `overflow` na obra (UMA por janela) ou se a faixa do
/// candidato já estiver registrada. `entries` é a visão COMBINADA (registro
/// persistido + reservas pendentes vivas) que o chamador monta.
pub fn overflow_upgrade_allowed(entries: &[ObraEntry], pool: &str, quality: &str) -> bool {
    if pool != "br" {
        return false;
    }
    let quality = quality.to_lowercase();
    if !is_autofetch_target_quality(&quality) {
        return false;
    }
    let br_entries: Vec<&ObraEntry> = entries.iter().filter(|e| e.pool == "br").collect();
    // Reserva extra já concedida na janela: não abre outra.
    if br_entries.iter().any(|e| e.overflow) {
        return false;
    }
    // A faixa do candidato já está na obra: não é upgrade, é duplicata.
    if br_entries
        .iter()
        .any(|e| e.quality.to_lowercase() == quality)
    {
        return false;
    }
    // Sem prova de faixa (nenhum BR com qualidade conhecida) não concede.
    let worst = br_entries
        .iter()
        .map(|e| quality_rank(&e.quality))
        .filter(|r| *r >= 0)
        .min();
    match worst {
        Some(min) => quality_rank(&quality) > min,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pool: &str, quality: &str, overflow: bool) -> ObraEntry {
        ObraEntry {
            pool: pool.to_string(),
            quality: quality.to_string(),
            overflow,
        }
    }

    #[test]
    fn rank_cobre_a_escala_e_o_desconhecido() {
        assert_eq!(quality_rank("2160p"), 4);
        assert_eq!(quality_rank("1080P"), 3);
        assert_eq!(quality_rank("720p"), 2);
        assert_eq!(quality_rank("480p"), 1);
        assert_eq!(quality_rank("sd"), 0);
        assert_eq!(quality_rank("SD"), 0);
        assert_eq!(quality_rank(""), -1);
        assert_eq!(quality_rank("4K"), -1);
    }

    #[test]
    fn upgrade_superior_ausente_abre_a_reserva_extra() {
        let entries = [entry("br", "720p", false)];
        assert!(overflow_upgrade_allowed(&entries, "br", "1080p"));
    }

    #[test]
    fn pool_diferente_de_br_nunca_entra() {
        let entries = [entry("br", "720p", false)];
        assert!(!overflow_upgrade_allowed(&entries, "seeds", "1080p"));
    }

    #[test]
    fn duplicata_ou_downgrade_ou_overflow_previo_recusam() {
        // Faixa já registrada.
        assert!(!overflow_upgrade_allowed(
            &[entry("br", "1080p", false)],
            "br",
            "1080p"
        ));
        // Downgrade: 1080p não supera o 2160p já presente.
        assert!(!overflow_upgrade_allowed(
            &[entry("br", "2160p", false)],
            "br",
            "1080p"
        ));
        // Reserva extra já concedida na janela.
        assert!(!overflow_upgrade_allowed(
            &[entry("br", "720p", true)],
            "br",
            "1080p"
        ));
    }

    #[test]
    fn sem_prova_de_faixa_nao_concede() {
        // BR sem qualidade conhecida (entrada antiga) → ranks vazio.
        assert!(!overflow_upgrade_allowed(
            &[entry("br", "", false)],
            "br",
            "1080p"
        ));
        // Nenhum BR no registro.
        assert!(!overflow_upgrade_allowed(
            &[entry("seeds", "720p", false)],
            "br",
            "1080p"
        ));
    }
}
