//! Pode apagar este hash da conta?
//!
//! Três fatos já lidos pelo Node. Inventário ausente não apaga ninguém:
//! sem prova de proveniência o fail-safe fecha. Hold do autofetch e proteção
//! durável também seguram. `knownBefore` é o acervo que já era do usuário.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeleteFacts {
    pub inventory_loaded: bool,
    pub known_before: bool,
    pub protected: bool,
}

/// `true` só quando os três fatos autorizam. Qualquer dúvida fica.
pub fn may_delete(facts: DeleteFacts) -> bool {
    facts.inventory_loaded && !facts.known_before && !facts.protected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_oito_combinacoes() {
        let cases = [
            (false, false, false, false),
            (false, false, true, false),
            (false, true, false, false),
            (false, true, true, false),
            (true, false, false, true),
            (true, false, true, false),
            (true, true, false, false),
            (true, true, true, false),
        ];
        for (inventory_loaded, known_before, protected, expect) in cases {
            assert_eq!(
                may_delete(DeleteFacts {
                    inventory_loaded,
                    known_before,
                    protected
                }),
                expect,
                "{inventory_loaded} {known_before} {protected}",
            );
        }
    }
}
