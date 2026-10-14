use super::*;

// normalize_filter_text

#[test]
fn normalize_filter_text_basico() {
    assert_eq!(normalize_filter_text("Olá Mundo"), "ola mundo");
}

#[test]
fn normalize_filter_text_acentos() {
    assert_eq!(normalize_filter_text("Filme Ação"), "filme acao");
    assert_eq!(normalize_filter_text("Aviação Ñ"), "aviacao n");
}

#[test]
fn normalize_filter_text_nao_alfanumerico() {
    assert_eq!(normalize_filter_text("A-B.C:D"), "a b c d");
}

// matches_resolver_query

#[test]
fn matches_resolver_query_casamento_completo() {
    assert!(matches_resolver_query("Filme Ação 2024", "filme acao"));
}

#[test]
fn matches_resolver_query_casamento_parcial() {
    // 2 de 3 tokens = 66% >= 60%
    assert!(matches_resolver_query("Filme Ação", "filme acao 2024"));
}

#[test]
fn matches_resolver_query_sem_casamento() {
    assert!(!matches_resolver_query(
        "Documentário Natureza",
        "filme acao"
    ));
}

#[test]
fn matches_resolver_query_query_vazia() {
    assert!(matches_resolver_query("Qualquer Título", ""));
}

// is_generic_list_post

#[test]
fn is_generic_list_post_lista_filmes() {
    assert!(is_generic_list_post("Lista de Filmes"));
    assert!(is_generic_list_post("Listão de Séries"));
    assert!(is_generic_list_post("Índice de Desenhos"));
}

#[test]
fn is_generic_list_post_nao_generico() {
    assert!(!is_generic_list_post("A Lista de Schindler"));
    assert!(!is_generic_list_post("Filme Ação 2024"));
}

#[test]
fn is_generic_list_post_vazio() {
    assert!(!is_generic_list_post(""));
}

// pick_button

#[test]
fn pick_button_por_indice() {
    let links = vec![
        "https://example.com/1".to_string(),
        "https://example.com/2".to_string(),
        "https://example.com/3".to_string(),
    ];
    assert_eq!(
        pick_button(&links, 1, None, None),
        Some("https://example.com/2".to_string())
    );
}

#[test]
fn pick_button_indice_fora_da_faixa() {
    let links = vec!["https://example.com/1".to_string()];
    assert_eq!(pick_button(&links, 5, None, None), None);
}

#[test]
fn pick_button_com_count_incompativel() {
    let links = vec!["https://example.com/1".to_string()];
    // hash não encontrado + count incompatível = None
    assert_eq!(pick_button(&links, 0, Some("abc1234567"), Some(5)), None);
}

#[test]
fn pick_button_hash_nao_encontrado_count_compativel() {
    let links = vec!["https://example.com/1".to_string()];
    // hash não encontrado mas count compatível = fallback para índice
    assert_eq!(
        pick_button(&links, 0, Some("abc1234567"), Some(1)),
        Some("https://example.com/1".to_string())
    );
}

#[test]
fn pick_button_com_hash_valido() {
    let links = vec![
        "https://example.com/1".to_string(),
        "https://example.com/2".to_string(),
        "https://example.com/3".to_string(),
    ];
    // Calcula o hash esperado para o segundo link
    let expected_hash = button_id("https://example.com/2");
    // Deve encontrar pelo hash, independente do índice
    assert_eq!(
        pick_button(&links, 99, Some(&expected_hash), None),
        Some("https://example.com/2".to_string())
    );
}

// button_id

#[test]
fn button_id_valor_conhecido() {
    // SHA1 de "https://example.com" = 327c3fda87...
    // Primeiros 10 chars hex = "327c3fda87"
    assert_eq!(button_id("https://example.com"), "327c3fda87");
}

#[test]
fn button_id_url_vazia() {
    // SHA1 de "" = da39a3ee5e6b4b0d3255bfef95601890afd80709
    // Primeiros 10 chars hex = "da39a3ee5e"
    assert_eq!(button_id(""), "da39a3ee5e");
}

#[test]
fn button_id_urls_diferentes_hash_diferente() {
    let hash1 = button_id("https://example.com/1");
    let hash2 = button_id("https://example.com/2");
    assert_ne!(hash1, hash2);
}
