//! Testes da varredura e dos relatórios (`scan.rs`). Casos portados de
//! `test/catalog.test.ts` (upsert, tombstone, índice reverso, ⚡ do ready) e
//! de `test/catalog-audit.test.ts` (classificação por título e por arquivo).
//! Sem rede e sem relógio: o instante e os fatos vivos entram explícitos.
//! Os auxiliares `pub(crate)` são reusados por `audit_tests.rs`.

use std::collections::HashMap;

use super::*;

pub(crate) const ADAPTER: &str = "alldebrid";
pub(crate) const ACCOUNT: &str = "conta-de-teste";
pub(crate) const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Listas calibradas: os padrões de `src/config/audit.ts`.
pub(crate) const PT_MARKERS: &[&str] = &[
    "dublado",
    "dublada",
    "dublagem",
    "dubbed",
    "dual audio",
    "dual",
    "pt br",
    "ptbr",
    "portugues",
    "portuguese",
    "nacional",
    "fleg",
];
pub(crate) const EN_GROUPS: &[&str] = &[
    "rarbg", "killers", "ettv", "afm72", "tovar", "evo", "megusta", "galaxyrg", "glxrc", "yts",
    "fgt", "ntb", "roarb", "oxy", "bae", "drs", "huzzah", "tgx", "ethel", "yify",
];

pub(crate) fn magnet(id: &str, hash: &str, filename: &str) -> Magnet {
    Magnet {
        id: Some(id.to_string()),
        hash: hash.to_string(),
        filename: filename.to_string(),
        size: 0,
        status: "Ready".to_string(),
        ready: true,
        upload_date: 1000,
    }
}

pub(crate) fn no_evidence(_: &str) -> Option<FileEvidence> {
    None
}

pub(crate) fn unknown_status(_: &str) -> String {
    "unknown".to_string()
}

/// Varredura com todos os fatos explícitos.
pub(crate) fn run_with(
    store: &CatalogStore,
    magnets: &[Magnet],
    now_ms: i64,
    reverse: &HashMap<String, WorkRef>,
    evidence: &dyn Fn(&str) -> Option<FileEvidence>,
    status: &dyn Fn(&str) -> String,
) -> CatalogReport {
    let input = ScanInput {
        adapter_id: ADAPTER,
        account: ACCOUNT,
        magnets,
        now_ms,
    };
    let facts = ScanFacts {
        file_evidence: evidence,
        reverse,
        release_status: status,
        pt_markers: PT_MARKERS,
        en_groups: EN_GROUPS,
    };
    scan(store, &input, &facts).unwrap()
}

/// Varredura sem evidência e sem obra conhecida, com status quieto `unknown`.
pub(crate) fn run(store: &CatalogStore, magnets: &[Magnet], now_ms: i64) -> CatalogReport {
    let empty = HashMap::new();
    run_with(
        store,
        magnets,
        now_ms,
        &empty,
        &no_evidence,
        &unknown_status,
    )
}

pub(crate) fn get(store: &CatalogStore, id: &str) -> CatalogRowView {
    row(store, ADAPTER, ACCOUNT, id).unwrap().unwrap()
}

#[test]
fn scan_grava_preserva_first_seen_e_tomba_o_sumido_que_reabre() {
    let s = CatalogStore::open_memory().unwrap();
    run(
        &s,
        &[
            magnet("1", HASH_A, "Filme 2024 Dublado 1080p"),
            magnet("2", HASH_B, "Outro 2024 Legendado 720p"),
        ],
        1000,
    );
    let first_seen = get(&s, "1").first_seen_at;
    assert!(first_seen > 0);

    // Re-scan do mesmo service_id: atualiza campos, mas NÃO regride first_seen.
    let mut again = magnet("1", HASH_A, "A 2024 Dublado 1080p");
    again.size = 123_456;
    run(&s, &[again], 2000);
    assert_eq!(get(&s, "1").first_seen_at, first_seen);
    assert_eq!(get(&s, "1").size, 123_456, "os demais campos atualizam");

    // '1' saiu da conta: tombstone. '2' continua vivo.
    run(
        &s,
        &[magnet("2", HASH_B, "Outro 2024 Legendado 720p")],
        3000,
    );
    assert_eq!(get(&s, "1").deleted_at, 3000, "o sumido é tombstonado");
    assert_eq!(get(&s, "1").delete_reason, "ausente da conta");
    assert_eq!(get(&s, "2").deleted_at, 0, "o presente continua vivo");

    // O MESMO service_id voltou à conta: reabre e mantém first_seen.
    run(
        &s,
        &[
            magnet("1", HASH_A, "A 2024 Dublado 1080p"),
            magnet("2", HASH_B, "Outro 2024 Legendado 720p"),
        ],
        4000,
    );
    assert_eq!(get(&s, "1").deleted_at, 0, "reaberto: limpa o tombstone");
    assert_eq!(get(&s, "1").delete_reason, "");
    assert_eq!(get(&s, "1").first_seen_at, first_seen);
}

