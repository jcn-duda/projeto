//! Pedido de lista de arquivos na checagem: só magnet PRONTO e PEDIDO entra em
//! `files_to_read`, respeitando o teto. Usa o mesmo mock de lote dos testes
//! vizinhos (`super::*` alcança os helpers privados de `alldebrid_check_tests`).

use super::*;

fn with_files(files: &[String], max: usize) -> super::super::CheckOpts {
    super::super::CheckOpts {
        file_hashes: files.iter().cloned().collect(),
        pack_files_max: max,
        ..opts(25, 5_000)
    }
}

#[tokio::test]
async fn pronto_e_pedido_entra_com_o_id_do_magnet() {
    let (ad, _scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    let asked = hashes(4, 'f');
    let pedidos = vec![asked[0].clone(), asked[1].clone()];
    let report = ad
        .check_cached_report(API_KEY, &asked, &with_files(&pedidos, 6))
        .await
        .unwrap();
    let hashes_lidos: Vec<&str> = report
        .files_to_read
        .iter()
        .map(|(h, _)| h.as_str())
        .collect();
    assert_eq!(hashes_lidos, vec![asked[0].as_str(), asked[1].as_str()]);
    // O id é o do magnet no upload (não vazio, e distinto por magnet).
    let (_, id0) = &report.files_to_read[0];
    let (_, id1) = &report.files_to_read[1];
    assert!(!id0.is_empty() && id0 != "0");
    assert_ne!(id0, id1);
    // Nada apagado: a leitura não mexe na conta.
    assert_eq!(report.deleted, Vec::<String>::new());
}

#[tokio::test]
async fn nao_pronto_ou_nao_pedido_fica_fora_da_leitura() {
    // Só `a` está pronto; `b` é pedido mas frio, e `c` está pronto sem ser pedido.
    let (ad, _scene) = open_scene(Behavior::ReadySet('a'), Duration::ZERO).await;
    let asked = vec![hash_of('a'), hash_of('b'), hash_of('c')];
    let pedidos = vec![hash_of('a'), hash_of('b')];
    let report = ad
        .check_cached_report(API_KEY, &asked, &with_files(&pedidos, 6))
        .await
        .unwrap();
    let hashes_lidos: Vec<String> = report
        .files_to_read
        .iter()
        .map(|(h, _)| h.clone())
        .collect();
    assert_eq!(hashes_lidos, vec![hash_of('a')]);
}

#[tokio::test]
async fn teto_corta_na_ordem_do_input() {
    let (ad, _scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    let asked = hashes(5, 'e');
    let report = ad
        .check_cached_report(API_KEY, &asked, &with_files(&asked, 2))
        .await
        .unwrap();
    assert_eq!(report.files_to_read.len(), 2);
    assert_eq!(report.files_to_read[0].0, asked[0]);
    assert_eq!(report.files_to_read[1].0, asked[1]);
    // Cortar a leitura não vira veredito: o ⚡ de todos continua.
    assert_eq!(report.cached.len(), 5);
}

#[tokio::test]
async fn teto_zero_desliga_a_leitura() {
    let (ad, _scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    let asked = hashes(3, 'g');
    let report = ad
        .check_cached_report(API_KEY, &asked, &with_files(&asked, 0))
        .await
        .unwrap();
    assert!(report.files_to_read.is_empty());
}

#[tokio::test]
async fn sem_pedido_nenhum_magnet_e_lido() {
    let (ad, _scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    let asked = hashes(2, 'h');
    let report = ad
        .check_cached(API_KEY, &asked, &opts(25, 5_000))
        .await
        .unwrap();
    assert!(report.files_to_read.is_empty());
}
