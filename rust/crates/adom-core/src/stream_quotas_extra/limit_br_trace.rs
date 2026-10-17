//! Reserva BR do corte final COM observabilidade: [`limit_reserving_br_trace`].
//!
//! Submódulo de [`super`](crate::stream_quotas_extra) pela catraca de 400 linhas.
//! A seleção é a mesma de `limitReservingBr` do TS; a diferença é que os cortes
//! e as trocas voltam como índice + motivo, na ORDEM em que o `dropTrace` do TS
//! os emitiria: `quality-quota`/`indexer-limit` na visita à lista reordenada
//! `[...priority, ...resto]`, depois `br-guarantee-replaced` na ordem do
//! `encaixa`. O `max-results` NÃO entra aqui — é o diff
//! `eligible − selected − replaced` na ordem original, que o chamador calcula
//! (o núcleo não repete uma varredura que a casca faz de graça).
//!
//! Os índices devolvidos são sempre os ORIGINAIS de `streams`, não posições da
//! lista reordenada: a casca TS mapeia direto para os objetos que recebeu.

use std::collections::{HashMap, HashSet};

use crate::stream_quotas::clamp_limit;

use super::selection::LimitBrOpts;
use super::{
    is_season_pack_release, limit_by_quality_and_indexer_trace, stream_quality, QuotaDrop,
    StreamRef, QUALITY_KEYS,
};

/// Resultado do corte final: a lista entregue (ordem de exibição), os elegíveis
/// (ordem original), os globais trocados por vaga garantida BR e os cortes com
/// motivo — estes últimos sem o `max-results`, que é calculado pelo chamador.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct LimitReservingBrTrace {
    pub selected: Vec<usize>,
    pub eligible: Vec<usize>,
    pub replaced: Vec<usize>,
    pub dropped: Vec<QuotaDrop>,
}

/// `(s._dubbed ? 2 : 0) + (s._dubClaim ? 1 : 0)` — prova primeiro, claim depois.
fn dub_rank(s: &StreamRef) -> u8 {
    (if s.is_dubbed { 2 } else { 0 }) + (if s.is_dub_claim { 1 } else { 0 })
}

/// `[...v].sort((a, b) => dubRank(b) - dubRank(a))`: estável, como o sort do JS
/// (empate preserva a ordem de entrada).
fn sort_by_dub_rank(streams: &[StreamRef], order: &mut [usize]) {
    order.sort_by(|&a, &b| dub_rank(&streams[b]).cmp(&dub_rank(&streams[a])));
}

/// `encaixaGarantida`: a garantia fura a ORDEM, não o teto — entra no fim ou
/// troca o último GLOBAL da lista. Cada troca vira `br-guarantee-replaced`.
fn encaixa(
    streams: &[StreamRef],
    selected: &mut Vec<usize>,
    garantidas: &[usize],
    max_results: usize,
    replaced: &mut Vec<usize>,
    dropped: &mut Vec<QuotaDrop>,
) {
    let mut dentro: HashSet<usize> = selected.iter().copied().collect();
    for &g in garantidas {
        if dentro.contains(&g) {
            continue;
        }
        if selected.len() < max_results {
            selected.push(g);
            dentro.insert(g);
            continue;
        }
        let Some(pos) = selected.iter().rposition(|&s| !streams[s].is_br) else {
            break;
        };
        let fora = selected[pos];
        dentro.remove(&fora);
        replaced.push(fora);
        dropped.push(QuotaDrop {
            index: fora,
            reason: "br-guarantee-replaced",
        });
        selected[pos] = g;
        dentro.insert(g);
    }
}

