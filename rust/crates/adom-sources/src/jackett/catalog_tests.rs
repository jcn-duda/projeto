//! Testes do catálogo — fixtures adaptados de `test/jackett-catalog.test.ts`.
//! Sem rede: o fetch só tem ramos live/erro exercitáveis com rede (o ramo
//! "sem api_key → fallback" é síncrono e não vai à rede).

use reqwest::Client;

use super::*;

fn pt_br(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_string()).collect()
}

#[test]
fn parse_le_catalogo_torznab_sem_expor_campos_extras() {
    let xml = r#"
    <indexers>
      <indexer id="comandotorrents" configured="true">
        <title>Comando &amp; Torrents</title>
        <language>pt-BR</language>
        <link>https://segredo.invalid</link>
      </indexer>
      <indexer id="1337x" configured="true">
        <title>1337x</title>
        <language>en-US</language>
      </indexer>
    </indexers>"#;
    let out = parse_indexers_xml(xml, &pt_br(&["comandotorrents", "hdrtorrent-cardigann"]));
    assert_eq!(
        out,
        vec![
            CatalogCard {
                id: "comandotorrents".to_string(),
                label: "Comando & Torrents".to_string(),
                language: "pt-BR".to_string(),
                is_br: true,
            },
            CatalogCard {
                id: "1337x".to_string(),
                label: "1337x".to_string(),
                language: "en-US".to_string(),
                is_br: false,
            },
        ]
    );
}

#[test]
fn decodifica_entidades_em_atributos_do_catalogo() {
    let xml = r#"<indexers>
      <indexer id="filmes" name="HD &amp; Filmes &#8211; &quot;Oficial&quot;" language="pt-BR"></indexer>
    </indexers>"#;
    let out = parse_indexers_xml(xml, &pt_br(&["comandotorrents"]));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].label, "HD & Filmes – \"Oficial\"");
}

#[test]
fn preserva_entidade_invalida_e_nao_decodifica_duas_vezes() {
    let xml = r#"<indexers>
      <indexer id="seguro" name="A &#x2FFFFD; &#38;amp; B&nbsp;C"></indexer>
    </indexers>"#;
    let out = parse_indexers_xml(xml, &pt_br(&[]));
    assert_eq!(out[0].label, "A &#x2FFFFD; &amp; B C");
}

