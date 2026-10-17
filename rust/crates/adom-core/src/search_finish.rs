//! Porte de `src/providers/search-commit.ts` — decisões do FIM da busca.
//!
//! Três réguas que até a F-1 viviam como closures sobre `config`, `cache` e o
//! writer do `finish`, e por isso não tinham como ser medidas:
//!
//! - [`commit_decision`]: o que gravar no cache e com que TTL (lista completa
//!   ganha o TTL cheio; parcial, sem play ou com reserva fica no TTL curto);
//! - [`late_promotion_decision`]: quando a coleta tardia termina, promover a
//!   entrada a completa, invalidar a reserva do banco ou não mexer;
//! - [`debrid_refresh_satisfied`]/[`stale_refresh_eligible`]: quando o SWR pode
//!   servir a entrada velha.
//!
//! Golden: `rust/golden/search-commit.jsonl` (40 casos), gerado por
//! `node scripts/golden/dump-search-commit.mjs` contra o TypeScript REAL do
//! `dist`, comparado pelo teste `tests/search_commit_golden.rs`. O manifest
//! prende o sha256 da fonte que produziu o golden — quando o TS deste branch
//! virar casca do napi, a geração passa a rodar no worktree `../adom-esm`
//! (mesmo contrato dos outros goldens cujo corpo saiu daqui).
//!
//! Um cuidado que o TS tinha e este porte mantém: `live` é `Option`. O TS só
//! perguntava `needsFallback()` no ramo da reserva e só `hasAnyFailure()` no
//! ramo da lista vazia, e um stub sem um dos métodos continuava válido. Aqui os
//! campos só são LIDOS no ramo correspondente, então a mesma assimetria vale
//! para quem monta [`LiveState`].

use serde_json::Value;

/// Fatos do `finish` que decidem a gravação.
#[derive(Clone, Copy, Debug)]
pub struct CommitFacts {
    /// `hasPlayableStream(streams)`: a lista tem `url` ou `infoHash` de verdade.
    pub playable: bool,
    /// Parcial de COLETA (fontes lentas ainda não chegaram).
    pub partial: bool,
    /// `None` = a checagem no debrid nunca respondeu (estado REAL, não "falso").
    pub debrid_known: Option<bool>,
    /// O debrid sinalizou que a checagem precisa ser refeita.
    pub needs_debrid_refresh: bool,
    /// A lista carrega reserva (fallback do banco ou foto do índice).
    pub has_fallback: bool,
    pub cache_ttl: i64,
    pub fallback_streams_ttl: i64,
}

/// Decisão de gravação devolvida por [`commit_decision`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CommitDecision {
    /// `false` = não grava nada (cache desligado para a reserva).
    pub write: bool,
    /// TTL em segundos da entrada, quando `write`.
    pub ttl: i64,
    /// `partial` GRAVADO: reserva é sempre parcial, por definição.
    pub partial: bool,
    /// `debrid_known` a gravar (o mesmo que entra em `complete`).
    pub debrid_known: bool,
}

/// Lista completa = tocável + coleta encerrada + debrid conferido + sem reserva.
///
/// `debrid_known == None` não significa "sem ⚡": o TS tratava o desconhecido
/// como conhecido quando ninguém pediu refresh (`!needs_debrid_refresh`), para
/// o caminho P2P puro (sem debrid) não pagar TTL curto para sempre. Quem pediu
/// refresh (`needs_debrid_refresh`) derruba os dois casos.
pub fn commit_decision(facts: &CommitFacts) -> CommitDecision {
    let debrid_known = match facts.debrid_known {
        Some(known) => known && !facts.needs_debrid_refresh,
        None => !facts.needs_debrid_refresh,
    };
    let complete = facts.playable && !facts.partial && debrid_known && !facts.has_fallback;
    // TTL da reserva RESPEITA o CACHE_TTL: cache desligado (<=0) não grava, e o
    // teto nunca passa do TTL normal (o menor dos dois vence).
    let fallback_ttl = facts.cache_ttl.min(facts.fallback_streams_ttl);
    if facts.has_fallback && fallback_ttl <= 0 {
        return CommitDecision {
            write: false,
            ttl: 0,
            partial: true,
            debrid_known,
        };
    }
    let ttl = if facts.has_fallback {
        fallback_ttl
    } else if complete {
        facts.cache_ttl
    } else {
        facts.cache_ttl.min(60)
    };
    CommitDecision {
        write: true,
        ttl,
        partial: if facts.has_fallback {
            true
        } else {
            facts.partial
        },
        debrid_known,
    }
}