/// Reserva origem BR, aplica as cotas finais e devolve a seleção + o ledger dos
/// cortes. Paridade com `limitReservingBr` do TS, campo a campo.
pub fn limit_reserving_br_trace(
    streams: &[StreamRef],
    opts: &LimitBrOpts,
) -> LimitReservingBrTrace {
    let max_results = clamp_limit(opts.max_results) as usize;
    let br_slots = clamp_limit(opts.br_reserved_slots) as usize;

    // `brOnly`: as cotas só valem sobre as fontes BR.
    let pool: Vec<usize> = if opts.br_only {
        (0..streams.len()).filter(|&i| streams[i].is_br).collect()
    } else {
        (0..streams.len()).collect()
    };

    // Com `brFirst` (default) a prioridade é o BR inteiro sem `_lied`; sem ele é
    // só o tamanho da reserva. Prova primeiro, claim depois.
    let priority_take = if opts.br_first { usize::MAX } else { br_slots };
    let mut priority: Vec<usize> = pool
        .iter()
        .copied()
        .filter(|&i| streams[i].is_br && !streams[i].is_lied)
        .collect();
    sort_by_dub_rank(streams, &mut priority);
    priority.truncate(priority_take);
    let prioritized: HashSet<usize> = priority.iter().copied().collect();

    // As MESMAS N vagas atravessam o teto por indexador E o balde de qualidade;
    // ambas recebem POSIÇÕES da lista visitada mais abaixo.
    let mut reserved_list: Vec<usize> = pool
        .iter()
        .copied()
        .filter(|&i| streams[i].is_br && !streams[i].is_lied)
        .collect();
    sort_by_dub_rank(streams, &mut reserved_list);
    reserved_list.truncate(br_slots);
    let reserved_br: HashSet<usize> = reserved_list.into_iter().collect();

    // Ordem que `limitByQualityAndIndexer` visita.
    let mut qai_order: Vec<usize> = priority.clone();
    qai_order.extend(pool.iter().copied().filter(|i| !prioritized.contains(i)));
    let position: HashMap<usize, usize> = qai_order
        .iter()
        .enumerate()
        .map(|(pos, &index)| (index, pos))
        .collect();
    let reserved_pos: HashSet<usize> = reserved_br
        .iter()
        .filter_map(|index| position.get(index).copied())
        .collect();

    let refs: Vec<&StreamRef> = qai_order.iter().map(|&i| &streams[i]).collect();
    let qai = limit_by_quality_and_indexer_trace(
        &refs,
        &opts.quality_limits,
        opts.max_per_indexer,
        &reserved_pos,
        &opts.indexer_limits,
        &reserved_pos,
    );

    let mut dropped: Vec<QuotaDrop> = qai
        .dropped
        .iter()
        .map(|d| QuotaDrop {
            index: qai_order[d.index],
            reason: d.reason,
        })
        .collect();
    let kept: HashSet<usize> = qai.kept.iter().map(|&pos| qai_order[pos]).collect();
    // Volta à ordem original: sem `brFirst` o corte final depende dela.
    let eligible: Vec<usize> = pool.iter().copied().filter(|i| kept.contains(i)).collect();
    let mut br_streams: Vec<usize> = eligible
        .iter()
        .copied()
        .filter(|&i| streams[i].is_br && !streams[i].is_lied)
        .collect();
    sort_by_dub_rank(streams, &mut br_streams);

    // Reserva por faixa (Causa D): quando a faixa não tem release dublada
    // PRÓPRIA, o pack dublado da temporada pedida preenche a vaga dela.
    let per_faixa = clamp_limit(opts.br_reserved_per_quality) as usize;
    let mut garantidas: Vec<usize> = Vec::new();
    if per_faixa > 0 {
        let mut faixa_counts: HashMap<String, usize> = HashMap::new();
        let mut com_propria: HashSet<String> = HashSet::new();
        for &si in &br_streams {
            let quality = stream_quality(&streams[si]);
            if faixa_counts.get(&quality).copied().unwrap_or(0) >= per_faixa {
                continue;
            }
            // Passada 1: só dublado próprio (não-pack).
            if opts.season.is_some() && is_season_pack_release(&streams[si], opts.season) {
                continue;
            }
            com_propria.insert(quality.clone());
            *faixa_counts.entry(quality).or_insert(0) += 1;
            garantidas.push(si);
        }
        if let Some(season) = opts.season {
            let mut usados: HashSet<usize> = garantidas.iter().copied().collect();
            for quality in &QUALITY_KEYS {
                if com_propria.contains(*quality) {
                    continue;
                }
                if let Some(pack) = br_streams.iter().copied().find(|&si| {
                    !usados.contains(&si)
                        && stream_quality(&streams[si]) == *quality
                        && is_season_pack_release(&streams[si], Some(season))
                }) {
                    usados.insert(pack);
                    com_propria.insert((*quality).to_string());
                    garantidas.push(pack);
                }
            }
        }
    }

    // Globais trocados por vaga garantida BR, na ordem dos eventos (o ledger do
    // TS os emite conforme acontecem).
    let mut replaced: Vec<usize> = Vec::new();
    let mut selected: Vec<usize>;
    if opts.br_first {
        selected = br_streams
            .iter()
            .copied()
            .chain(eligible.iter().copied().filter(|i| !streams[*i].is_br))
            .take(max_results)
            .collect();
        if !garantidas.is_empty() {
            encaixa(
                streams,
                &mut selected,
                &garantidas,
                max_results,
                &mut replaced,
                &mut dropped,
            );
        }
    } else {
        // Sem prioridade visual as vagas continuam garantidas: entram no lugar
        // dos últimos globais e preservam a posição natural de `eligible`.
        let garantidas_set: HashSet<usize> = garantidas.iter().copied().collect();
        let mut reserved: Vec<usize> = garantidas.clone();
        reserved.extend(
            br_streams
                .iter()
                .copied()
                .filter(|i| !garantidas_set.contains(i)),
        );
        let reserved: Vec<usize> = reserved
            .into_iter()
            .take(br_slots.max(garantidas.len()))
            .collect();
        let prefixo: Vec<usize> = eligible.iter().copied().take(max_results).collect();
        let mut chosen: HashSet<usize> = prefixo.iter().copied().collect();
        for &stream_index in &reserved {
            if chosen.contains(&stream_index) {
                continue;
            }
            if let Some(replace) = prefixo
                .iter()
                .rev()
                .copied()
                .find(|&c| chosen.contains(&c) && !streams[c].is_br)
            {
                chosen.remove(&replace);
                replaced.push(replace);
                dropped.push(QuotaDrop {
                    index: replace,
                    reason: "br-guarantee-replaced",
                });
            }
            if chosen.len() < max_results {
                chosen.insert(stream_index);
            }
        }
        selected = eligible
            .iter()
            .copied()
            .filter(|i| chosen.contains(i))
            .take(max_results)
            .collect();
        if !garantidas.is_empty() {
            encaixa(
                streams,
                &mut selected,
                &garantidas,
                max_results,
                &mut replaced,
                &mut dropped,
            );
        }
    }

    LimitReservingBrTrace {
        selected,
        eligible,
        replaced,
        dropped,
    }
}
