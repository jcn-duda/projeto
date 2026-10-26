use super::*;

fn serie() -> SearchMeta {
    let mut meta = SearchMeta::from_id("tt0409591:1:1");
    meta.name = "Naruto".into();
    meta.query = "Naruto S01E01".into();
    meta
}

fn item(hash: &str, seeders: f64) -> RawItem {
    RawItem {
        info_hash: Some(hash.into()),
        seeders: Some(seeders),
        ..RawItem::default()
    }
}

#[test]
fn pack_da_temporada_com_pt_e_original() {
    let mut meta = serie();
    meta.pt_query = Some("Naruto Clássico S01E01".into());
    meta.pt_title = Some("Naruto Clássico".into());
    meta.original_query = Some("NARUTO".into());
    meta.multi_work_query = Some("Raiz".into());
    let pack = pack_meta(&meta).expect("série tem pack");
    assert_eq!(pack.query, "Naruto S01");
    assert_eq!(pack.pt_query.as_deref(), Some("Naruto Clássico S01"));
    assert_eq!(pack.original_query.as_deref(), Some("NARUTO S01"));
    assert_eq!(pack.multi_work_query, None);
    assert_eq!(
        pack.season,
        Some(1),
        "o filtro de episódio continua valendo"
    );
}

#[test]
fn sem_query_pt_nao_ha_pack_pt_e_filme_nao_tem_pack() {
    let mut meta = serie();
    meta.pt_title = Some("Naruto".into());
    assert_eq!(pack_meta(&meta).expect("pack").pt_query, None);
    assert!(pack_meta(&SearchMeta::from_id("tt0133093")).is_none());
}

#[test]
fn fusao_por_hash_acrescenta_novo_e_so_sobe_seeders() {
    let mut base = vec![item(&"a".repeat(40), 5.0), item(&"b".repeat(40), 9.0)];
    let pack = vec![
        item(&"A".repeat(40), 12.0),
        item(&"b".repeat(40), 3.0),
        item(&"c".repeat(40), 1.0),
        item("", 7.0),
    ];
    let (fresh, fused) = fuse_pack(&mut base, pack);
    assert_eq!((fresh, fused), (1, 1));
    assert_eq!(base.len(), 3);
    assert_eq!(
        base[0].seeders,
        Some(12.0),
        "swarm maior atualiza a evidência"
    );
    assert_eq!(base[1].seeders, Some(9.0), "swarm menor não rebaixa");
}

/// Coletor que só registra as queries que recebeu (e devolve vazio).
struct Recorder(std::sync::Mutex<Vec<String>>);

impl super::super::Collector for Recorder {
    fn collect<'a>(
        &'a self,
        job: super::super::CollectJob,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<super::super::CollectBatch, String>>
                + Send
                + 'a,
        >,
    > {
        self.0.lock().unwrap().push(job.query.clone());
        Box::pin(async { Ok(super::super::CollectBatch::default()) })
    }
}

/// Coleta do episódio vazia: o fallback refaz com o pack da temporada.
#[tokio::test]
async fn coleta_vazia_dispara_o_pack_da_temporada() {
    use crate::orchestrator::tests::test_support::{config, MemorySwrStore};
    let recorder = std::sync::Arc::new(Recorder(std::sync::Mutex::new(Vec::new())));
    let orch = Orchestrator::new(config(), std::sync::Arc::new(MemorySwrStore::new()))
        .with_collector(recorder.clone());
    let input = SearchInput {
        kind: "series".into(),
        id: "tt0409591:1:1".into(),
        encoded: Some("e30".into()),
        prefix: String::new(),
        options: serde_json::json!({}),
        key: "k".into(),
        now_ms: 0,
        deadline_at: Some(super::super::respond::now_ms() + 5_000),
        fence: Default::default(),
    };
    let out = orch.pack_fallback(&input, &serie(), &[], false).await;
    assert!(out.is_some(), "episódio vazio → pack");
    assert_eq!(recorder.0.lock().unwrap().as_slice(), ["Naruto S01"]);

    // Com item relevante o fallback não roda.
    let mut achado = item(&"d".repeat(40), 3.0);
    achado.title = Some("Naruto S01E01 1080p".into());
    let mut meta = serie();
    meta.names = vec!["Naruto".into()];
    assert!(orch
        .pack_fallback(&input, &meta, &[achado], false)
        .await
        .is_none());
}
