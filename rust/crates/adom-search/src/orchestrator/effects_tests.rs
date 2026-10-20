//! Testes dos payloads dos efeitos de cauda: forma do fio (o que
//! `src/routes/internal-search-effects.ts` valida) e os gates locais.

use super::*;
use crate::list_builder::{AuditSeed, WarmerSeed};
use serde_json::{json, Value};

const HASH: &str = "0123456789abcdef0123456789abcdef01234567";

fn work() -> WorkHint {
    WorkHint {
        names: vec!["Filme Teste".into()],
        year: Some(2024),
    }
}

fn ctx<'a>(work: &'a WorkHint, adapter: &'a str, key: &'a str) -> EffectContext<'a> {
    EffectContext {
        adapter_id: adapter,
        api_key: key,
        imdb_id: "tt0133093",
        season: None,
        episode: None,
        search_key: "streams:v21:movie:tt0133093:x:account:y",
        work: Some(work),
    }
}

fn seeds() -> EffectSeeds {
    EffectSeeds {
        audit: vec![AuditSeed {
            hash: HASH.into(),
            dubbed: true,
            needs_promote: false,
            pack: false,
        }],
        warmer: vec![WarmerSeed {
            hash: HASH.into(),
            title: "Filme Teste 2024 1080p DUBLADO".into(),
            is_br: true,
            dubbed: true,
        }],
    }
}

fn kind<'a>(effects: &'a [EffectEntry], name: &str) -> Option<&'a EffectEntry> {
    effects.iter().find(|effect| effect.kind == name)
}

#[test]
fn dub_audit_tem_a_forma_que_a_rota_do_node_valida() {
    let work = work();
    let effects = build_effects(&seeds(), &ctx(&work, "alldebrid", "chave"));
    let effect = kind(&effects, "dub_audit").expect("dub_audit no lote");
    let payload = &effect.payload;
    assert_eq!(payload["adapter_id"], json!("alldebrid"));
    assert_eq!(payload["api_key"], json!("chave"));
    assert!(payload["candidates"].is_array());
    assert_eq!(
        payload["search_key"],
        json!("streams:v21:movie:tt0133093:x:account:y")
    );
    let candidate = &payload["candidates"][0];
    assert_eq!(candidate["hash"], json!(HASH));
    assert_eq!(candidate["imdbId"], json!("tt0133093"));
    assert_eq!(candidate["dubbed"], json!(true));
    assert_eq!(candidate["needsPromote"], json!(false));
    assert_eq!(candidate["work"]["names"][0], json!("Filme Teste"));
    assert_eq!(candidate["work"]["year"], json!(2024));
    assert_eq!(candidate["work"]["pack"], json!(false));
    // `season`/`episode` de filme são `null`, nunca 0.
    assert_eq!(candidate["season"], Value::Null);
    assert_eq!(candidate["episode"], Value::Null);
}

#[test]
fn dub_audit_leva_season_episode_da_serie() {
    let work = work();
    let mut contexto = ctx(&work, "realdebrid", "chave");
    contexto.season = Some(2);
    contexto.episode = Some(3);
    let effect = dub_audit(&seeds(), &contexto).expect("efeito");
    let candidate = &effect.payload["candidates"][0];
    assert_eq!(candidate["season"], json!(2));
    assert_eq!(candidate["episode"], json!(3));
}

#[test]
fn dub_audit_sem_conta_ou_adaptador_nao_sai() {
    let work = work();
    assert!(dub_audit(&seeds(), &ctx(&work, "", "chave")).is_none());
    assert!(dub_audit(&seeds(), &ctx(&work, "alldebrid", "")).is_none());
    let vazio = EffectSeeds::default();
    assert!(dub_audit(&vazio, &ctx(&work, "alldebrid", "chave")).is_none());
}

#[test]
fn rd_warmer_leva_releases_com_hash_minusculo_e_marcas() {
    let work = work();
    let effects = build_effects(&seeds(), &ctx(&work, "alldebrid", "chave"));
    let effect = kind(&effects, "rd_warmer").expect("rd_warmer no lote");
    let releases = effect.payload["releases"].as_array().expect("array");
    assert_eq!(releases.len(), 1);
    assert_eq!(releases[0]["infoHash"], json!(HASH));
    assert_eq!(releases[0]["isBr"], json!(true));
    assert_eq!(releases[0]["dubbed"], json!(true));
    assert!(releases[0]["title"].as_str().unwrap().contains("DUBLADO"));
}

#[test]
fn rd_warmer_vazio_nao_vira_efeito() {
    let vazio = EffectSeeds::default();
    assert!(rd_warmer(&vazio).is_none());
}

#[test]
fn proximo_episodio_so_com_play_e_serie_com_s_e() {
    let next = harvester_next_episode("series", "tt0903747", Some(5), Some(14), true)
        .expect("episódio seguinte");
    assert_eq!(next.kind, "harvester_enqueue");
    assert_eq!(next.payload["imdbId"], json!("tt0903747"));
    assert_eq!(next.payload["type"], json!("series"));
    assert_eq!(next.payload["season"], json!(5));
    assert_eq!(next.payload["episode"], json!(15));
    assert_eq!(next.payload["reason"], json!("next-episode"));

    // Sem play tocável, filme, ou sem S/E: nada sobe (o TS também não enfileira).
    assert!(harvester_next_episode("series", "tt0903747", Some(5), Some(14), false).is_none());
    assert!(harvester_next_episode("movie", "tt0133093", None, None, true).is_none());
    assert!(harvester_next_episode("series", "tt0903747", None, None, true).is_none());
    assert!(harvester_next_episode("series", "tt0903747", Some(5), None, true).is_none());
}

#[test]
fn season_key_usa_o_digest_da_conta_e_nao_a_chave() {
    let effect = season_key(
        "realdebrid",
        "chave-secreta",
        "tt0903747",
        5,
        "streams:v21:…",
    )
    .expect("season_key");
    assert_eq!(effect.kind, "season_key");
    let account = effect.payload["account"].as_str().expect("account");
    assert_eq!(
        account,
        adom_core::account_scope(&json!("chave-secreta")),
        "digest SHA-256 da chave, como accountScope"
    );
    assert_eq!(account.len(), 64);
    assert!(!account.contains("chave-secreta"));
    assert_eq!(effect.payload["adapter_id"], json!("realdebrid"));
    assert_eq!(effect.payload["imdb"], json!("tt0903747"));
    assert_eq!(effect.payload["season"], json!(5));
    assert_eq!(effect.payload["cache_key"], json!("streams:v21:…"));
}

#[test]
fn season_key_sem_conta_servico_ou_temporada_nao_sai() {
    assert!(season_key("", "chave", "tt1", 1, "ck").is_none());
    assert!(season_key("realdebrid", "", "tt1", 1, "ck").is_none());
    assert!(season_key("realdebrid", "chave", "tt1", 0, "ck").is_none());
    assert!(season_key("realdebrid", "chave", "tt1", 1, "").is_none());
    assert!(season_key("realdebrid", "chave", "sem-imdb", 1, "ck").is_none());
}

#[test]
fn lote_vazio_nao_produz_efeito() {
    let work = work();
    let effects = build_effects(&EffectSeeds::default(), &ctx(&work, "alldebrid", "chave"));
    assert!(effects.is_empty());
}
