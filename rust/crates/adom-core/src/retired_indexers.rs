//! Ids de indexer APOSENTADOS → substituto.
//!
//! Espelho de `RETIRED_INDEXERS` (`src/config/helpers.ts`). O mapa é o MESMO
//! nos dois lados de propósito: desde o F4.4 quem decide a lista EFETIVA de
//! indexers da busca é o Rust (`adom-search` monta o plano), enquanto o TS
//! ainda serve o `/configure` e as listas do env. Divergir entre os dois
//! significaria o TS mandando um id ao Jackett e o Rust outro — o indexer
//! sumiria da busca sem erro visível.
//!
//! Só de RENAME: um id que o operador escreve por decisão própria (ex.: religar
//! o `hdrtorrent`) nunca entra aqui, porque sumir com a escolha dele em
//! silêncio seria pior do que deixar o indexer falhar visivelmente.
//!
//! O QUE É RENOMEADO:
//! - a lista que o USUÁRIO selou na URL de instalação (`ji`), porque o card
//!   velho é ESTACIONADO e some do catálogo do Jackett: quem instalou antes
//!   do aposentadoria tem o id antigo gravado no link;
//! - as listas do OPERADOR vindas da env (`JACKETT_INDEXERS` e companhia),
//!   que são as mesmas que o Node lê.
//!
//! O QUE NÃO É RENOMEADO: a lista tirada do CATÁLOGO do Jackett (env vazia →
//! volume/cards habilitados). Ali o id é a verdade do que existe: renomear
//! um card ainda presente apontaria para um id que talvez não exista.

/// `(id aposentado, id substituto)`.
pub const RETIRED_INDEXERS: &[(&str, &str)] = &[
    // O indexer C# stock foi aposentado; o card local é o `-cardigann` que o
    // entrypoint registra no volume (scripts/entrypoint.sh).
    ("apachetorrent", "apachetorrent-cardigann"),
    // O stock do TorrentGalaxy idem: o card local `torrentgalaxy-cardigann` é o
    // que o entrypoint registra; o stock é ESTACIONADO (some do catálogo).
    ("torrentgalaxyclone", "torrentgalaxy-cardigann"),
];

/// Renomeia UM id de indexer aposentado. Id fora do mapa entra como está.
pub fn rename_indexer_id(id: &str) -> &str {
    RETIRED_INDEXERS
        .iter()
        .find(|(velho, _)| *velho == id)
        .map(|(_, novo)| *novo)
        .unwrap_or(id)
}

/// Renomeia uma LISTA de ids e deduplica (a ordem do primeiro aparecimento
/// manda). Espelha `renameIndexerIds` do TS.
///
/// O dedup é o ponto fino: uma lista que já cita o id novo E o velho produziria
/// a mesma entrada duas vezes, e o addon consultaria o indexer em dobro.
pub fn rename_indexer_ids<S: AsRef<str>>(ids: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let mapped = rename_indexer_id(id.as_ref()).to_string();
        if mapped.is_empty() || out.iter().any(|v| v == &mapped) {
            continue;
        }
        out.push(mapped);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renomeia_o_id_aposentado_do_torrentgalaxy() {
        assert_eq!(
            rename_indexer_id("torrentgalaxyclone"),
            "torrentgalaxy-cardigann"
        );
        assert_eq!(
            rename_indexer_id("apachetorrent"),
            "apachetorrent-cardigann"
        );
    }

    #[test]
    fn id_fora_do_mapa_passa_intacto() {
        // Escolha do operador: sumir com ela em silêncio seria pior do que
        // deixar o indexer falhar visivelmente.
        assert_eq!(rename_indexer_id("hdrtorrent"), "hdrtorrent");
        assert_eq!(
            rename_indexer_id("torrentgalaxy-cardigann"),
            "torrentgalaxy-cardigann"
        );
    }

    #[test]
    fn lista_renomeia_e_deduplica_mantendo_a_ordem() {
        assert_eq!(
            rename_indexer_ids(&[
                "torrentgalaxyclone".to_string(),
                "eztv".to_string(),
                "torrentgalaxy-cardigann".to_string(),
            ]),
            vec!["torrentgalaxy-cardigann".to_string(), "eztv".to_string()]
        );
    }

    #[test]
    fn lista_vazia_entra_vazia() {
        let vazio: Vec<String> = Vec::new();
        assert!(rename_indexer_ids(&vazio).is_empty());
    }
}
