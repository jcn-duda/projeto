//! Opt-in da checagem de cache da AllDebrid no Rust (`DEBRID_AL_RUST`).
//!
//! A rota interna `/debrid/check` e o `adom-search` in-process perguntam a
//! MESMA flag. Default do CÓDIGO **OFF**; o default do CORTE
//! (`docker-compose.yml`, desde o F4.6) é **ON** — junto com
//! `DEBRID_AL_HOLDS=on` e `DEBRID_AL_CLEANUP=on`. Quem roda o processo sem o
//! compose (teste/CLI) segue no caminho Node.
//!
//! - `off`: o Node continua sendo o dono da checagem (upload + limpeza +
//!   davail) pela rota `/internal/debrid/check` — é o **rollback de uma linha**
//!   do corte.
//! - `on` (também `1/true/yes/rust`): a checagem nativa responde e a rota Node
//!   fica **410**. O fallback Node só é usado quando a nativa NÃO chegou a
//!   enviar o upload (base recusada, sem hashes ou sem chave) — repetir depois
//!   de um upload real dobraria o lixo na conta.
//!
//! A checagem nativa é **read-only** por default: a limpeza só existe com
//! `DEBRID_AL_CLEANUP=on` e, mesmo ON, exige `holds_complete` + inventário
//! (`alldebrid_cleanup`). O hold volátil do autofetch mora no Node, e o seam
//! in-process o recebe pelo feed (`DEBRID_AL_HOLDS`); sem os fatos a nativa
//! segue read-only — nunca "completa" por omissão.

/// Variável que liga a checagem nativa da AllDebrid.
pub const ENV: &str = "DEBRID_AL_RUST";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AlRustMode {
    /// Default do código: o Node responde (rota 501 no sidecar, reserva Node no
    /// seam). O compose do corte sobe `on`.
    #[default]
    Off,
    /// Checagem nativa responde, com fallback Node só antes de qualquer upload.
    On,
}

impl AlRustMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "on" | "1" | "true" | "yes" | "rust" => Self::On,
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
        }
    }

    /// A nativa pode responder (com ou sem comparação).
    pub fn uses_native(self) -> bool {
        !matches!(self, Self::Off)
    }
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
        // Valor desconhecido vira `off`, nunca "meio ligado".
        assert_eq!(AlRustMode::parse("shadow"), AlRustMode::Off);
        assert_eq!(AlRustMode::parse("SOMBRA"), AlRustMode::Off);
        assert!(!AlRustMode::Off.uses_native());
        assert!(AlRustMode::On.uses_native());
    }
}
