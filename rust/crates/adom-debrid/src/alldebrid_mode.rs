//! Opt-in da checagem de cache da AllDebrid no Rust (`DEBRID_AL_RUST`).
//!
//! A rota interna `/debrid/check` e o `adom-search` in-process perguntam a
//! MESMA flag. Default **OFF**: o Node continua sendo o dono da checagem
//! (upload + limpeza + davail) e nada muda para quem não liga.
//!
//! - `on` (também `1/true/yes/rust`): a checagem nativa responde. O fallback
//!   Node só é usado quando a nativa NÃO chegou a enviar o upload (base
//!   recusada, sem hashes ou sem chave) — repetir depois de um upload real
//!   dobraria o lixo na conta.
//! - `shadow`/`sombra`: o Node responde e a nativa roda DEPOIS, em fundo,
//!   comparando `cached`/`known`/`unusable` (`debrid.al.shadow.*` no
//!   `/metrics` do gateway). Não segura o cliente.
//!
//! A checagem nativa é **read-only** por default: a limpeza só existe com
//! `DEBRID_AL_CLEANUP=on` (default OFF) e, mesmo ON, exige `holds_complete` +
//! inventário (`alldebrid_cleanup`). Como o hold volátil do autofetch mora no
//! Node, o caminho nativo do `adom-search` segue read-only até um feed de
//! holds; a rota interna pode receber os fatos no corpo. Por isso `on` NÃO
//! substitui a rota Node em produção (F4.6) — ele mede paridade e deixa a
//! conta acumular o que subiu. O rollback é remover/zerar a env.

/// Variável que liga a checagem nativa da AllDebrid.
pub const ENV: &str = "DEBRID_AL_RUST";
/// Amostra da sombra, em porcentagem (0..=100). Default 100 quando armada.
pub const SHADOW_PERCENT_ENV: &str = "DEBRID_AL_SHADOW_PERCENT";
/// Prazo próprio da sombra (ms). Default 5000.
pub const SHADOW_TIMEOUT_ENV: &str = "DEBRID_AL_SHADOW_TIMEOUT_MS";
/// Teto de hashes que a sombra reenvia por amostra. Default 50 (a conta é
/// compartilhada com a checagem viva; 500 hashes de sombra é lixo demais).
pub const SHADOW_MAX_HASHES_ENV: &str = "DEBRID_AL_SHADOW_MAX_HASHES";

const DEFAULT_SHADOW_TIMEOUT_MS: u64 = 5_000;
const DEFAULT_SHADOW_MAX_HASHES: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AlRustMode {
    /// Default: o Node responde (rota 501 no sidecar, reserva Node no seam).
    #[default]
    Off,
    /// Checagem nativa responde, com fallback Node só antes de qualquer upload.
    On,
    /// Node responde; a nativa compara em fundo.
    Shadow,
}

impl AlRustMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "on" | "1" | "true" | "yes" | "rust" => Self::On,
            "shadow" | "sombra" => Self::Shadow,
            _ => Self::Off,
        }
    }

    pub fn from_env() -> Self {
        std::env::var(ENV)
            .ok()
            .as_deref()
            .map(Self::parse)
            .unwrap_or_default()
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
            Self::Shadow => "shadow",
        }
    }

    /// A nativa pode responder (com ou sem comparação).
    pub fn uses_native(self) -> bool {
        !matches!(self, Self::Off)
    }
}

/// `DEBRID_AL_SHADOW_PERCENT`: 0..=100, default 100. Valor inválido cai no
/// default (a sombra armada não vira "0% silencioso" por typo).
pub fn shadow_percent_from(raw: Option<&str>) -> u8 {
    raw.and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 100.0).round() as u8)
        .unwrap_or(100)
}

/// `DEBRID_AL_SHADOW_TIMEOUT_MS`: default 5000; mínimo 1 ms.
pub fn shadow_timeout_ms_from(raw: Option<&str>) -> u64 {
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_SHADOW_TIMEOUT_MS)
}

/// `DEBRID_AL_SHADOW_MAX_HASHES`: default 50, clamp 1..=500.
pub fn shadow_max_hashes_from(raw: Option<&str>) -> usize {
    raw.and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_SHADOW_MAX_HASHES)
        .clamp(1, 500)
}

/// Amostragem determinística por hash (FNV-1a 64): o MESMO conjunto de hashes
/// cai sempre no mesmo balde, então uma busca não alterna de lado.
pub fn sample_includes(percent: u8, hashes: &[String]) -> bool {
    if percent == 0 {
        return false;
    }
    if percent >= 100 {
        return true;
    }
    let mut sorted: Vec<&str> = hashes.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in sorted {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash ^= b'\n' as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash % 100) < u64::from(percent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_do_default_e_dos_apelidos() {
        assert_eq!(AlRustMode::default(), AlRustMode::Off);
        for raw in ["", "off", "0", "false", "nao", "qualquer"] {
            assert_eq!(AlRustMode::parse(raw), AlRustMode::Off, "{raw}");
        }
        for raw in ["on", "1", "true", "yes", "RUST"] {
            assert_eq!(AlRustMode::parse(raw), AlRustMode::On, "{raw}");
        }
        for raw in ["shadow", "SOMBRA"] {
            assert_eq!(AlRustMode::parse(raw), AlRustMode::Shadow, "{raw}");
        }
        assert!(!AlRustMode::Off.uses_native());
        assert!(AlRustMode::On.uses_native());
        assert!(AlRustMode::Shadow.uses_native());
    }

    #[test]
    fn percentual_default_100_e_clamp() {
        assert_eq!(shadow_percent_from(None), 100);
        assert_eq!(shadow_percent_from(Some("")), 100);
        assert_eq!(shadow_percent_from(Some("abc")), 100);
        assert_eq!(shadow_percent_from(Some("0")), 0);
        assert_eq!(shadow_percent_from(Some("250")), 100);
        assert_eq!(shadow_percent_from(Some("-3")), 0);
        assert_eq!(shadow_percent_from(Some("37.6")), 38);
        assert!(!sample_includes(0, &[String::from("a")]));
        assert!(sample_includes(100, &[String::from("a")]));
    }

    #[test]
    fn prazo_e_teto_da_sombra() {
        assert_eq!(shadow_timeout_ms_from(None), 5_000);
        assert_eq!(shadow_timeout_ms_from(Some("0")), 5_000);
        assert_eq!(shadow_timeout_ms_from(Some("900")), 900);
        assert_eq!(shadow_max_hashes_from(None), 50);
        assert_eq!(shadow_max_hashes_from(Some("0")), 1);
        assert_eq!(shadow_max_hashes_from(Some("999")), 500);
        assert_eq!(shadow_max_hashes_from(Some("12")), 12);
    }

    #[test]
    fn amostragem_e_estavel_para_o_mesmo_conjunto() {
        let hashes = vec![
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        ];
        let first = sample_includes(50, &hashes);
        for _ in 0..20 {
            assert_eq!(sample_includes(50, &hashes), first);
        }
        let mut reversed = hashes.clone();
        reversed.reverse();
        assert_eq!(
            sample_includes(50, &reversed),
            first,
            "ordem não pode mudar o balde"
        );
    }
}
