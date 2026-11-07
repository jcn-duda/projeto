use super::*;

#[test]
fn conteudo_vira_lista_sem_vazio_nem_zero() {
    let files = vec![
        ContentFile {
            path: "Colecao/Star Trek III 1984.mkv".into(),
            size: 1_700_000_000,
            link: "https://x/1".into(),
        },
        ContentFile {
            path: String::new(),
            size: 10,
            link: String::new(),
        },
        ContentFile {
            path: "Colecao/leia.txt".into(),
            size: 0,
            link: String::new(),
        },
    ];
    let out = content_to_debrid(files);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].path, "Colecao/Star Trek III 1984.mkv");
    assert_eq!(out[0].size, 1_700_000_000.0);
}

#[test]
fn sem_pedido_ou_fora_do_cache_nao_agenda_nem_trava() {
    let client = HttpClient::new().expect("cliente");
    let cached = vec!["aaa".to_string()];
    // Nada pedido: não entra em voo.
    spawn_reads(client.clone(), "k", &cached, &[], None);
    // Pedido fora do cache: idem (e sem runtime, nada é agendado).
    spawn_reads(client, "k", &cached, &["bbb".to_string()], None);
    assert!(IN_FLIGHT.lock().unwrap().is_empty());
}