/// Visão só-leitura do estado dos indexers vivos.
#[derive(Clone, Copy, Debug)]
pub struct LiveState {
    pub needs_fallback: bool,
    pub has_any_failure: bool,
}

/// O que fazer com a entrada quando a coleta tardia termina sem novidade.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LateAction {
    Promote,
    Forget,
    None,
}

impl LateAction {
    pub fn as_str(self) -> &'static str {
        match self {
            LateAction::Promote => "promote",
            LateAction::Forget => "forget",
            LateAction::None => "none",
        }
    }
}

/// Motivo estável da decisão — o chamador loga este texto em vez de repetir a
/// condição, e o log do Rust sai igual ao do TS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LateReason {
    EntradaNaoParcial,
    ReservaViva,
    SemRespostaDosIndexers,
    ReservaInvalida,
    Promover,
}

impl LateReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LateReason::EntradaNaoParcial => "entrada_nao_parcial",
            LateReason::ReservaViva => "reserva_viva",
            LateReason::SemRespostaDosIndexers => "sem_resposta_dos_indexers",
            LateReason::ReservaInvalida => "reserva_invalida",
            LateReason::Promover => "promover",
        }
    }
}

/// Fatos da promoção tardia. Os degraus anteriores (`grew`, `partial`, fase
/// divergente) ficam no chamador porque ele só pode LER o cache depois deles:
/// `cache.get` apaga entrada expirada, e apagar num caso em que o TS antigo nem
/// consultava mudaria o comportamento.
#[derive(Clone, Copy, Debug)]
pub struct LateFacts {
    /// `hit.partial` da entrada cacheada.
    pub hit_partial: bool,
    /// `hit.fallback` — a entrada nasceu de reserva do banco.
    pub hit_fallback: bool,
    /// `hit.streams.length > 0`.
    pub hit_has_streams: bool,
    /// `hit.debridKnown === true`.
    pub hit_debrid_known: bool,
    /// Estado dos indexers vivos, ou `None` (busca sem coleta ao vivo).
    pub live: Option<LiveState>,
    pub cache_ttl: i64,
}

/// Decisão da promoção tardia.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LateDecision {
    pub action: LateAction,
    pub reason: LateReason,
    /// TTL quando `action == Promote`.
    pub ttl: i64,
    /// `debrid_known` a gravar quando `Promote`.
    pub debrid_known: bool,
}

/// Regra da promoção tardia (porte fiel, inclusive a ordem dos ramos).
///
/// - reserva sem falha viva → invalidar: a próxima abertura reconstrói do vivo;
/// - reserva com falha viva (ou sem `live`) → manter o TTL curto;
/// - lista vazia com indexer falho → não promover (vazio não é "sem resultado",
///   é "sem resposta": promover congelaria o vazio pelo TTL cheio);
/// - resto → promover SEM refazer a checagem do debrid: `debrid_known` é
///   copiado como está, porque promessa de completude da COLETA não é promessa
///   de ⚡.
pub fn late_promotion_decision(facts: &LateFacts) -> LateDecision {
    let none = |reason: LateReason| LateDecision {
        action: LateAction::None,
        reason,
        ttl: 0,
        debrid_known: facts.hit_debrid_known,
    };
    if !facts.hit_partial {
        return none(LateReason::EntradaNaoParcial);
    }
    if facts.hit_fallback {
        let falha_sumiu = matches!(facts.live, Some(live) if !live.needs_fallback);
        return if falha_sumiu {
            LateDecision {
                action: LateAction::Forget,
                reason: LateReason::ReservaInvalida,
                ttl: 0,
                debrid_known: facts.hit_debrid_known,
            }
        } else {
            none(LateReason::ReservaViva)
        };
    }
    if !facts.hit_has_streams && matches!(facts.live, Some(live) if live.has_any_failure) {
        return none(LateReason::SemRespostaDosIndexers);
    }
    LateDecision {
        action: LateAction::Promote,
        reason: LateReason::Promover,
        ttl: if facts.hit_debrid_known {
            facts.cache_ttl
        } else {
            facts.cache_ttl.min(60)
        },
        debrid_known: facts.hit_debrid_known,
    }
}

