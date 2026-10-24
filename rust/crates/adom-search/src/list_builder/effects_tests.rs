use super::*;
use serde_json::json;

fn stream(hash: &str, title: &str) -> RankingStream {
    RankingStream {
        info_hash: Some(hash.into()),
        title: Some(title.into()),
        name: Some(title.into()),
        ..RankingStream::default()
    }
}

fn cached(hashes: &[&str]) -> HashSet<String> {
    hashes.iter().map(|h| h.to_string()).collect()
}

#[test]
fn audita_so_o_dublado_em_cache_fora_da_reserva() {
    let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
    br.dubbed = Some(true);
    let mut reserva = stream("bbb", "Filme 2024 1080p DUBLADO");
    reserva.dubbed = Some(true);
    reserva.extra.insert("_fromFallback".into(), json!(true));
    let mut frio = stream("ccc", "Filme 2024 1080p DUBLADO");
    frio.dubbed = Some(true);
    let streams = vec![br, reserva, frio];
    let seeds = collect(&streams, &cached(&["aaa", "bbb"]), None, None);
    assert_eq!(seeds.audit.len(), 1);
    assert_eq!(seeds.audit[0].hash, "aaa");
    assert!(seeds.audit[0].dubbed);
    assert!(!seeds.audit[0].needs_promote);
}

#[test]
fn claim_sem_prova_pede_promocao() {
    let mut claim = stream("aaa", "Filme 2024 1080p");
    claim.dub_claim = Some(true);
    let seeds = collect(&[claim], &cached(&["aaa"]), None, None);
    assert_eq!(seeds.audit.len(), 1);
    assert!(seeds.audit[0].needs_promote);
}

#[test]
fn serie_interroga_pack_que_nao_nomeia_o_episodio() {
    let mut pack = stream("ddd", "Serie S01 COMPLETE 1080p");
    pack.br = Some(true);
    // Nomeia o EPISÓDIO PEDIDO (E01): a prova dele não é assunto do tail.
    let mut episodio = stream("eee", "Serie S01E01 1080p");
    episodio.br = Some(true);
    let seeds = collect(
        &[pack, episodio],
        &cached(&["ddd", "eee"]),
        Some(1),
        Some(1),
    );
    // O pack não nomeia o E01 → entra; o E02 nomeia → fica fora.
    assert_eq!(seeds.audit.len(), 1);
    assert_eq!(seeds.audit[0].hash, "ddd");
    assert!(!seeds.audit[0].dubbed);
}

#[test]
fn filme_nao_entra_no_grupo_de_episodio() {
    let frio = stream("fff", "Filme 2024 1080p");
    let seeds = collect(&[frio], &cached(&["fff"]), None, None);
    assert!(seeds.audit.is_empty());
}

#[test]
fn warmer_pega_os_tres_tiers_e_corta_reserva_e_multiobra() {
    let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
    br.br = Some(true);
    br.dubbed = Some(true);
    br.seeders = Some(50.0);
    br.quality = Some("1080p".into());
    let mut global = stream("bbb", "Movie 2024 1080p DUBLADO");
    global.dubbed = Some(true);
    global.seeders = Some(5.0);
    let mut swarm = stream("ccc", "Movie 2024 720p");
    swarm.seeders = Some(900.0);
    swarm.quality = Some("720p".into());
    let mut reserva = stream("ddd", "Filme 2024 1080p DUBLADO");
    reserva.dubbed = Some(true);
    reserva.extra.insert("_fromFallback".into(), json!(true));
    let mut multi = stream("eee", "Colecao 1080p DUBLADO");
    multi.dubbed = Some(true);
    multi.multi_work_admitted = Some(true);

    let seeds = collect(
        &[br, global, swarm, reserva, multi],
        &cached(&[]),
        None,
        None,
    );
    let hashes: Vec<&str> = seeds.warmer.iter().map(|s| s.hash.as_str()).collect();
    assert_eq!(hashes, vec!["aaa", "bbb", "ccc"]);
    assert!(seeds.warmer[0].is_br && seeds.warmer[0].dubbed);
    assert!(!seeds.warmer[2].dubbed);
}

