//! Testes do desfecho SEM rede: requeue de falha, teto de tentativas e a
//! finalização da sonda (`found`/`empty`/`failed`/`capped`), inclusive quando
//! ela coalesceu em voo numa execução completa.

use adom_harvest::{
    probe_key, BrProbe, BrProbeRecord, BrProbeState, BrProbeWork, HarvestEntry, HarvestMediaType,
    HarvestQueue, HarvestQueueConfig, HarvestStore, PendingIntent, ProbeConfig,
    DEFAULT_PROBE_TTL_SECONDS, RETRY_MS,
};

use super::{Settlement, Settler};

const NOW: i64 = 1_700_000_000_000;

fn settler() -> Settler {
    Settler::new(DEFAULT_PROBE_TTL_SECONDS)
}

fn entry(imdb: &str, br_probe: bool) -> HarvestEntry {
    HarvestEntry {
        imdb_id: imdb.to_string(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "br-gap".to_string(),
        enqueued_at: NOW,
        priority_at: Some(NOW),
        resumed: false,
        br_probe,
        full_base: false,
        full_intent: None,
    }
}

fn queue() -> HarvestQueue {
    HarvestQueue::new(HarvestQueueConfig::default())
}

fn outcome(is_probe: bool, ok: bool, br_found: bool) -> Settlement {
    Settlement {
        intent: is_probe.then(|| PendingIntent {
            reason: "br-gap".into(),
            br_probe: true,
            priority_at: Some(NOW),
            full: None,
        }),
        ok,
        br_found,
        capped: false,
    }
}

/// O mesmo desfecho, mas com o teto horário tendo cortado alvos planejados.
fn capped(is_probe: bool, ok: bool, br_found: bool) -> Settlement {
    Settlement {
        capped: true,
        ..outcome(is_probe, ok, br_found)
    }
}

/// Sonda operante (interseção não vazia) — a mesma que o loop monta.
fn probe() -> BrProbe {
    BrProbe::new(ProbeConfig {
        index_only_indexers: vec!["br".into()],
        pt_br_indexers: vec!["br".into()],
        ..ProbeConfig::default()
    })
}

/// Estado da sonda gravado no L2, lido pela MESMA chave do `br-probe`.
fn probe_state(store: &HarvestStore, imdb: &str) -> Option<BrProbeState> {
    let work = BrProbeWork::movie(imdb);
    let raw = store.get_value(&probe_key(&work), NOW).ok().flatten()?;
    serde_json::from_str::<BrProbeRecord>(&raw)
        .ok()
        .map(|record| record.state)
}

#[test]
fn sucesso_nao_volta_a_fila() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0111161", false),
        outcome(false, true, false),
        NOW,
    );
    assert_eq!(queue.depth(), 0);
}

#[test]
fn achado_br_finaliza_a_sonda_como_found() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    // A obra falhou na gravação, mas achou BR viável: `found` vence (a sonda
    // prova valor mesmo com a passada cortada).
    settler.settle(
        &mut queue,
        &store,
        entry("tt0111161", true),
        outcome(true, false, true),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0111161"), Some(BrProbeState::Found));
    // Falha ainda reenfileira a obra para a próxima tentativa.
    assert_eq!(queue.depth(), 1);
}

#[test]
fn resposta_sem_achado_finaliza_a_sonda_como_empty() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0903747", true),
        outcome(true, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0903747"), Some(BrProbeState::Empty));
    assert_eq!(queue.depth(), 0);
}

#[test]
fn falha_finaliza_failed_e_sai_da_fila_apos_o_teto() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    // Três falhas devolvem a obra ao fim da fila (mesmo teto do TS).
    for round in 1..=3 {
        settler.settle(
            &mut queue,
            &store,
            entry("tt0068646", true),
            outcome(true, false, false),
            NOW,
        );
        assert_eq!(queue.depth(), 1, "rodada {round} deveria reenfileirar");
        queue.take_head();
    }
    assert_eq!(probe_state(&store, "tt0068646"), Some(BrProbeState::Failed));

    // A quarta falha tira a obra da fila: a obra cara não a monopoliza.
    settler.settle(
        &mut queue,
        &store,
        entry("tt0068646", true),
        outcome(true, false, false),
        NOW,
    );
    assert_eq!(queue.depth(), 0);
}

#[test]
fn sucesso_zera_o_contador_de_tentativas() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0108052", false),
        outcome(false, false, false),
        NOW,
    );
    settler.settle(
        &mut queue,
        &store,
        entry("tt0108052", false),
        outcome(false, false, false),
        NOW,
    );
    assert_eq!(queue.depth(), 1);
    queue.clear();
    // Sucesso no meio zera as duas falhas anteriores.
    settler.settle(
        &mut queue,
        &store,
        entry("tt0108052", false),
        outcome(false, true, false),
        NOW,
    );
    for round in 1..=3 {
        settler.settle(
            &mut queue,
            &store,
            entry("tt0108052", false),
            outcome(false, false, false),
            NOW,
        );
        assert_eq!(queue.depth(), 1, "rodada {round} deveria reenfileirar");
        queue.take_head();
    }
}

