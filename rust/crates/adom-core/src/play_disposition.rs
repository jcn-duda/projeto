//! Porte de `playDisposition` (`src/providers/debrid-play-guard.ts`).
//!
//! Ponto ÚNICO da regra "pack multiobra ADMITIDO nunca vira torrent P2P
//! inteiro": o cliente baixaria a coleção toda e tocaria o MAIOR arquivo, quase
//! sempre o filme errado. A marca é `_multiWorkAdmitted` (feature
//! `BR_MULTIWORK_PACKS`, nativa por padrão; `false` é o kill-switch), nunca o
//! `_multiWork` genérico: com o kill-switch desligado nada é admitido e o
//! comportamento anterior é preservado.
//!
//! A ORDEM dos ramos é a regra, não estilo:
//!
//! 1. `infoHash + cached` → `/resolve` (o debrid toca agora);
//! 2. multiobra admitida → `/resolve` só com `resolveUncached`, senão `drop`.
//!    Vem ANTES do ramo `degraded`: como o serviço não soube informar cache, o
//!    comportamento histórico manda tudo pelo `/resolve`, mas a coleção fria
//!    continua fora dessa regra — sem o knob ela é descartada, nunca oferecida;
//! 3. `degraded` (`known:false`) → tudo por `/resolve`;
//! 4. `resolveUncached` → `/resolve`; senão P2P puro.
//!
//! Golden: `rust/golden/play-disposition.jsonl` (18 casos), gerado por
//! `node scripts/golden/dump-play-disposition.mjs` contra o TS REAL do `dist`;
//! teste em `tests/play_disposition_golden.rs`. O TS testava as duas marcas por
//! VERDADE do JS, então string vazia e `0` são falsos: o golden cobre os três.
//!
//! SEM napi, de propósito: o consumidor de hoje (`debrid-pipeline`) chama a
//! função **uma vez por stream**, e a travessia de string do napi custa ~2× o
//! TS — ligar a ponte aqui deixaria a busca mais lenta sem tirar decisão do
//! Node. Quem consome este porte é o orquestrador Rust (F1), no mesmo processo.

/// Decisão de SAÍDA de um stream depois da checagem de cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlayDisposition {
    /// Sai pela URL `/resolve` (debrid). Cacheado, ou não-cacheado com knob.
    Resolve,
    /// Torrent puro (comportamento antigo, só sem admissão multiobra).
    P2p,
    /// Multiobra admitida fora do cache sem `resolveUncached`: não vai à lista.
    Drop,
}

impl PlayDisposition {
    pub fn as_str(self) -> &'static str {
        match self {
            PlayDisposition::Resolve => "resolve",
            PlayDisposition::P2p => "p2p",
            PlayDisposition::Drop => "drop",
        }
    }
}

/// Fatos que decidem a saída. `has_info_hash` é a VERDADE do `if (stream.infoHash)`
/// do TS — hash vazio já chega aqui como `false`.
#[derive(Clone, Copy, Debug)]
pub struct PlayFacts {
    pub has_info_hash: bool,
    pub multi_work_admitted: bool,
    pub cached: bool,
    pub resolve_uncached: bool,
    pub degraded: bool,
}

pub fn play_disposition(facts: &PlayFacts) -> PlayDisposition {
    if facts.has_info_hash && facts.cached {
        return PlayDisposition::Resolve;
    }
    if facts.multi_work_admitted {
        return if facts.resolve_uncached {
            PlayDisposition::Resolve
        } else {
            PlayDisposition::Drop
        };
    }
    if facts.degraded {
        return PlayDisposition::Resolve;
    }
    if facts.resolve_uncached {
        PlayDisposition::Resolve
    } else {
        PlayDisposition::P2p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> PlayFacts {
        PlayFacts {
            has_info_hash: true,
            multi_work_admitted: false,
            cached: false,
            resolve_uncached: false,
            degraded: false,
        }
    }

    #[test]
    fn cacheado_com_hash_vai_para_o_resolve() {
        assert_eq!(
            play_disposition(&PlayFacts {
                cached: true,
                ..facts()
            }),
            PlayDisposition::Resolve
        );
    }

    #[test]
    fn multiobra_admitida_nunca_vira_p2p_inteiro() {
        // O invariante: sem o knob, a coleção FRIO sai da lista em vez de ser
        // oferecida como torrent inteiro.
        assert_eq!(
            play_disposition(&PlayFacts {
                multi_work_admitted: true,
                ..facts()
            }),
            PlayDisposition::Drop
        );
        assert_eq!(
            play_disposition(&PlayFacts {
                multi_work_admitted: true,
                resolve_uncached: true,
                ..facts()
            }),
            PlayDisposition::Resolve
        );
    }

    #[test]
    fn multiobra_ganha_do_degradado() {
        // Ordem dos ramos: `degraded` mandaria tudo para o resolve, mas a
        // coleção admitida continua fora dessa regra.
        assert_eq!(
            play_disposition(&PlayFacts {
                multi_work_admitted: true,
                degraded: true,
                ..facts()
            }),
            PlayDisposition::Drop
        );
    }

    #[test]
    fn p2p_e_o_ultimo_recurso() {
        assert_eq!(play_disposition(&facts()), PlayDisposition::P2p);
        assert_eq!(
            play_disposition(&PlayFacts {
                has_info_hash: false,
                ..facts()
            }),
            PlayDisposition::P2p
        );
    }
}
