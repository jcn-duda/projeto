//! As REGRAS da F6 lidas do KV, no passo (`evict_job::run`), e não só na régua
//! pura (`evict_step`) — porte dos seis cenários de POLÍTICA de
//! `test/autofetch-evict.test.ts` (leva B4).
//!
//! Por que no PASSO e não só no golden: `evict_step::plan` já tem 29 casos de
//! contrato e as duas réguas puras têm testes próprios. O que nenhum deles toca
//! é a TRADUÇÃO KV → `EvictItem` — `entries[].pool`/`overflow`/`acceptedAt`,
//! `adsub`/`adrm`/`adhold`/`adprot`, marker com `obra`, `er:` anterior e a prova
//! `pool == "br" && dubbed`. Um erro de fiação ali (chave trocada, campo que não
//! chega) desarma o gate em silêncio e o `plan` continua verde: é exatamente o
//! furo que o teste de política do TS cobria e que o corte do Node não podia
//! levar embora.
//!
//! Nenhum teste toca rede nem env: as réguas entram como [`EvictConfig`] e o
//! debrid como [`StubIo`] (herdados do módulo pai).

use adom_autofetch::v3::EvictOutcome;

use super::*;

/// Fallback do pool `seeds` (o TS cobria os dois pools no mesmo caso).
const F_SEEDS: &str = "fall00003";
/// Irmão de pool `br` da MESMA obra: nunca sai.
const F_BR: &str = "fall00004";
const F_LEGADO: &str = "fall00005";
const F_SEM_MARKER: &str = "fall00006";
const F_DIGEST_ALHEIO: &str = "fall00007";
const F_SEM_POSSE: &str = "fall00008";
const F_PRESO: &str = "fall00009";
const F_PROTEGIDO: &str = "fall0000a";
const F_JOVEM: &str = "fall0000b";
const F_SEM_DATA: &str = "fall0000c";

/// Igual a [`entry`], com a marca de RESERVA de overflow do C11 explícita.
fn com_overflow(hash: &str, pool: &str, accepted_at: i64) -> serde_json::Value {
    let mut value = entry(hash, pool, false, accepted_at);
    value["overflow"] = json!(true);
    value
}

/// Marker da obra + posse durável para cada hash: o cenário neutro dos casos
/// abaixo (o defeito entra por cima).
fn prova(kv: &NativeKv, hashes: &[&str]) {
    for hash in hashes {
        marker(kv, hash, Some(DIGEST));
        adsub(kv, hash);
    }
}

/// Só a posse durável (`adsub`), sem tocar no marker: nos casos em que o DEFEITO
/// é o marker (legado/ausente/digest alheio), [`prova`] o apagaria.
fn posse(kv: &NativeKv, hashes: &[&str]) {
    for hash in hashes {
        adsub(kv, hash);
    }
}

/// Regra 2 (`autofetch-evict.test.ts:57`): só `any`/`seeds` da MESMA obra vão à
/// conta — o irmão `br` da mesma obra fica, e cada removido ganha o `adrm`.
#[tokio::test]
async fn so_any_e_seeds_da_obra_saem_e_o_br_irmao_fica() {
    let kv = kv();
    put_record(
        &kv,
        vec![
            entry(READY, "br", true, NOW - 7_200_000),
            entry(FALLBACK, "any", false, NOW - 3_600_000),
            entry(F_SEEDS, "seeds", false, NOW - 3_600_000),
            entry(F_BR, "br", true, NOW - 7_200_000),
        ],
    );
    prova(&kv, &[READY, FALLBACK, F_SEEDS, F_BR]);
    let io = StubIo::new(vec![done(&[FALLBACK, F_SEEDS])]);
    let ready = vec![READY.to_string()];

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 2, "any + seeds da obra");
    assert_eq!(report.removed, 2);
    assert_eq!(report.marked, 2, "cada removido confirmado ganha `adrm`");
    assert_eq!(
        report.skips.get("evict-pool-br"),
        Some(&2),
        "os DOIS `br` do registro (o ready e o irmão) nunca entram"
    );
    assert_eq!(
        io.calls(),
        vec![vec![FALLBACK.to_string(), F_SEEDS.to_string()]],
        "só os dois fallbacks da obra são pedidos à conta"
    );
}

