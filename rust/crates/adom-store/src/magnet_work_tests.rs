//! `magnet_work` com dono único (fatia T2-L4): a API de UMA linha que a captura
//! nativa usa e que o escritor TS perde quando `magnet-bank-rows.ts` sair.
//!
//! Dois comportamentos que o CAS protege e que não podem se perder na troca de
//! dono:
//!
//! 1. captura ATRASADA (carimbo menor) não "desmarca" `passed_filter` nem reduz
//!    `last_seen` — `last_seen` é `MAX` e o veredito do filtro só cede para uma
//!    observação igual ou mais nova (o lost update da Fase 4.0.4);
//! 2. `mark_work_filter` só ATUALIZA linha existente: fonte sem captura (não
//!    Jackett) não cria obra órfã — `UPDATE ... WHERE` com 0 linhas é `false`.

use adom_core::WorkTarget;

use crate::MagnetBankStore;

/// Hash de 40 hex como um `infoHash` real: o banco não valida o formato, mas o
/// teste fica com a mesma cara da produção.
const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
const IMDB: &str = "tt1";
/// Hash que NUNCA foi capturado (linha ausente em `magnet_work`).
const AUSENTE: &str = "fedcba9876543210fedcba9876543210fedcba98";

/// Raiz da obra (`season`/`episode` nulos viram -1 na PK).
fn raiz() -> WorkTarget {
    WorkTarget {
        season: None,
        episode: None,
    }
}

#[test]
fn cas_nao_regride_passed_filter_nem_last_seen() {
    let bank = MagnetBankStore::open_memory().expect("memória");
    bank.upsert_work(HASH, IMDB, -1, -1, 1_000)
        .expect("captura inicial");
    assert!(
        bank.mark_work_filter(HASH, IMDB, -1, -1, true, 2_000)
            .expect("marca"),
        "linha existente é atualizada"
    );

    // Captura atrasada, com carimbo menor: não pode "desmarcar".
    bank.upsert_work(HASH, IMDB, -1, -1, 1_500)
        .expect("captura atrasada");

    let rows = bank
        .works_for_obra_many(IMDB, &[raiz()], 10, 10, None)
        .expect("obra");
    assert_eq!(rows.len(), 1, "linha viva");
    assert_eq!(rows[0].hash, HASH);
    assert_eq!(rows[0].passed_filter, 1, "carimbo antigo não desmarca");
    assert_eq!(rows[0].last_seen, 2_000, "last_seen é MAX");
    assert_eq!(rows[0].first_seen, 1_000, "first_seen é fixo");
}

#[test]
fn mark_work_filter_em_linha_ausente_cria_sem_passed_filter() {
    let bank = MagnetBankStore::open_memory().expect("memória");
    assert!(
        !bank
            .mark_work_filter(AUSENTE, "tt9", -1, -1, true, 1_000)
            .expect("marca"),
        "UPDATE sem linha devolve false"
    );
    let rows = bank
        .works_for_obra_many("tt9", &[raiz()], 10, 10, None)
        .expect("obra");
    assert!(rows.is_empty(), "nenhuma linha é criada");
}