#[test]
fn sonda_coalescida_finaliza_mesmo_com_entrada_completa() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    // Entrada base FULL (`br_probe:false`) com sonda anexada em voo: o
    // `is_probe` efetivo é o que decide a finalização.
    settler.settle(
        &mut queue,
        &store,
        entry("tt0133093", false),
        outcome(true, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0133093"), Some(BrProbeState::Empty));

    // Sem intenção de sonda, nada é gravado (não inventa estado).
    settler.settle(
        &mut queue,
        &store,
        entry("tt0133094", false),
        outcome(false, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0133094"), None);
}

/// A chave do estado final é LITERALMENTE a do `br-probe`/`adom-napi`:
/// `autofetch:v3:probe:<sha256("<tipo>:<imdb>:<temporada>:<episódio>")>`. Fixar
/// o hex aqui (em vez de chamar `probe_key`) é o que dói: se um lado só mudar a
/// fórmula, a sonda nunca "settla" e nenhum outro teste falha.
#[test]
fn estado_final_grava_na_chave_literal_do_probe() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0111161", true),
        outcome(true, true, true),
        NOW,
    );

    // sha256("movie:tt0111161::") — a identidade do TS (`probeIdentity`) e do
    // napi (`probe_key`).
    let key = concat!(
        "autofetch:v3:probe:",
        "c3447c9e2b100e3ee7a48ea4b7def8df76590dea8ef1417c812c814598d12088"
    );
    let raw = store
        .get_value(key, NOW)
        .unwrap()
        .expect("registro na chave da sonda");
    let record: BrProbeRecord = serde_json::from_str(&raw).unwrap();
    assert_eq!(record.state, BrProbeState::Found);
    assert_eq!(record.lease_until, None, "estado final não carrega lease");
}

/// `Settler::new(ttl)` é o que o loop alimenta com `BR_PROBE_TTL_S`: o registro
/// final morre no TTL configurado, não na constante do crate.
#[test]
fn estado_final_respeita_o_ttl_do_settler() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = Settler::new(7_200);

    settler.settle(
        &mut queue,
        &store,
        entry("tt0903747", true),
        outcome(true, true, false),
        NOW,
    );

    let key = probe_key(&BrProbeWork::movie("tt0903747"));
    assert!(store.get_value(&key, NOW + 7_199_000).unwrap().is_some());
    assert!(store.get_value(&key, NOW + 7_200_000).unwrap().is_none());
}

/// O patch que dói: sonda cortada pelo teto NÃO é `empty`.
///
/// `empty` afirma "procurei e não há" e sobrevive 12 h no painel; uma passada
/// truncada não provou isso. `capped` mantém o estado honesto E deixa o retry
/// curto alcançável — com `empty` a obra nunca mais seria sondada.
#[test]
fn sonda_truncada_grava_capped_e_libera_o_retry_curto() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();
    let probe = probe();
    let work = BrProbeWork::movie("tt0111161");

    // Zero achado, mas o teto deixou alvos sem consulta.
    settler.settle(
        &mut queue,
        &store,
        entry("tt0111161", true),
        capped(true, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0111161"), Some(BrProbeState::Capped));

    // Antes dos 5 min o retry não martela a fila…
    let early = probe
        .request(&store, &mut queue, &work, NOW + RETRY_MS - 1)
        .unwrap();
    assert_eq!(early.skipped, Some("retry"));

    // …depois dele a nova tentativa é possível (é o que `empty` bloqueia).
    let late = probe
        .request(&store, &mut queue, &work, NOW + RETRY_MS)
        .unwrap();
    assert!(
        late.probe,
        "sonda truncada precisa poder recomecar: {late:?}"
    );
    assert!(queue.find_queued("tt0111161", None, None).is_some());
}

/// Contraste do teste acima: sem corte, a resposta é CONCLUSIVA e `empty`
/// segue valendo — nem retry curto, nem nova sonda.
#[test]
fn sonda_sem_truncamento_continua_empty_sem_retry() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();
    let probe = probe();
    let work = BrProbeWork::movie("tt0903747");

    settler.settle(
        &mut queue,
        &store,
        entry("tt0903747", true),
        outcome(true, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0903747"), Some(BrProbeState::Empty));

    let later = probe
        .request(&store, &mut queue, &work, NOW + RETRY_MS)
        .unwrap();
    assert_eq!(later.skipped, Some("empty"));
    assert!(!later.probe);
}

/// `Found` NUNCA fica depois de `Capped`: achado real é prova, mesmo com a
/// passada cortada (o item saiu antes do teto).
#[test]
fn achado_real_vence_o_corte() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0111161", true),
        capped(true, false, true),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0111161"), Some(BrProbeState::Found));
    // Achado não tira a obra da fila por falha: o retry continua valendo.
    assert_eq!(queue.depth(), 1);
}