/// Regra 3 (`autofetch-evict.test.ts:103`): a vaga de OVERFLOW do C11 é reserva
/// deliberada de upgrade — não sai, não é marcada, e o fallback comum sai.
#[tokio::test]
async fn reserva_de_overflow_do_c11_nao_sai() {
    let kv = kv();
    put_record(
        &kv,
        vec![
            entry(READY, "br", true, NOW - 7_200_000),
            com_overflow(F_SEEDS, "seeds", NOW - 3_600_000),
            entry(FALLBACK, "any", false, NOW - 3_600_000),
        ],
    );
    prova(&kv, &[READY, F_SEEDS, FALLBACK]);
    let io = StubIo::new(vec![done(&[FALLBACK])]);
    let ready = vec![READY.to_string()];

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 1, "só o fallback comum é pedido");
    assert_eq!(report.skips.get("evict-overflow"), Some(&1));
    assert_eq!(io.calls(), vec![vec![FALLBACK.to_string()]]);
    assert!(
        kv.get_json(&adrm_key(ACCOUNT, F_SEEDS), NOW)
            .unwrap()
            .is_none(),
        "o overflow nem é marcado: ele fica na conta e na obra"
    );
}

/// Regra 4 (`autofetch-evict.test.ts:137`): marker legado, marker ausente,
/// digest de OUTRA obra e falta de `adsub` barram — nada sai.
#[tokio::test]
async fn marker_legado_ausente_digest_alheio_e_sem_adsub_barram() {
    let kv = kv();
    put_record(
        &kv,
        vec![
            entry(READY, "br", true, NOW - 7_200_000),
            entry(F_LEGADO, "seeds", false, NOW - 3_600_000),
            entry(F_SEM_MARKER, "seeds", false, NOW - 3_600_000),
            entry(F_DIGEST_ALHEIO, "any", false, NOW - 3_600_000),
            entry(F_SEM_POSSE, "any", false, NOW - 3_600_000),
        ],
    );
    marker(&kv, READY, Some(DIGEST));
    // Legado: `{id}` sem `obra` — inelegível por contrato.
    marker(&kv, F_LEGADO, None);
    // F_SEM_MARKER: nenhuma chave gravada.
    let outra_obra = "f".repeat(64);
    marker(&kv, F_DIGEST_ALHEIO, Some(outra_obra.as_str()));
    marker(&kv, F_SEM_POSSE, Some(DIGEST));
    // Posse nos três que têm marker (o defeito deles é o marker): o quarto cai
    // por falta de `adsub`.
    posse(&kv, &[F_LEGADO, F_SEM_MARKER, F_DIGEST_ALHEIO]);
    let io = StubIo::new(Vec::new());
    let ready = vec![READY.to_string()];

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 0, "nada é pedido à conta");
    assert_eq!(
        report.skips.get("evict-other-work"),
        Some(&3),
        "legado + ausente + digest de outra obra"
    );
    assert_eq!(
        report.skips.get("evict-no-ownership"),
        Some(&1),
        "sem `adsub`"
    );
    assert!(io.calls().is_empty(), "hash barrado não vira delete");
    assert!(report.errors.is_empty(), "ausência de prova não é erro");
}

/// Regra 5 (`autofetch-evict.test.ts:171`): `adhold` volátil e `adprot` durável
/// barram. São DUAS chaves distintas — trocar uma pela outra desarmaria a outra.
#[tokio::test]
async fn hold_volatil_e_adprot_duravel_barram() {
    let kv = kv();
    put_record(
        &kv,
        vec![
            entry(READY, "br", true, NOW - 7_200_000),
            entry(F_PRESO, "seeds", false, NOW - 3_600_000),
            entry(F_PROTEGIDO, "seeds", false, NOW - 3_600_000),
        ],
    );
    prova(&kv, &[READY, F_PRESO, F_PROTEGIDO]);
    kv.put_json(
        &adhold_key(ACCOUNT, F_PRESO),
        &json!({ "at": NOW }),
        600,
        NOW,
    )
    .expect("adhold");
    kv.put_json(
        &adprot_key(ACCOUNT, F_PROTEGIDO),
        &json!({ "at": NOW }),
        86_400,
        NOW,
    )
    .expect("adprot");
    let io = StubIo::new(Vec::new());
    let ready = vec![READY.to_string()];

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 0);
    assert_eq!(report.skips.get("evict-held"), Some(&1), "hold volátil");
    assert_eq!(
        report.skips.get("evict-protected"),
        Some(&1),
        "`adprot` durável"
    );
    assert!(io.calls().is_empty());
}