#[test]
fn warmer_nao_repete_hash_entre_tiers() {
    let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
    br.br = Some(true);
    br.dubbed = Some(true);
    br.seeders = Some(9.0);
    br.quality = Some("1080p".into());
    let seeds = collect(&[br], &cached(&[]), None, None);
    // O mesmo hash apareceria nos 3 tiers; o payload carrega UMA vez.
    assert_eq!(seeds.warmer.len(), 1);
    assert_eq!(seeds.warmer[0].hash, "aaa");
}

#[test]
fn autofetch_leva_os_fatos_internos_do_stream() {
    let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
    br.br = Some(true);
    br.dubbed = Some(true);
    br.dub_claim = Some(true);
    br.seeders = Some(12.0);
    br.quality = Some("1080p".into());
    br.size = Some(1_000.0);
    br.indexer = Some("bludv".into());
    br.tracker = Some("bludv".into());
    br.extra.insert("_packBytes".into(), json!(4_000.0));
    br.extra.insert("bankDub".into(), json!(true));
    br.lied = Some(true);
    br.extra.insert("_seedFloorWaived".into(), json!(true));

    let seeds = collect(&[br.clone()], &cached(&["AAA"]), Some(2), Some(3));
    // O conjunto de cache vai em minúsculas e o lote sai do universo.
    assert_eq!(seeds.cached, vec!["aaa".to_string()]);

    let items = autofetch_items(&[br]);
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.hash, "aaa");
    assert_eq!(item.title, "Filme 2024 1080p DUBLADO");
    assert_eq!(item.name, "Filme 2024 1080p DUBLADO");
    assert!(item.br && item.dubbed && item.dub_claim);
    assert_eq!(item.seeders, Some(12.0));
    assert_eq!(item.quality.as_deref(), Some("1080p"));
    assert_eq!(item.size, Some(1_000.0));
    assert_eq!(item.pack_bytes, Some(4_000.0));
    assert_eq!(item.indexer.as_deref(), Some("bludv"));
    assert_eq!(item.tracker.as_deref(), Some("bludv"));
    assert!(item.seed_floor_waived);
    assert!(item.bank_dub);
    assert!(item.lied);
    assert!(!item.multi_work_admitted);
    assert!(!item.from_fallback && !item.fallback_fetchable);
}

#[test]
fn autofetch_exclui_multiobra_e_reserva_nao_elegivel() {
    let mut br = stream("aaa", "Filme 2024 1080p DUBLADO");
    br.br = Some(true);
    br.dubbed = Some(true);
    br.quality = Some("1080p".into());

    let mut multi = stream("bbb", "Colecao 1080p DUBLADO");
    multi.multi_work_admitted = Some(true);

    let mut reserva_bloqueada = stream("ccc", "Filme 2024 1080p DUBLADO");
    reserva_bloqueada
        .extra
        .insert("_fromFallback".into(), json!(true));

    let mut reserva_elegivel = stream("ddd", "Filme 2024 720p DUBLADO");
    reserva_elegivel.br = Some(true);
    reserva_elegivel.dubbed = Some(true);
    reserva_elegivel
        .extra
        .insert("_fromFallback".into(), json!(true));
    reserva_elegivel
        .extra
        .insert("_fallbackFetchable".into(), json!(true));

    let sem_hash = stream("", "Sem hash");

    let items = autofetch_items(&[br, multi, reserva_bloqueada, reserva_elegivel, sem_hash]);
    let hashes: Vec<&str> = items.iter().map(|item| item.hash.as_str()).collect();
    assert_eq!(hashes, vec!["aaa", "ddd"]);
    assert!(items[1].from_fallback && items[1].fallback_fetchable);
    assert!(!items[0].from_fallback);
}