#[test]
fn scan_associa_o_indice_reverso_e_separa_conhecida_de_desconhecida() {
    let reverse = reverse_index([(
        "tt9000001".to_string(),
        vec![IndexedRelease {
            hash: HASH_A.to_string(),
            title: "Filme 2024 Dublado 1080p".to_string(),
            is_br: true,
            ..IndexedRelease::default()
        }],
    )]);
    let s = CatalogStore::open_memory().unwrap();
    let r = run_with(
        &s,
        &[
            magnet("1", HASH_A, "Filme 2024 Dublado 1080p"),
            magnet("2", HASH_B, "Não Existe Nenhuma 2020 720p"),
        ],
        1000,
        &reverse,
        &no_evidence,
        &unknown_status,
    );
    assert_eq!(r.works.known, 1, "a obra resolvida conta como conhecida");
    assert_eq!(r.works.unknown, 1, "o sem obra no índice é desconhecido");
    assert_eq!(r.unresolved_hashes, 1);
    assert_eq!(get(&s, "1").imdb_id, "tt9000001");
    assert_eq!(get(&s, "1").bucket, "dub");
    assert_eq!(get(&s, "2").imdb_id, "");
}

#[test]
fn reverse_index_primeira_obra_vence_e_release_sem_hash_some() {
    let rel = |hash: &str, title: &str| IndexedRelease {
        hash: hash.to_string(),
        title: title.to_string(),
        ..IndexedRelease::default()
    };
    let reverse = reverse_index([
        (
            "tt1".to_string(),
            vec![
                IndexedRelease {
                    dubbed: true,
                    ..rel(HASH_A, "primeiro")
                },
                IndexedRelease::default(),
            ],
        ),
        ("tt2".to_string(), vec![rel(HASH_A, "segundo")]),
    ]);
    assert_eq!(
        reverse.len(),
        1,
        "um hash, uma entrada; release sem hash some"
    );
    let work = &reverse[HASH_A];
    assert_eq!(work.imdb_id, "tt1", "a primeira obra que traz o hash ganha");
    assert_eq!(work.title, "primeiro");
    assert!(work.dubbed && !work.is_br && !work.lied);
}

#[test]
fn scan_casa_o_hash_em_minusculas_com_o_indice() {
    // A conta pode devolver o hash em maiúsculas; a linha grava minúsculas e o
    // casamento com o índice também usa minúsculas.
    let reverse = reverse_index([(
        "tt7".to_string(),
        vec![IndexedRelease {
            hash: HASH_A.to_string(),
            title: "Filme".to_string(),
            ..IndexedRelease::default()
        }],
    )]);
    let s = CatalogStore::open_memory().unwrap();
    let up = HASH_A.to_uppercase();
    let r = run_with(
        &s,
        &[magnet("1", &up, "Filme 2024 1080p")],
        1000,
        &reverse,
        &no_evidence,
        &unknown_status,
    );
    assert_eq!(get(&s, "1").hash, HASH_A);
    assert_eq!(get(&s, "1").imdb_id, "tt7");
    assert_eq!(r.works.known, 1);
}

#[test]
fn magnet_ready_na_conta_e_hit_e_o_nao_ready_consulta_o_status_quieto() {
    // O ⚡ de quem está pronto na conta não consulta o status quieto; só o
    // não-pronto recebe o veredito quieto.
    let s = CatalogStore::open_memory().unwrap();
    let mut frio = magnet("2", HASH_B, "Frio 2024 Legendado 720p");
    frio.ready = false;
    let calls = std::cell::Cell::new(0);
    let status = |_: &str| {
        calls.set(calls.get() + 1);
        "miss".to_string()
    };
    let pronto = magnet("1", HASH_A, "Pronto 2024 Dublado 1080p");
    let r = run_with(
        &s,
        &[pronto, frio],
        1000,
        &HashMap::new(),
        &no_evidence,
        &status,
    );
    assert_eq!(get(&s, "1").cached, "hit", "ready na conta = tocável agora");
    assert_eq!(get(&s, "2").cached, "miss", "não-ready: veredito quieto");
    assert_eq!(calls.get(), 1, "o status quieto só roda para o não-ready");
    assert_eq!(r.by_cached.get("hit"), Some(&1));
    assert_eq!(r.by_cached.get("miss"), Some(&1));
}

#[test]
fn scan_pula_linha_sem_id_ou_sem_hash_mas_conta_todos_os_recebidos() {
    let s = CatalogStore::open_memory().unwrap();
    let mut sem_id = magnet("x", HASH_A, "Sem id 2024 1080p");
    sem_id.id = None;
    let r = run(
        &s,
        &[
            sem_id,
            magnet("2", "", "Sem hash 2024 1080p"),
            magnet("3", HASH_B, "Com hash 2024 1080p"),
        ],
        1000,
    );
    assert_eq!(r.scanned, 3, "o scanned conta o que a API devolveu");
    assert_eq!(r.magnets, 1, "só a linha válida entra no relatório");
    assert_eq!(row(&s, ADAPTER, ACCOUNT, "2").unwrap(), None);
    assert!(row(&s, ADAPTER, ACCOUNT, "3").unwrap().is_some());
}

