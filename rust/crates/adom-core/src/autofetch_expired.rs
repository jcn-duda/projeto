//! Porte puro de `src/providers/autofetch-expired.ts` — guarda de posse do
//! `expired-unready` (auditoria adversarial P1.2).
//!
//! O TS lê cache/held/inventário (IO); aqui tudo entra como FATOS medidos pelo
//! chamador. A função decide se é seguro apagar o hash do lote expirado direto
//! ou se ele deve ir para represados (`autofetch-suppressed`).
//!
//! Regra (AllDebrid): remoção exige PROVA de posse (marker OU adsub) +
//! snapshot carregado + hash ausente do snapshot + sem proteção vigente.
//! Serviço fora da AllDebrid preserva a remoção histórica (sem snapshot).

/// Fatos que o chamador injeta após consultar cache/held/inventário.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiredFacts {
    /// Hash normalizado está vazio (`!h`).
    pub hash_empty: bool,
    /// `held.isCleanupProtected(h, account, adapterId)` — proteção vigente.
    pub is_cleanup_protected: bool,
    /// `adapter.id === 'alldebrid'` — serviço que exige posse provada.
    pub adapter_is_alldebrid: bool,
    /// `cache.peek(markerKey(...)) != null` — prova de marker do enqueue.
    pub has_marker: bool,
    /// `submittedAt(account, h) != null` — prova de etiqueta durável adsub.
    pub has_adsub: bool,
    /// `knownBefore(apiKey, account)` retornou um Set (snapshot carregado).
    pub has_snapshot: bool,
    /// O hash está presente no snapshot de pré-existentes do usuário.
    pub in_snapshot: bool,
}

/// `true` só quando é seguro apagar o hash do lote expirado direto.
///
/// Serviço fora da AllDebrid: preserva a remoção histórica (snapshot só existe
/// lá). Dentro dela: exige posse provada (marker OU adsub) + snapshot carregado
/// + hash AUSENTE do snapshot (não é acervo do usuário).
pub fn expired_removal_allowed(facts: &ExpiredFacts) -> bool {
    if facts.hash_empty {
        return false;
    }
    if facts.is_cleanup_protected {
        return false;
    }
    if !facts.adapter_is_alldebrid {
        return true;
    }
    if !facts.has_marker && !facts.has_adsub {
        return false;
    }
    if !facts.has_snapshot {
        return false;
    }
    !facts.in_snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> ExpiredFacts {
        ExpiredFacts {
            hash_empty: false,
            is_cleanup_protected: false,
            adapter_is_alldebrid: true,
            has_marker: true,
            has_adsub: true,
            has_snapshot: true,
            in_snapshot: false,
        }
    }

    #[test]
    fn hash_vazio_nunca_remove() {
        let f = ExpiredFacts {
            hash_empty: true,
            ..base()
        };
        assert!(!expired_removal_allowed(&f));
    }

    #[test]
    fn protegido_nunca_remove() {
        let f = ExpiredFacts {
            is_cleanup_protected: true,
            ..base()
        };
        assert!(!expired_removal_allowed(&f));
    }

    #[test]
    fn nao_alldebrid_remove() {
        let f = ExpiredFacts {
            adapter_is_alldebrid: false,
            ..base()
        };
        assert!(expired_removal_allowed(&f));
    }

    #[test]
    fn alldebrid_sem_posse_nao_remove() {
        let f = ExpiredFacts {
            has_marker: false,
            has_adsub: false,
            ..base()
        };
        assert!(!expired_removal_allowed(&f));
    }

    #[test]
    fn alldebrid_sem_snapshot_nao_remove() {
        let f = ExpiredFacts {
            has_snapshot: false,
            ..base()
        };
        assert!(!expired_removal_allowed(&f));
    }

    #[test]
    fn alldebrid_preexistente_nao_remove() {
        let f = ExpiredFacts {
            in_snapshot: true,
            ..base()
        };
        assert!(!expired_removal_allowed(&f));
    }

    #[test]
    fn alldebrid_posse_provada_sem_protecao_remove() {
        assert!(expired_removal_allowed(&base()));
    }

    #[test]
    fn so_marker_basta() {
        let f = ExpiredFacts {
            has_adsub: false,
            ..base()
        };
        assert!(expired_removal_allowed(&f));
    }

    #[test]
    fn so_adsub_basta() {
        let f = ExpiredFacts {
            has_marker: false,
            ..base()
        };
        assert!(expired_removal_allowed(&f));
    }
}