/// Regra 6 (`autofetch-evict.test.ts:198`): idade mínima desde o `acceptedAt` do
/// registro F2 e a AUSÊNCIA de data (`acceptedAt` 0) barram — `0` não é "muito
/// antigo", é "sem data".
#[tokio::test]
async fn idade_minima_e_ausencia_de_data_barram() {
    let kv = kv();
    put_record(
        &kv,
        vec![
            entry(READY, "br", true, NOW - 7_200_000),
            entry(F_JOVEM, "seeds", false, NOW - 60_000),
            entry(F_SEM_DATA, "any", false, 0),
        ],
    );
    prova(&kv, &[READY, F_JOVEM, F_SEM_DATA]);
    let io = StubIo::new(Vec::new());
    let ready = vec![READY.to_string()];

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 0, "jovem e sem data ficam");
    assert_eq!(report.skips.get("evict-too-young"), Some(&1));
    assert_eq!(report.skips.get("evict-no-accepted-at"), Some(&1));
    assert!(io.calls().is_empty());
}

/// Regra 7 (`autofetch-evict.test.ts:224`): ready sem prova `br`+`dubbed` no
/// registro é no-op — a conta nem é lida e a evidência `er:` NÃO nasce (ela é do
/// EVENTO, não do "está ready").
#[tokio::test]
async fn ready_sem_prova_br_dubbed_nao_autoriza_nem_grava_er() {
    let kv = kv();
    put_record(
        &kv,
        vec![
            entry(READY, "seeds", false, NOW - 3_600_000),
            entry(FALLBACK, "any", false, NOW - 3_600_000),
        ],
    );
    prova(&kv, &[READY, FALLBACK]);
    let io = StubIo::new(Vec::new());
    let ready = vec![READY.to_string()];

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 0);
    assert_eq!(report.skips.get("evict-no-br-proof"), Some(&1));
    assert!(
        io.calls().is_empty(),
        "sem prova de BR ready, zero leitura da conta"
    );
    assert!(
        kv.get_json(&br_ready_key(DIGEST), NOW).unwrap().is_none(),
        "`er:` só nasce de ready comprovadamente `br`+`dubbed`"
    );
}

/// O outro lado da regra 7: a obra que JÁ provou BR ready (`er:` viva) autoriza
/// o fallback que ficou pronto depois — é o `hasBrReady` do TS, cuja única
/// cobertura restante no Node é o painel.
#[tokio::test]
async fn br_ready_anterior_autoriza_o_fallback_que_ficou_pronto_depois() {
    let kv = kv();
    put_record(
        &kv,
        vec![
            entry(READY, "seeds", false, NOW - 3_600_000),
            entry(FALLBACK, "any", false, NOW - 3_600_000),
        ],
    );
    prova(&kv, &[READY, FALLBACK]);
    kv.put_json(
        &br_ready_key(DIGEST),
        &json!({ "at": NOW - 7_200_000 }),
        21_600,
        NOW,
    )
    .expect("er:");
    let io = StubIo::new(vec![done(&[READY, FALLBACK])]);
    let ready = vec![READY.to_string()];

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    // O ready ATUAL não é `br`: ele é o fallback que ficou pronto, e por isso é
    // candidato junto (`autofetch-evict.ts:200`). Os dois da obra saem.
    assert_eq!(report.requested, 2, "a prova anterior abre o gate");
    assert_eq!(report.removed, 2);
    assert_eq!(
        io.calls(),
        vec![vec![READY.to_string(), FALLBACK.to_string()]]
    );
    assert_eq!(report.skips.get("evict-no-br-proof"), None);
}