#[test]
fn evidencia_de_arquivo_classifica_e_carimba_a_auditoria() {
    // Título sem marca; o arquivo é a prova: dublado absolve com `arquivo`, o
    // áudio vem da evidência e o carimbo sai do próprio scan.
    let s = CatalogStore::open_memory().unwrap();
    let evidence = |h: &str| {
        (h == HASH_A).then(|| FileEvidence {
            a: "Dublado".to_string(),
            n: "Filme DUBLADO 1080p.mkv".to_string(),
        })
    };
    let empty = HashMap::new();
    let m = [magnet("1", HASH_A, "Some English Movie 2020 1080p")];
    run_with(&s, &m, 5000, &empty, &evidence, &unknown_status);
    let got = get(&s, "1");
    assert_eq!(got.pt_proof, "arquivo");
    assert_eq!(got.audio, "Dublado");
    assert_eq!(
        got.audited_at, 5000,
        "scan que vê evidência já carimba a linha"
    );
}

#[test]
fn classificacao_por_titulo_absolve_como_titulo_sem_carimbo() {
    // Sem arquivo, o título absolve de forma FRACA: `titulo`, e a linha segue
    // na fila (audited_at = 0).
    let s = CatalogStore::open_memory().unwrap();
    run(
        &s,
        &[magnet("1", HASH_A, "Nome do Filme Dublado 2024 1080p")],
        1000,
    );
    assert_eq!(get(&s, "1").pt_proof, "titulo");
    assert_eq!(get(&s, "1").audited_at, 0);
}

#[test]
fn relatorio_so_conta_ativos_e_soma_por_balde_e_cache() {
    let s = CatalogStore::open_memory().unwrap();
    let mut grande = magnet("2", HASH_B, "Outro 2020 Legendado 720p");
    grande.size = 9_000;
    let mut pequeno = magnet("1", HASH_A, "Filme 2024 Dublado 1080p");
    pequeno.size = 1_000;
    run(&s, &[pequeno.clone(), grande], 1000);
    run(&s, &[pequeno], 2000); // o "2" sumiu: tombstone

    let r = report(&s, ADAPTER, Some(ACCOUNT), 3000).unwrap();
    assert_eq!(r.scanned_at, 3000);
    assert_eq!(r.magnets, 1, "o tombstonado não entra");
    assert_eq!(r.ready, 1);
    assert_eq!(
        r.totals,
        CountBytes {
            count: 1,
            bytes: 1_000
        }
    );
    let dub = CountBytes {
        count: 1,
        bytes: 1_000,
    };
    assert_eq!(r.by_bucket.get("dub"), Some(&dub));
    assert_eq!(r.by_cached.get("hit"), Some(&1));
    assert_eq!(
        r.works,
        WorksCount {
            known: 0,
            unknown: 1
        }
    );
    assert_eq!(
        r.unresolved_hashes, 1,
        "na leitura, o não-resolvido é o desconhecido"
    );
}

#[test]
fn relatorio_sem_conta_cai_em_none() {
    let s = CatalogStore::open_memory().unwrap();
    run(&s, &[magnet("1", HASH_A, "Filme 2024 Dublado 1080p")], 1000);
    let vazio = report(&s, ADAPTER, None, 2000).unwrap();
    assert_eq!(vazio.magnets, 0, "a conta 'none' não tem linhas");
    assert_eq!(vazio.scanned, 0, "a leitura não repete o scanned");
    assert_eq!(report(&s, ADAPTER, Some(""), 2000).unwrap().magnets, 0);
}

#[test]
fn row_devolve_none_quando_a_linha_nao_existe() {
    let s = CatalogStore::open_memory().unwrap();
    assert_eq!(row(&s, ADAPTER, ACCOUNT, "nada").unwrap(), None);
}

#[test]
fn relatorio_serializa_com_os_nomes_que_o_painel_le() {
    let s = CatalogStore::open_memory().unwrap();
    let r = run(&s, &[magnet("1", HASH_A, "Filme 2024 Dublado 1080p")], 1000);
    let json = serde_json::to_value(&r).unwrap();
    let keys = [
        "scannedAt",
        "scanned",
        "magnets",
        "ready",
        "totals",
        "byBucket",
        "byCached",
        "works",
        "unresolvedHashes",
    ];
    for key in keys {
        assert!(json.get(key).is_some(), "falta a chave {key}");
    }
    assert_eq!(json["byBucket"]["dub"]["count"], 1);
    assert_eq!(json["works"]["unknown"], 1);
}