/// `entry.partial === false && entry.debridKnown === true`, com igualdade
/// ESTRITA como no TS: `"false"` (string) não conta, ausência não conta.
pub fn debrid_refresh_satisfied(entry: Option<&Value>) -> bool {
    let Some(entry) = entry else { return false };
    entry.get("partial") == Some(&Value::Bool(false))
        && entry.get("debridKnown") == Some(&Value::Bool(true))
}

/// O SWR só serve o que o `finish` promoveria a completa **e** que tem play de
/// verdade: aviso e parcial estenderiam o estado ruim em vez de consertá-lo.
/// `playable` vem do chamador (`has_playable_stream`) para o teste ser o MESMO
/// dos dois lados.
pub fn stale_refresh_eligible(entry: Option<&Value>, playable: bool) -> bool {
    debrid_refresh_satisfied(entry) && playable
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> CommitFacts {
        CommitFacts {
            playable: true,
            partial: false,
            debrid_known: Some(true),
            needs_debrid_refresh: false,
            has_fallback: false,
            cache_ttl: 900,
            fallback_streams_ttl: 900,
        }
    }

    #[test]
    fn completa_ganha_ttl_cheio() {
        let decision = commit_decision(&facts());
        assert_eq!(
            decision,
            CommitDecision {
                write: true,
                ttl: 900,
                partial: false,
                debrid_known: true
            }
        );
    }

    #[test]
    fn desconhecido_sem_refresh_conta_como_conhecido() {
        // Caminho P2P puro: sem debrid ninguém pede refresh, e o TTL curto
        // congelaria a lista por 60 s à toa.
        let decision = commit_decision(&CommitFacts {
            debrid_known: None,
            ..facts()
        });
        assert_eq!(decision.ttl, 900);
        assert!(decision.debrid_known);
    }

    #[test]
    fn reserva_com_cache_desligado_nao_grava() {
        let decision = commit_decision(&CommitFacts {
            has_fallback: true,
            cache_ttl: 0,
            ..facts()
        });
        assert!(!decision.write);
        assert_eq!(decision.ttl, 0);
        assert!(decision.partial);
    }

    #[test]
    fn reserva_nunca_e_completa() {
        let decision = commit_decision(&CommitFacts {
            has_fallback: true,
            ..facts()
        });
        assert!(decision.write);
        assert_eq!(decision.ttl, 900);
        assert!(decision.partial);
    }

    #[test]
    fn late_sem_resposta_nao_promove() {
        let decision = late_promotion_decision(&LateFacts {
            hit_partial: true,
            hit_fallback: false,
            hit_has_streams: false,
            hit_debrid_known: true,
            live: Some(LiveState {
                needs_fallback: false,
                has_any_failure: true,
            }),
            cache_ttl: 900,
        });
        assert_eq!(decision.action, LateAction::None);
        assert_eq!(decision.reason, LateReason::SemRespostaDosIndexers);
    }

    #[test]
    fn entry_parcial_nao_e_refresh_confiavel() {
        let entry = serde_json::json!({ "partial": false, "debridKnown": "true" });
        assert!(!debrid_refresh_satisfied(Some(&entry)));
        let entry = serde_json::json!({ "partial": false, "debridKnown": true });
        assert!(debrid_refresh_satisfied(Some(&entry)));
        assert!(!stale_refresh_eligible(Some(&entry), false));
        assert!(stale_refresh_eligible(Some(&entry), true));
        assert!(!stale_refresh_eligible(None, true));
    }
}
