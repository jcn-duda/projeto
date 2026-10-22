//! Testes da captura do banco VIVO (`magnet_capture`): o recorte do lote, o
//! grupo `indexer || tracker` e o teto de corpo do transporte.
//!
//! O par Node (`test/internal-search-effects.test.ts`) prova o outro lado do
//! fio: o `kind` aceito, o `resetPassedFilter:false` forçado e o payload
//! inválido recusado sem derrubar a rota.

use super::*;
use crate::raw_item::RawItem;
use serde_json::{json, Value};

/// Hash de 40 hex válido (um nibble não zero basta — `extract_info_hash`
/// recusa só o sentinela tudo-zero).
fn hash(n: usize) -> String {
    format!("{n:040x}")
}

fn item_of(n: usize, indexer: Option<&str>, tracker: Option<&str>) -> RawItem {
    RawItem {
        title: Some(format!("Filme Teste {n} 1080p")),
        info_hash: Some(hash(n)),
        magnet: Some(format!("magnet:?xt=urn:btih:{}&dn=filme", hash(n))),
        indexer: indexer.map(str::to_string),
        tracker: tracker.map(str::to_string),
        seeders: Some(10.0),
        ..RawItem::default()
    }
}

fn items_of(total: usize, indexer: &str) -> Vec<RawItem> {
    (1..=total)
        .map(|n| item_of(n, Some(indexer), None))
        .collect()
}

fn payload_items(effect: &EffectEntry) -> &Vec<Value> {
    effect.payload["items"].as_array().expect("items array")
}

#[test]
fn recorta_450_itens_em_tres_efeitos_de_200_200_50() {
    let items = items_of(450, "bludv");
    let effects = magnet_capture(&items, "tt0133093", None, None, &json!("2024"));

    assert_eq!(effects.len(), 3, "450 itens = 200 + 200 + 50");
    for (effect, size) in effects.iter().zip([200usize, 200, 50]) {
        assert_eq!(effect.kind, "magnet_capture");
        assert_eq!(payload_items(effect).len(), size);
        // O grupo viaja resolvido: o Node usa este valor como `groupIndexer`.
        assert_eq!(effect.payload["indexer"], json!("bludv"));
        // A captura registra o que foi visto; nunca reabre o filtro.
        assert_eq!(effect.payload["resetPassedFilter"], json!(false));
        assert_eq!(effect.payload["imdbId"], json!("tt0133093"));
        assert_eq!(effect.payload["season"], Value::Null);
        assert_eq!(effect.payload["episode"], Value::Null);
        assert_eq!(effect.payload["year"], json!("2024"));
    }
    // O último efeito leva o resto do lote — nada é descartado no recorte.
    let ultimo = &effects[2];
    assert_eq!(
        payload_items(ultimo)[49]["infoHash"],
        json!(hash(450)),
        "o recorte preserva a ordem e o item 450 é o último"
    );
}

#[test]
fn grupo_vem_do_indexer_ou_do_tracker() {
    // BLUDV: o cru do Node publica `indexer: None` + `tracker: "BLUDV"`.
    let bludv = item_of(1, None, Some("BLUDV"));
    // Jackett: `indexer` é o id da cota e o tracker é só rótulo de exibição.
    let jackett = item_of(2, Some("RedeTorrent"), Some("Rede Torrent"));
    // Sem os dois: o `inputFromItem` do Node cai em `all`.
    let sem_fonte = item_of(3, None, None);

    let effects = magnet_capture(
        &[bludv, jackett, sem_fonte],
        "tt0903747",
        Some(2),
        Some(3),
        &json!(null),
    );

    let grupos: Vec<&str> = effects
        .iter()
        .map(|effect| effect.payload["indexer"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        grupos,
        vec!["all", "bludv", "redetorrent"],
        "cada fonte vai no seu balde, na ordem do BTreeMap"
    );
    for effect in &effects {
        assert_eq!(effect.payload["season"], json!(2));
        assert_eq!(effect.payload["episode"], json!(3));
        assert_eq!(effect.payload["year"], Value::Null);
    }
    // O `tracker` atravessa no item: é a coluna `tracker` do banco vivo.
    let bludv_effect = effects
        .iter()
        .find(|effect| effect.payload["indexer"] == json!("bludv"))
        .expect("efeito do BLUDV");
    assert_eq!(payload_items(bludv_effect)[0]["tracker"], json!("BLUDV"));
}

#[test]
fn ignora_conta_reserva_sem_hash_e_repetido() {
    let vivo = item_of(1, Some("bludv"), None);
    let mut conta = item_of(2, Some("alldebrid"), None);
    conta.from_account = true;
    let mut reserva = item_of(3, Some("bludv"), None);
    reserva.from_fallback = true;
    let sem_hash = RawItem {
        title: Some("Release sem magnet".into()),
        indexer: Some("bludv".into()),
        ..RawItem::default()
    };
    let repetido = vivo.clone();

    let effects = magnet_capture(
        &[vivo, conta, reserva, sem_hash, repetido],
        "tt0133093",
        None,
        None,
        &json!("2024"),
    );

    assert_eq!(effects.len(), 1, "só o item vivo com hash entra");
    let items = payload_items(&effects[0]);
    assert_eq!(items.len(), 1, "hash repetido não vira duas linhas");
    assert_eq!(items[0]["infoHash"], json!(hash(1)));
    assert_eq!(items[0]["fromAccount"], Value::Null);
    assert_eq!(items[0]["fromFallback"], Value::Null);
}

#[test]
fn sem_item_capturavel_nao_emite_efeito() {
    let mut conta = item_of(1, Some("alldebrid"), None);
    conta.from_account = true;
    let effects = magnet_capture(&[conta], "tt0133093", None, None, &json!(null));
    assert!(effects.is_empty());
}

#[test]
fn lotes_respeitam_o_teto_de_bytes_do_corpo() {
    let effects = magnet_capture(
        &items_of(450, "bludv"),
        "tt0133093",
        None,
        None,
        &json!("2024"),
    );
    // Teto minúsculo: cada efeito vai num POST próprio (a rota nunca recebe
    // dois efeitos que estouram o `limit: '1mb'`).
    let separados = batches_for_transport(effects.clone(), 1);
    assert_eq!(separados.len(), effects.len());
    assert!(separados.iter().all(|batch| batch.len() == 1));

    // Teto generoso: o lote inteiro num POST só.
    let juntos = batches_for_transport(effects.clone(), EFFECTS_BODY_MAX_BYTES);
    assert_eq!(juntos.len(), 1);
    assert_eq!(juntos[0].len(), effects.len());

    // O corpo de cada lote separado cabe no teto que o Node aceita.
    for batch in separados {
        let body = serde_json::to_vec(&batch).expect("json");
        assert!(body.len() < 1024 * 1024);
    }
}
