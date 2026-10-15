//! Sombra da decisão de apagar na AllDebrid.
//!
//! O Node ainda executa (`mayDeleteHash` em `src/utils/rust-debrid-clean.ts`).
//! Aqui só se responde se os três fatos que o play e a varredura de
//! não-dublados já leem autorizam a saída. A fórmula é a de
//! `adom_core::may_delete`: inventário ausente não apaga ninguém.
//!
//! Fora desta função: fila, `/magnet/delete`, idade, estado do magnet,
//! veredito de áudio e o `dropUncached`/`dropReady` (o chamador faz o E).
//! A varredura de mortos também fica de fora: ela não consulta estes fatos.

use adom_core::{may_delete, DeleteFacts};

/// `true` só com inventário carregado, hash novo e sem proteção.
///
/// Inventário desligado, `known_before` ou protegido fecham o fail-safe.
/// Qualquer um dos três basta para ficar.
pub fn would_delete(facts: DeleteFacts) -> bool {
    may_delete(facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(inventory_loaded: bool, known_before: bool, protected: bool) -> DeleteFacts {
        DeleteFacts {
            inventory_loaded,
            known_before,
            protected,
        }
    }

    /// As oito combinações. Só uma autoriza.
    ///
    /// | inventory_loaded | known_before | protected | would_delete |
    /// |------------------|--------------|-----------|--------------|
    /// | false            | false        | false     | false        |
    /// | false            | false        | true      | false        |
    /// | false            | true         | false     | false        |
    /// | false            | true         | true      | false        |
    /// | true             | false        | false     | true         |
    /// | true             | false        | true      | false        |
    /// | true             | true         | false     | false        |
    /// | true             | true         | true      | false        |
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
            let got = would_delete(facts(inventory_loaded, known_before, protected));
            assert_eq!(got, expect, "{inventory_loaded} {known_before} {protected}",);
            assert_eq!(
                got,
                may_delete(facts(inventory_loaded, known_before, protected)),
                "sombra divergiu do núcleo",
            );
        }
    }

    #[test]
    fn inventario_desligado_nao_apaga() {
        // Check com snapshot ausente passa inventory_loaded falso.
        // A varredura nem chama: inventário frio pula a rodada inteira.
        assert!(!would_delete(facts(false, false, false)));
        assert!(!would_delete(facts(false, true, true)));
    }

    #[test]
    fn protegido_nao_apaga() {
        // Play: hold (`opts.held` / `skipCleanup`) segura o download do autofetch.
        // Varredura: a mesma proteção, com inventário já carregado.
        assert!(!would_delete(facts(true, false, true)));
    }

    #[test]
    fn known_before_nao_apaga() {
        // Acervo que já era do usuário. No play este fato é sempre falso:
        // o id nasceu no upload desta resolução.
        assert!(!would_delete(facts(true, true, false)));
    }

    #[test]
    fn play_apaga_o_que_acabou_de_subir_sem_hold() {
        // Fatos fixos do play: inventário ligado, known_before falso.
        // `dropUncached` fica no chamador.
        assert!(would_delete(facts(true, false, false)));
    }

    #[test]
    fn varredura_so_autoriza_hash_novo_sem_protecao() {
        // A varredura de não-dublados só chega aqui com inventário carregado.
        assert!(would_delete(facts(true, false, false)));
        assert!(!would_delete(facts(true, true, false)));
        assert!(!would_delete(facts(true, false, true)));
    }
}