/// Tira (`present:false`) ou repõe (`true`) UM dos fatos do Node na cena.
fn fact(kv: &NativeKv, name: &str, present: bool) {
    match (name, present) {
        ("ready-marker", true) => marker(kv, READY, Some(DIGEST)),
        ("ready-marker", false) => marker(kv, READY, None),
        ("obra-marker", true) => marker(kv, FALLBACK, Some(DIGEST)),
        ("obra-marker", false) => marker(kv, FALLBACK, None),
        ("registro-f2", true) => record(kv),
        ("registro-f2", false) => forget_key(kv, &format!("{}{DIGEST}", obra_prefix())),
        (_, true) => adsub(kv, FALLBACK),
        (_, false) => forget_key(kv, &adsub_key(ACCOUNT, FALLBACK)),
    }
}

fn forget_key(kv: &NativeKv, key: &str) {
    kv.forget(key).expect("forget no KV");
}

/// (e) Um FATO do Node por vez: sem ele NADA é apagado e o motivo é o daquele
/// fato; reposto, o gate abre. Os três juntos já são o caso do arquivo pai.
#[tokio::test]
async fn cada_fato_e_necessario_e_suficiente() {
    for (fato, motivo) in [
        ("ready-marker", "evict-no-marker"),
        ("obra-marker", "evict-other-work"),
        ("registro-f2", "evict-no-record"),
        ("posse-adsub", "evict-no-ownership"),
    ] {
        let kv = kv();
        let ready = completo(&kv);
        fact(&kv, fato, false);
        let io = StubIo::new(Vec::new());
        let report = run(&kv, &io, &work(&ready), &config(), NOW).await;
        assert_eq!((report.requested, report.removed), (0, 0), "{fato} ausente");
        assert_eq!(report.skips.get(motivo), Some(&1), "{fato}: motivo");
        assert!(report.errors.is_empty(), "{fato}: ausência não é erro");
        assert!(io.calls().is_empty(), "{fato}: nenhuma ida à conta");

        fact(&kv, fato, true);
        let io = StubIo::new(vec![done(&[FALLBACK])]);
        let report = run(&kv, &io, &work(&ready), &config(), NOW).await;
        assert_eq!(report.requested, 1, "{fato} reposto: o gate abre");
    }
}

/// `evict` roteirizado que a PORTA vetou: nada removido, motivo CONTADO.
fn vetoed(reason: &str, count: usize) -> Result<EvictOutcome, String> {
    let mut outcome = EvictOutcome::default();
    outcome.vetoed.insert(reason.to_string(), count);
    Ok(outcome)
}

/// `readded` provado pela PORTA (upload do usuário depois do nosso carimbo):
/// o veto continua BARRANDO a remoção e agora o painel VÊ o motivo.
#[tokio::test]
async fn readded_barra_a_remocao_e_aparece_no_relatorio() {
    let kv = kv();
    let ready = completo(&kv);
    let io = StubIo::new(vec![vetoed("readded", 1)]);

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 1, "o plano autorizou o fallback");
    assert_eq!(report.removed, 0, "`readded` continua barrando a remoção");
    assert_eq!(report.marked, 0, "sem remoção não nasce `adrm`");
    assert_eq!(
        report.skips.get("evict-readded"),
        Some(&1),
        "o motivo tem de chegar ao painel: {:?}",
        report.skips
    );
    assert_eq!(io.calls().len(), 1, "a porta foi consultada uma vez");
}

/// Sem veto da porta o rótulo nem existe (`None`, não um `0` disfarçado).
#[tokio::test]
async fn sem_readded_o_contador_fica_zerado() {
    let kv = kv();
    let ready = completo(&kv);
    let io = StubIo::new(vec![done(&[FALLBACK])]);

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.removed, 1, "a prova completa remove");
    assert_eq!(report.skips.get("evict-readded"), None);
}