#[test]
fn ignora_id_inseguro() {
    let out = parse_indexers_xml(
        r#"<indexers><indexer id="../../env"><title>X</title></indexer></indexers>"#,
        &pt_br(&[]),
    );
    assert_eq!(out.len(), 0);
    // Id longo demais (teto de 64 do safeId) também sai.
    let longo = "a".repeat(65);
    let xml = format!(r#"<indexers><indexer id="{longo}"><title>X</title></indexer></indexers>"#);
    assert_eq!(parse_indexers_xml(&xml, &pt_br(&[])).len(), 0);
}

#[test]
fn is_br_vem_da_lista_informada_e_aceita_torznab_indexer() {
    let xml = r#"<indexers>
      <torznab:indexer id="hdrtorrent-cardigann" configured="true">
        <title>HDR Torrents</title>
      </torznab:indexer>
      <indexer id="limetorrents" languages="en-US" name="LimeTorrents"></indexer>
      <indexer id="comandotorrents"><language>pt-BR</language></indexer>
    </indexers>"#;
    let out = parse_indexers_xml(xml, &pt_br(&["comandotorrents", "hdrtorrent-cardigann"]));
    assert_eq!(out.len(), 3);
    assert!(out[0].is_br, "id na lista BR é BR mesmo com cardigann");
    assert_eq!(
        out[0].label, "HDR Torrents",
        "rótulo vivo é o name do Jackett"
    );
    assert!(!out[1].is_br);
    assert_eq!(out[1].language, "en-US", "attr `languages` também serve");
    assert!(out[2].is_br);
    assert_eq!(
        out[2].language, "pt-BR",
        "language pode vir de ELEMENTO quando não há attr"
    );
}

#[test]
fn label_cai_para_id_quando_nao_ha_name_nem_title() {
    let xml = r#"<indexers><indexer id="meu_indexer"></indexer></indexers>"#;
    let out = parse_indexers_xml(xml, &pt_br(&[]));
    // O TS usa o `id` (JÁ lowercased) como último recurso do rótulo vivo —
    // quem capitaliza é só o `labelFor` do fallback.
    assert_eq!(out[0].label, "meu_indexer");
}

#[test]
fn label_for_agrupa_separadores_e_capitaliza() {
    // Caminho do fallback (`labelFor`): `[-_]+` vira UM espaço e a primeira
    // letra de cada palavra sobe.
    let out = fallback_catalog(
        &[
            "meu_indexer".to_string(),
            "hdrtorrent-cardigann".to_string(),
        ],
        &[],
        &[],
    );
    assert_eq!(out[0].label, "Meu Indexer");
    assert_eq!(out[1].label, "Hdrtorrent");
}

#[test]
fn fallback_deduplica_e_rotula_a_partir_do_id() {
    let indexers = vec!["yts".to_string(), "hdrtorrent-cardigann".to_string()];
    let pt_br_list = pt_br(&["hdrtorrent-cardigann", "comandotorrents"]);
    let slow = vec!["hdrtorrent-cardigann".to_string(), "yts".to_string()];
    let out = fallback_catalog(&indexers, &pt_br_list, &slow);
    // Dedupe preserva a PRIMEIRA ocorrência, na ordem da união.
    let ids: Vec<&str> = out.iter().map(|card| card.id.as_str()).collect();
    assert_eq!(ids, vec!["yts", "hdrtorrent-cardigann", "comandotorrents"]);
    assert!(!out[0].is_br);
    assert_eq!(out[0].language, "");
    // O rótulo do fallback nasce do id, e `-cardigann` é detalhe do card local:
    // o usuário lê "Hdrtorrent", não "Hdrtorrent Cardigann". O ID permanece.
    assert_eq!(out[1].label, "Hdrtorrent");
    assert!(out[1].is_br);
    assert_eq!(out[1].language, "pt-BR");
    assert!(out.iter().all(|card| is_safe_indexer_id(&card.id)));
}

#[test]
fn fallback_descarta_id_inseguro() {
    let out = fallback_catalog(&["../../env".to_string()], &[], &[]);
    assert_eq!(out.len(), 0);
}

#[tokio::test]
async fn sem_api_key_vai_direto_ao_fallback_sem_rede() {
    // O `load` do TS: sem chave NEM chega a fetch — ids do .env não são medição.
    let config = JackettConfig {
        api_key: String::new(),
        ..JackettConfig::default()
    };
    let http = Client::builder().build().expect("cliente HTTP de teste");
    let snapshot = load_catalog(&http, &config).await;
    assert_eq!(snapshot.source, CatalogSource::Fallback);
    assert!(
        !snapshot.cards.is_empty(),
        "fallback ainda traz ids do default"
    );
    assert!(
        snapshot
            .cards
            .iter()
            .any(|card| card.is_br && card.language == "pt-BR"),
        "is_br/language do default vêm da lista pt-BR"
    );
}

#[test]
fn serializa_como_o_painel_le_o_ts() {
    // Contrato de wire: camelCase no card, origem em minúsculas.
    let snapshot = CatalogSnapshot {
        cards: vec![CatalogCard {
            id: "yts".to_string(),
            label: "YTS".to_string(),
            language: String::new(),
            is_br: false,
        }],
        source: CatalogSource::Live,
    };
    let json = serde_json::to_value(&snapshot).expect("serializar snapshot");
    assert_eq!(
        json,
        serde_json::json!({
            "cards": [{ "id": "yts", "label": "YTS", "language": "", "isBr": false }],
            "source": "live",
        })
    );
}
