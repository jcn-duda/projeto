# Fechamento funcional do colhedor Rust — plano de implementação

> **Para execução por agentes:** executar tarefa a tarefa com `subagent-driven-development` ou `executing-plans`, somente depois de autorização para implementar. Os passos usam checkboxes. Cada entrega termina em validação e checkpoint; commit, push e deploy exigem pedidos próprios.

**Objetivo:** estabilizar o colhedor nativo, preservando obrigações FULL, a honestidade do índice e a prioridade operacional, e definir a sequência restante da migração.

**Arquitetura:** manter `adom-harvest` na thread própria do gateway, com um drain por vez. Separar intenção, execução e resultado; reutilizar os stores e os predicados nativos existentes. Node continua como fachada administrativa, sem retomar a execução da colheita.

**Stack:** Rust 1.92.0, Tokio, rusqlite/SQLite, reqwest; TypeScript ESM e `node:test` apenas nos contratos da ponte. Nenhuma dependência nova.

---

## 1. Escopo, evidência e limites

Este é o detalhamento escolhido: **Fase 5 + roteiro**, não o porte completo dos subsistemas restantes.

Base inspecionada: branch `rust`, HEAD e referência local `origin/rust` em `fb65a90e`. Essa igualdade de referências não prova o estado de uma implantação. Nenhum build, teste, serviço real ou produção foi executado durante este planejamento.

### O que já existe e não será refeito

- `/stream` e `/resolve` públicos nativos; ponte napi obrigatória.
- Execução do colhedor na thread `adom-harvest`, administração em loopback e config ao vivo.
- Fila, dedupe, balde horário, sonda, índice e cache bruto com propriedade Rust.
- `LiveOverlay`, `nativeApplied`, pausa e atualização da configuração do worker.
- Algoritmo puro de prioridade, cliente BLUDV nativo e invalidação nativa por obra.
- Motor dos nove sites de crawl e resolvers nativos.

### Lacunas verificadas que este plano cobre

| Lacuna | Evidência no código | Entrega |
|---|---|---|
| Sonda aceita FULL sem guardá-la; FULL perde obrigação após sonda | `queue.rs`, `inflight.rs`, `serve.rs`, `settle.rs` | 5A–5B |
| Retorno acima do teto desaparece no save/load | `HarvestQueue::save_to` e `replace` truncam | 5A |
| Sonda grava como índice completo | `ReleaseEntry` não transporta a intenção; `NativeReleaseIndex::record` força `partial:false` | 5C |
| Found usa apenas origem BR e seeds | `NetworkDrain::run`, antes da confirmação da escrita | 5D |
| Transição de dublado não invalida streams no drain | store oferece invalidação, mas não está ligado ao colhedor | 5D |
| BR-first configurável não altera a ordem real do gateway | boot usa `load_from(..., None)` e loop não chama prioridade | 5E |
| BLUDV independente não participa da colheita FULL | drain só consulta Jackett | 5F |

### Mudanças concorrentes a preservar

Não incluir no patch do colhedor: `src/client/painel/kit.ts`, `src/client/painel/view-saude.ts`, `src/public/painel.html`, `src/routes/public.ts`, `test/painel-magnet-bank.test.ts` e o novo `src/public/painel-indexers.css`. Também não limpar configurações locais não rastreadas.

### Fora deste recorte

- Migração de debrid, holds, inventário, autofetch, ingestão do crawl ou fallback de metadados.
- Novo motor TS, novos knobs de rollback, novos provedores ou nova UI.
- Mudança de matching, classificação de áudio, Cardigann, lista de indexers ou proteção SSRF.
- Exactly-once, journal durável de inflight, transação única entre fila/índice/sonda/balde ou reparo automático de SQLite corrompido.
- Preempção de uma obra já em execução e teto horário rígido entre cada consulta. Hoje as guardas operam no início do tick; essa diferença do oráculo fica explícita no roteiro 5H.
- Captura integral do banco permanente de magnets. Reutilizar a escrita/marcação existente, sem transferir tabelas ou criar escritor adicional.

**Nome do aceite:** fechamento funcional deste recorte da Fase 5. Não declarar paridade operacional integral com o TS nem migração completa do backend.

## 2. Contratos decididos

### 2.1 Intenção não é execução

- Identidade da fila: IMDb + temporada + episódio; motivo continua fora da identidade.
- Dedupe mantém a chave atual, que também considera motivo. Não mudar TTL de 12 horas.
- O modo executado é congelado em `begin`, pelo `entry.br_probe` da entrada retirada.
- A intenção efetiva acumula promoções e sondas recebidas em voo.
- A obrigação FULL é acumulada separadamente, com seu próprio motivo e `priority_at`.
- Promoção nunca renova `enqueued_at`; empate de rank preserva o motivo e o timestamp existentes.

Estados da fila:

| Base | Pedido FULL | Pedido de sonda |
|---|---|---|
| F: FULL | F; fundir prioridade | PF; guardar motivo FULL antes da promoção |
| P: sonda pura | PF, mesmo se FULL for mais fraca | P; fundir prioridade |
| PF: sonda + FULL pendente | PF; guardar a FULL mais forte | PF; preservar FULL separada |

### 2.2 Desfecho de um drain

| Execução real | Resultado | Retorno |
|---|---|---|
| FULL | sucesso | nenhum; absorveu as intenções da mesma identidade |
| Sonda sem FULL | sucesso | nenhum |
| Sonda com FULL | sucesso | exatamente uma FULL |
| FULL com ou sem sonda anexada | falha 1–3 | uma FULL, com motivo efetivo promovido |
| Sonda sem FULL | falha 1–3 | uma sonda |
| Sonda com FULL | falha 1–3 | uma FULL, com o motivo FULL preservado |
| Qualquer modo | quarta falha consecutiva | descarte explícito pelo limite atual |

- Sucesso reinicia o contador de falhas, inclusive quando deixa uma FULL remanescente.
- Retorno usa `tail`, sem passar pelo ingresso público nem pelo dedupe.
- “Cauda” é a posição de reinserção; a seleção seguinte volta a considerar prioridade e idade original.
- A sonda anexada a um FULL é finalizada, mas não transforma o retry em sonda.
- Criar o remanescente custa zero consultas. Cada drain debita suas consultas Jackett uma única vez.
- Contagem significa chamadas lógicas aos alvos Jackett, não todos os hops HTTP, retries internos ou consultas BLUDV.

### 2.3 Capacidade e persistência

- `save_to` e `replace` deixam de truncar entradas aceitas.
- Retorno de inflight pode exceder transitoriamente `queue_max`; o snapshot inteiro deve sobreviver a save/load.
- Reduzir o teto por config não remove imediatamente entradas existentes.
- Um ingresso novo e distinto continua aplicando o teto: com BR-first remove a cauda priorizada; sem BR-first remove a entrada mais antiga por `enqueued_at`. Empates são estáveis.
- Se o teto foi reduzido, o próximo ingresso pode exigir mais de uma evicção; cada descarte deve ser explícito no log.
- A proteção é contra perda por fusão e truncamento silencioso, não uma promessa de que uma fila finita jamais descarta trabalho por capacidade.
- Fila legada continua legível. Não mudar schema SQLite, namespace, TTL ou formato público do preview.

### 2.4 Completude do índice

“Completo” significa que o plano de coleta FULL cobriu seus alvos obrigatórios, não que o catálogo inteiro foi descoberto.

Adicionar uma opção **suplementar** de escrita. Ela é decidida por execução real, nunca pela intenção coalescida. No colhedor:

- Sonda: sempre suplementar.
- FULL com algum alvo Jackett sem resposta válida: suplementar.
- FULL com todos os alvos Jackett respondidos: escrita normal.
- BLUDV é complemento opcional; não prova cobertura dos alvos Jackett.
- Em cada chave real de destino, escrita suplementar preserva `partial` existente; chave nova nasce parcial.
- Escrita normal preserva a semântica atual de `partial`/`keep_partial`.
- Um lote vazio não apaga dados nem limpa parcialidade. Uma FULL vazia não passa a provar completude de dados antigos.
- Cobertura por pools continua no consumidor existente; não adicionar um skip de FULL baseado em `idx_pool_covered`.

### 2.5 Found e invalidação

- Ler o índice antes e depois de uma escrita confirmada.
- Found exige hash novo, não vazio, comparação case-insensitive, BR dublado, não `lied`, não `source=autofetch`, seeds positivos.
- Quando já havia BR dublado antes, o Found exige a qualidade exata `1080p`, como no contrato TS de `probeFoundViable`; não substituir por “1080p ou superior” nesta entrega.
- A transição BR/upgrade segue `brTransition` do oráculo, separada de Found: transição não exige hash novo nem seeds positivos.
- Invalidar somente os streams da obra, em todas as configurações/contas, pelo store compartilhado do gateway.
- Falha da escrita não produz Found. Falha de invalidação não apaga a prova gravada, mas fica registrada e pendente para nova tentativa local.

### 2.6 Prioridade real sem I/O no comparador

- Reutilizar `prioritize` e `has_br_dubbed`; não criar uma nova régua de título/áudio.
- Ordem: `next-episode` → `br-gap` recente → regulares. Entre regulares, aplicar anti-fome e evidência conforme o algoritmo existente; sem BR-first, FIFO.
- Materializar um snapshot de evidência por identidade, com uma leitura nativa por identidade, fora do lock da fila.
- O comparador, o ingresso e o preview usam somente esse snapshot em memória.
- Atualizar snapshot no boot e antes de cada seleção; após a escrita do drain, atualizar antes da próxima seleção/publicação de ordem.
- A fila pode mudar durante a leitura: aplicar a prioridade à fila atual, nunca substituir a fila por uma cópia antiga. Identidade recém-chegada sem evidência no snapshot recebe rank neutro até a próxima atualização.
- O preview representa a ordem do mesmo snapshot usado pelo scheduler, não uma consulta instantânea ao SQLite. Mudanças externas no índice aparecem no próximo ciclo de atualização.
- Pausa/desligamento/teto não autorizam rede nem retirada da fila. Config nova não muda os alvos de um drain já iniciado.

### 2.7 BLUDV

- Executar somente em FULL, com `BLUDV_ENABLED` e os limites atuais; default continua desligado.
- Query: `pt_query` não vazia; na ausência, `query`.
- Usar `BludvSearchOpts { dubbed_only: false }`, como a colheita pública de acervo; a classificação posterior continua a existente.
- Reutilizar `search_outcome`, conversão nativa, raw store e guarda SSRF por salto.
- Não mudar `BludvOutcome` nesta entrega: `Ok(items)` não prova que todo post foi resolvido, pois o cliente já pode omitir posts incompletos. BLUDV nunca certifica completude.
- Manter tentativas Jackett e BLUDV independentes: falha total do Jackett não impede aproveitar releases BLUDV válidos.
- Havendo resposta Jackett válida, manter o sucesso atual após escrita válida, mesmo com BLUDV desabilitado/falho; marcar suplementar se faltou algum alvo Jackett.
- Sem resposta Jackett válida, persistir BLUDV aproveitável como suplemento, mas manter o drain falho e o retry FULL. BLUDV vazio não converte falha total em sucesso.
- Não consultar BLUDV em sonda, nem expandir o subset vazio para `/all`.

## 3. Organização dos arquivos

Caminhos relativos a `E:/stremio adom`. Criar apenas os arquivos listados abaixo; manter todo `.rs` em até 400 linhas, sem aumentar baseline.

| Entrega | Arquivos novos | Arquivos existentes principais |
|---|---|---|
| 5A | `rust/crates/adom-harvest/src/intent.rs`, `intent_tests.rs`, `queue_intent_tests.rs`, `store_intent_tests.rs` | `types.rs`, `queue.rs`, `store.rs`, `lib.rs` no mesmo crate |
| 5B | `rust/crates/adom-harvest/src/inflight_tests.rs`; `rust/crates/adom-server/src/harvest/settle_intent_tests.rs` | `inflight.rs`; gateway `serve.rs`, `settle.rs`, `settle_tests.rs`, `enqueue.rs` |
| 5C | `rust/crates/adom-index/src/release_index_supplement_tests.rs` | `release_index.rs`, `release_index_record.rs`; `adom-search/src/internal_types.rs`, `orchestrator/finish.rs`; `adom-store/src/index_impl.rs`; gateway `harvest/drain.rs` |
| 5D | `rust/crates/adom-core/src/br_gap_outcome_tests.rs`; gateway `harvest/drain_record.rs`, `drain_record_tests.rs` | `adom-core/src/br_gap.rs`, `lib.rs`; gateway `harvest/mod.rs`, `serve.rs`, `drain.rs`, `proxy.rs` |
| 5E | gateway `harvest/evidence.rs`, `evidence_tests.rs`, `handle.rs` | `harvest/mod.rs`, `serve.rs`; crate `adom-harvest/src/queue.rs`, `queue_tests.rs` |
| 5F | gateway `harvest/drain_sources.rs`, `drain_sources_tests.rs` | `harvest/drain.rs`, `drain_shape.rs`; `adom-search/src/orchestrator/harvest_support.rs`, `harvest_support_tests.rs` |
| 5G | gateway `harvest/loop_tests.rs`, `network_tests.rs` | `harvest/serve.rs`, módulos de registro de testes; `test/harvest-native.test.ts`, `test/harvester-panel.test.ts`, `docs/harvest-native-contract.md`, plano anterior |

Os caminhos abreviados na tabela pertencem ao diretório indicado na mesma célula. Atualizações mecânicas de literais dos tipos modificados incluem testes e consumidores encontrados pelo compilador, sem alterar comportamento fora do colhedor.

Responsabilidades:
- `intent.rs`: fusão pura, sem SQLite/rede.
- `store.rs`: envelope privado de persistência, sem política de prioridade.
- `settle.rs`: finalização e uma única reinserção.
- `drain_record.rs`: filtro existente → escrita → delta → invalidação.
- `evidence.rs`: snapshot do índice para o algoritmo de prioridade existente.
- `drain_sources.rs`: consultas e seus resultados; não decide matching.
- `handle.rs`: extração mecânica dos métodos administrativos de `HarvestHandle`, para manter `mod.rs` abaixo do teto.

## 4. Preparação — checkpoint de base

- [ ] Registrar `git status --short --branch`, `git diff --stat` e `git log -1 --oneline --decorate` antes da implementação. Examinar diffs dos arquivos que serão tocados; interromper somente se houver sobreposição real com trabalho concorrente.
- [ ] Executar o gate de base da seção 6 e registrar falhas com comando e exit code. Resultados históricos não contam como baseline desta execução.
- [ ] Ler `docs/harvest-native-contract.md` e os testes citados antes de editar cada fatia. O oráculo `E:/adom-esm` é somente leitura; não regenerar goldens para acomodar divergência.
- [ ] Garantir isolamento dos builds: outra sessão não pode consumir ou reescrever o mesmo `dist/` durante build/harness. Não criar worktree, stash ou limpeza automaticamente para resolver colisões.

## 5. Entregas executáveis

Cada entrega segue: teste de regressão → executar e observar falha pelo motivo esperado → alteração mínima → teste focado → gate proporcional → checkpoint. Não juntar entregas independentes num patch opaco.

### 5A — Intenção FULL simétrica e snapshot sem truncamento

**Arquivos:** `rust/crates/adom-harvest/src/{types,intent,queue,store,lib}.rs` e os três arquivos de teste indicados na tabela.

- [ ] Adicionar o teste de regressão abaixo em `queue_intent_tests.rs` e registrá-lo como módulo de teste. Primeiro usar apenas a asserção sobre `full_base`, que já existe e deve falhar no caso sonda→FULL.

```rust
#[test]
fn sonda_aceita_full_mais_fraca_sem_perder_obrigacao() {
    use crate::{HarvestQueue, HarvestQueueConfig, HarvestRequest};
    let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
    let mut probe = HarvestRequest::movie("tt0111161", "br-gap");
    probe.br_probe = true;
    assert!(queue.enqueue(probe).accepted);
    assert!(queue.enqueue(HarvestRequest::movie("tt0111161", "miss")).accepted);
    let entry = &queue.entries()[0];
    assert!(entry.br_probe);
    assert!(entry.full_base);
    assert_eq!(entry.reason, "br-gap");
}
```

- [ ] Rodar `cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-harvest --locked sonda_aceita_full_mais_fraca`. Esperado antes da correção: falha de asserção, não falha de compilação.
- [ ] Mover `PendingFull` de `inflight.rs` para `types.rs`, preservar seu reexport público e adicionar o campo privado de transporte a `HarvestEntry`. Definições:

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFull {
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority_at: Option<i64>,
}
```

```rust
// Campo novo de HarvestEntry; não aparece no preview HTTP.
#[serde(skip)]
pub full_intent: Option<PendingFull>,
```

- [ ] Centralizar a fusão em `intent.rs`. Implementação do núcleo da decisão:

```rust
use crate::reason::reason_priority;
use crate::types::{HarvestEntry, PendingFull};

impl PendingFull {
    pub fn strongest(current: Option<Self>, incoming: Option<Self>) -> Option<Self> {
        match (current, incoming) {
            (None, next) => next,
            (some, None) => some,
            (Some(old), Some(new)) => {
                if reason_priority(&new.reason) > reason_priority(&old.reason) {
                    Some(new)
                } else {
                    Some(old)
                }
            }
        }
    }
}

impl HarvestEntry {
    pub fn pending_full(&self) -> Option<PendingFull> {
        if let Some(full) = &self.full_intent {
            return Some(full.clone());
        }
        (!self.br_probe || self.full_base).then(|| PendingFull {
            reason: self.reason.clone(),
            priority_at: (self.reason == "br-gap").then_some(self.priority_at).flatten(),
        })
    }

    pub(crate) fn normalize_intent(&mut self) {
        let full = self.pending_full();
        self.full_base = self.br_probe && full.is_some();
        self.full_intent = if self.br_probe { full } else { None };
    }

    pub(crate) fn merge_intent(&mut self, incoming: &HarvestEntry) {
        let full = PendingFull::strongest(self.pending_full(), incoming.pending_full());
        if reason_priority(&incoming.reason) > reason_priority(&self.reason) {
            self.reason = incoming.reason.clone();
            self.priority_at = (incoming.reason == "br-gap")
                .then_some(incoming.priority_at).flatten();
        }
        self.br_probe |= incoming.br_probe;
        self.full_base = self.br_probe && full.is_some();
        self.full_intent = if self.br_probe { full } else { None };
    }
}
```

- [ ] Usar essa fusão em `enqueue`, `head` e `tail`. Comparar antes/depois: motivo promovido retorna `Promoted`; apenas intenção/flag alterada retorna `Queued`; nada alterado retorna `Duplicate`. Preservar posições e `enqueued_at` existentes.
- [ ] Persistir `full_intent` em envelope privado no `store.rs`; serialização pública continua omitindo o campo. Definição do envelope:

```rust
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    #[serde(flatten)]
    entry: HarvestEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_intent: Option<crate::types::PendingFull>,
}
```

No save, copiar `entry.full_intent` para o campo do envelope. No load, recolocá-lo na entrada e chamar `normalize_intent`. Legado `fullBase:true` sem snapshot usa motivo/timestamp disponíveis; dados já perdidos sem marcador não são reconstruíveis.

- [ ] Remover as duas truncagens: `replace` atribui todas as entradas válidas; `save_to` passa `&self.entries` ao store. Não alterar `HarvestStore::save` vazio, TTL ou chaves auxiliares.
- [ ] Completar a matriz F/P/PF, motivos fortes/fracos/empatados, `head`, `tail`, identidade por episódio e preservação de timestamps. No round-trip, afirmar `pending_full().unwrap().reason == "miss"` enquanto o motivo efetivo permanece `br-gap`.
- [ ] Testar fila com teto 1: retirar uma obra, aceitar outra, devolver a primeira, salvar e carregar; ambas continuam presentes. Testar também redução do teto seguida apenas de save/load.
- [ ] Rodar todos os testes de `adom-harvest`; esperado: zero falhas. Checkpoint 5A: intenção e persistência corretas, ainda sem afirmar correção do loop do gateway.

### 5B — Levar a intenção até o settlement

**Arquivos:** `rust/crates/adom-harvest/src/inflight.rs`, `inflight_tests.rs`; `rust/crates/adom-server/src/harvest/{serve,settle,settle_tests,settle_intent_tests,enqueue}.rs`.

- [ ] Criar regressão usando `HarvestWorker::begin/finish`, não apenas `tick_async`: abrir uma sonda, coalescer FULL antes do finish, concluir e afirmar que há exatamente uma FULL na fila.
- [ ] Rodar `cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-server --locked harvest::`. Esperado: a regressão nova falha com fila vazia antes da correção.
- [ ] Acrescentar `full: Option<PendingFull>` a `HarvestIntent`; `from_entry` usa `entry.pending_full()`. O slot recebe a FULL base e funde `intent.full` independentemente da promoção do motivo efetivo. Remover duplicação de rank em `FullIntent`, usando `PendingFull::strongest`.
- [ ] Extrair os testes inline de `inflight.rs` para `inflight_tests.rs`. Cobrir FULL base forte + pedido FULL fraco, PF base e identidade diferente que não fecha o slot.
- [ ] Substituir o contrato de `Settlement` e capturar o snapshot antes de `finish`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Settlement {
    pub intent: Option<adom_harvest::PendingIntent>,
    pub ok: bool,
    pub br_found: bool,
}
```

```rust
let settlement = Settlement {
    intent: queue.inflight().pending(&identity),
    ok: outcome.ok,
    br_found,
};
worker.finish(&mut queue, &identity, outcome, now);
settler.settle(&mut queue, &inner.store, entry, settlement, now);
```

Captura, finish, settlement e persistência ficam sob o mesmo lock da fila, sem `await` intermediário. Rede continua fora do lock.

- [ ] Implementar a escolha do retorno pela tabela 2.2. FULL remanescente limpa `br_probe`, `full_base` e `full_intent`, preservando identidade e idade; usa o motivo FULL apenas quando a execução original era sonda. Na falha de uma execução FULL, usar motivo efetivo promovido sem a flag da sonda anexada.
- [ ] Finalizar a sonda quando `entry.br_probe || intent.br_probe`. Manter Found/Empty/Failed atuais nesta fatia; a qualidade da prova muda apenas na 5D.
- [ ] Manter três reinserções e descarte na quarta falha; corrigir o log para reportar quatro falhas, não três. Não mudar dedupe nem política de tentativas.
- [ ] Cobrir sucesso/falha nos dois sentidos, FULL com sonda anexada, reset após sucesso, quarta falha, dedupe vivo e contagem horária única.
- [ ] Testar remanescente FULL sob tráfego, pausa e teto: ele permanece na fila e não drena como sonda.
- [ ] Rodar `adom-harvest` e os testes `harvest::` do gateway. Checkpoint 5B: menor correção publicável da perda de intenção; índices antigos não foram reparados.

### 5C — Sonda não certifica completude

**Arquivos:** os indicados na tabela 5C; atualizar também literais de `ReleaseEntry`/`RecordOptions` e o construtor em `finish.rs`.

- [ ] Adicionar testes de registro suplementar: chave nova, parcial existente, completa existente e um lote de série roteado para chaves com estados diferentes.
- [ ] Adicionar `supplemental: bool` a `RecordOptions`, com default `false`, e a `ReleaseEntry`, com `#[serde(default, skip_serializing_if = "std::ops::Not::not")]`. Construtores antigos usam `false`; JSON antigo continua válido e a saída antiga omite o campo.
- [ ] Em `NativeReleaseIndex::record`, transportar o campo; não reconstruir intenção a partir de `source`, título ou flags de áudio.
- [ ] Aplicar esta política dentro do laço de cada chave em `release_index_record.rs`, depois de carregar `prior_entry`:

```rust
let partial = if opts.supplemental {
    prior_entry.as_ref().is_none_or(|entry| entry.partial) || opts.partial
} else if opts.keep_partial {
    prior_entry.as_ref().is_some_and(|entry| entry.partial) || opts.partial
} else {
    opts.partial
};
```

- [ ] No drain, registrar separadamente tentativas e respostas válidas por alvo. `jackett_complete` só é verdadeiro com pelo menos um alvo planejado e todos respondidos. Não inferir pela soma de itens ou por `responded > 0`.
- [ ] Antes de `record_release`, atribuir `release.supplemental = entry.br_probe || !jackett_complete`. Em FULL com falhas parciais, preservar a política atual de sucesso com resposta útil; a lacuna fica representada no índice.
- [ ] Cobrir: sonda seguida de FULL, FULL seguida de sonda, coalescing não muda o modo da escrita, índice vazio não vira completo, `/all` só no FULL, S1E1/S1E2/pack em destinos diferentes, `fromAccount` continua fora.
- [ ] Rodar testes de `adom-index`, `adom-store`, `adom-search` e `adom-server`, mais o gate congelado da seção 6. Checkpoint 5C: semântica nova opt-in; os demais escritores mantêm seu comportamento.

Não limpar o cache global nem fazer bump de namespace: não mudou formato persistido de rótulos. Entradas historicamente marcadas completas não podem ser identificadas retrospectivamente; reparo de dados reais exige uma operação posterior autorizada.

### 5D — Prova de Found e invalidação nativa

**Arquivos:** `rust/crates/adom-core/src/{br_gap,br_gap_outcome_tests,lib}.rs`; gateway `harvest/{drain_record,drain_record_tests,drain,mod,serve}.rs` e `proxy.rs`.

- [ ] Portar testes do contrato TS com hash repetido, diferença de caixa, hash vazio, `lied`, autofetch, seeds zero e alvo 1080p. O código puro será compartilhado, sem acessar o store.
- [ ] Acrescentar ao módulo `br_gap` os tipos e funções abaixo, exportando-os pelo crate:

```rust
#[derive(Clone, Copy, Debug)]
pub struct BrProbeRelease<'a> {
    pub hash: &'a str,
    pub seeders: f64,
    pub release: BrGapRelease<'a>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrTransition { None, Br, Upgrade }

pub fn br_transition(before: &[BrGapRelease<'_>], after: &[BrGapRelease<'_>]) -> BrTransition {
    let had_br = has_br_dubbed(before);
    if !had_br && has_br_dubbed(after) {
        return BrTransition::Br;
    }
    if had_br
        && !has_br_dubbed_at_quality(before, BR_GAP_TARGET_QUALITY)
        && has_br_dubbed_at_quality(after, BR_GAP_TARGET_QUALITY)
    {
        return BrTransition::Upgrade;
    }
    BrTransition::None
}

pub fn probe_found_viable(
    before: &[BrProbeRelease<'_>],
    after: &[BrProbeRelease<'_>],
    require_quality: Option<&str>,
) -> bool {
    let prior: std::collections::HashSet<String> = before.iter()
        .filter(|r| !r.hash.is_empty())
        .map(|r| r.hash.to_ascii_lowercase()).collect();
    after.iter().any(|r| {
        !r.hash.is_empty()
            && !prior.contains(&r.hash.to_ascii_lowercase())
            && is_br_dubbed(&r.release)
            && r.seeders > 0.0
            && require_quality.is_none_or(|q| r.release.quality.eq_ignore_ascii_case(q))
    })
}
```

- [ ] Extrair a parte de filtro/escrita de `drain.rs` para `drain_record.rs`, mantendo `filter_relevant_raw`, `release_entry_for` e `record_release` como origens das regras existentes. Não duplicar o filtro.
- [ ] Zerar `last_found` no início de toda execução, inclusive retornos antecipados. Ler `before` pela localização da obra, gravar, ler `after` somente após `Ok`, calcular Found e transição pelos helpers.
- [ ] Se `before` já tem BR dublado, passar `Some(BR_GAP_TARGET_QUALITY)` a `probe_found_viable`; caso contrário, `None`. Usar linhas efetivamente retidas pelo índice, não todos os survivors anteriores ao corte.
- [ ] Passar a mesma `Option<Arc<StreamsStore>>` de `StreamStores.streams` ao colhedor a partir de `proxy.rs`. Não abrir um segundo store de streams nem chamar Node por HTTP para invalidar Rust.
- [ ] Para transição BR/upgrade, chamar `invalidate_for_obra`. Manter um conjunto volátil de IMDb com invalidação falha e tentar novamente antes do próximo drain, sem refazer a rede da obra só por isso. Sucesso remove o IMDb; falha registra erro sem URL/credencial.
- [ ] Em `streams=None`, registrar degradação explícita; não afirmar invalidação realizada. Em falha de índice, `br_found=false`; sem índice configurado, o drain falha com zero consultas em vez de anunciar sucesso descartado.
- [ ] Testar duas contas e duas obras no mesmo store: só a obra com transição perde as entradas. Cobrir erro de gravação, erro de invalidação, repetição idempotente, ausência de store e limpeza de `last_found` entre duas execuções.
- [ ] Rodar `adom-core`, `adom-store` e testes `harvest::` do gateway. Checkpoint 5D: Found prova índice; publicação do cache é uma etapa distinta e observável.

A invalidação não é uma barreira contra uma busca concorrente que volte a gravar snapshot antigo depois dela. Generation fencing entre colheita e commits SWR pertence ao hardening 5H, não será alegado como entregue aqui.

### 5E — Integrar BR-first, preview e evicção

**Arquivos:** gateway `harvest/{evidence,evidence_tests,handle,mod,serve}.rs`; `rust/crates/adom-harvest/src/{queue,queue_tests}.rs`.

- [ ] Testar o adaptador com `SharedIndex` real em SQLite temporário: release BR dublada eleva rank; `lied`, apenas presença, origem global ou `source=autofetch` não elevam. Separar S1E1 e S1E2.
- [ ] Criar `EvidenceSnapshot`, indexado por `entry_identity`, armazenando presença e dublagem. Implementar `BrEvidence` sem I/O. Formato:

```rust
#[derive(Clone, Copy, Default)]
struct EvidenceValue {
    present: bool,
    dubbed: bool,
}

#[derive(Clone, Default)]
struct EvidenceSnapshot {
    by_identity: std::collections::HashMap<String, EvidenceValue>,
}
```

- [ ] Construir o snapshot com `SharedIndex::lookup` e converter cada linha para `BrGapRelease`; `dubbed` é `adom_core::has_br_dubbed`, não `releases.len() > 0`. Deduplicar identidades antes da leitura; índice ausente fornece snapshot neutro.
- [ ] Guardar o último snapshot em `Inner` e copiar sua referência/foto antes de ordenar. Ordem de locks: nunca manter o mutex do snapshot enquanto se espera o lock da fila; nunca ler SQLite com o lock da fila retido.
- [ ] No boot e antes de `begin`: copiar identidades sob lock curto, soltar, ler índice, reacquirir e priorizar a fila atual. Atualizar publicação mesmo em skip; quando há tráfego, `take_probe` continua escolhendo apenas a primeira sonda da ordem efetiva.
- [ ] No ingresso, aplicar prioridade com o último snapshot antes da evicção e depois da fusão/inserção. Com BR-first, remover cauda; sem ele, localizar o menor `enqueued_at`. Logar a identidade e o motivo de cada descarte por capacidade, sem dados de conta.
- [ ] Reordenar/publicar após config e settlement. Atualização de evidência externa é eventual, no próximo ciclo; não colocar consulta ao índice dentro de `GET /harvest`.
- [ ] Extrair os métodos de `HarvestHandle` de `mod.rs` para `handle.rs` sem alterar rotas ou assinaturas públicas. A chamada administrativa continua responsiva durante a rede.
- [ ] Testar boot, promoção, anti-fome, expiração da janela de br-gap, toggle BR-first, mudança de espera, preview, evicção dos dois modos e enqueue concorrente durante a construção do snapshot.
- [ ] Rodar `adom-harvest` e testes `harvest::` do gateway. No ensaio com 200 identidades, afirmar uma leitura por identidade, zero leitura dentro do comparador e ausência de espera por rede no enqueue/pending. Registrar duração, sem usar um limite de milissegundos dependente da máquina como teste unitário.

### 5F — BLUDV como complemento da colheita FULL

**Arquivos:** gateway `harvest/{drain_sources,drain_sources_tests,drain,drain_shape}.rs`; `rust/crates/adom-search/src/orchestrator/{harvest_support,harvest_support_tests}.rs`.

- [ ] Criar testes de fonte com servidor HTTP local: sucesso, vazio, falha, timeout, kill-switch e URL bloqueada. Nenhum teste unitário consulta sites reais.
- [ ] Expor em `harvest_support.rs` o wrapper de lote sobre a conversão já existente:

```rust
pub fn raw_items_from_bludv(items: Vec<adom_sources::BludvRawItem>) -> Vec<RawItem> {
    items.into_iter().map(super::bludv_collector::raw_from_bludv).collect()
}
```

- [ ] Montar `BludvClient` uma vez no `NetworkDrain`; obter `adom_store::raw_store_from_env()` (`rust/crates/adom-store/src/raw.rs`) e anexar `Arc<RawStoreHandle>` por `with_raw_store`. Isso mantém o mesmo `cache.db` e respeita `CACHE_PERSIST=false`. Falha de abertura de raw degrada para cliente sem cache, com log; não reintroduzir L1 Node.
- [ ] Extrair as consultas de `drain.rs` para `drain_sources.rs`. Converter Jackett e BLUDV para `Vec<RawItem>` antes da filtragem conjunta; adaptar `relevance_items` para os campos de `RawItem`, preservando a equivalência dos itens Jackett já testada.
- [ ] Executar BLUDV depois das tentativas Jackett, apenas em FULL, com query PT preferencial e `dubbed_only:false`. Não alterar timeout/concorrência do cliente, `record_status:false`, breaker ou os alvos da sonda.
- [ ] Aplicar os desfechos da seção 2.7. Em erro total Jackett com BLUDV válido, escrever suplemento e manter `ok:false`; consultas já tentadas continuam debitadas. Não interpretar `Ok([])` como prova de cobertura da obra.
- [ ] Testar que a sonda faz zero chamadas BLUDV; FULL desabilitado também; fallback PT/EN é correto; o mesmo hash nas duas fontes não duplica no índice; nenhuma linha `fromAccount` entra.
- [ ] Repetir a chamada BLUDV no mesmo raw store e comprovar hit sem nova rede quando a resposta era cacheável. Não modificar nem relaxar guardas para localhost fora da configuração explícita do teste.
- [ ] Rodar testes de `adom-sources`, `adom-search`, `adom-server` e os gates de `/stream`. Checkpoint 5F: complemento nativo entregue, sem alegar igualdade entre as cinco fontes de `/stream` e o colhedor.

### 5G — Integração, contratos e documentação

**Arquivos:** gateway `harvest/{loop_tests,network_tests,serve}.rs` e registros dos módulos; `test/harvest-native.test.ts`, `test/harvester-panel.test.ts`; documentos citados abaixo.

- [x] Extrair uma iteração do corpo de `serve` para função testável no mesmo módulo, sem mudar o runtime de produção. Injetar um drain fake com barreiras/oneshot; não usar sleeps arbitrários nem substituir o ciclo por uma simulação diferente.
- [x] Durante a barreira do drain, enviar FULL e sonda da mesma identidade e um pedido de obra diferente; comprovar coalescing da primeira e permanência da segunda. Soltar a barreira e inspecionar fila, sonda, balde e snapshot persistido.
- [x] Em testes de rede locais, exercitar o `NetworkDrain` real com metadados, Jackett e BLUDV stubados. Verificar alvos, índice, parcialidade, retry e invalidação; o fake do worker sozinho não prova essas integrações.
- [x] Cobrir restart depois de settlement/save, dedupe de 12h, TTL da fila, balde da mesma hora e virada da hora. Não chamar esse teste de recuperação de crash no meio da rede.
- [x] Revalidar a ponte Node existente: config aplicada sem restart, pausa, `nativeApplied:false` quando a ponte falha, reset para defaults, pending e formato público sem `fullIntent`.
- [x] Usar os arquivos Node já existentes. Se a catraca obrigar a criar um `.test.ts`, registrar seu `.test.js` em `package.json.testFiles` na mesma entrega; `test:complete` é obrigatório.
- [x] Atualizar `docs/harvest-native-contract.md`: fontes reais, FULL↔sonda, limite de retry, modo suplementar, Found, snapshot de prioridade, persistência/capacidade e limites de crash/preempção. Retirar a dívida antiga de config ao vivo já entregue.
- [x] Atualizar `docs/superpowers/plans/2026-10-23-migracao-ts-rust-restante.md` com uma seção datada que aponta este plano e corrige status atuais; preservar registros históricos como históricos. Não repetir como atuais os 14 testes falhos, 45 arquivos acima do teto, dois escritores raw ou legado Mico já removido.
- [x] Registrar evidência de cada gate com comando, exit code e escopo; executar a seção 6 inteira. Revisão especializada de Rust e de TypeScript, quando tocado, deve cobrir os diffs desta implementação, não o WIP do painel.
- [x] Entregar matriz de aceite da seção 7 preenchida. Commit local sem push/deploy, só com os diffs desta implementação.

## 6. Comandos e estratégia de validação

Executar da raiz do workspace, um comando por vez. No PowerShell 5.1, não encadear com `&&`; conferir `$LASTEXITCODE` imediatamente. Esperado em todos os gates: exit code zero. Falha bloqueia o próximo gate dependente.

### Gates focados

```powershell
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-harvest --locked
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-server --locked harvest::
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-core --locked br_gap
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-index -p adom-store --locked
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-sources -p adom-search --locked
```

### Regressão da busca

```powershell
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-search --locked --test stream_frozen_parity -- --nocapture
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-search --locked --test stream_e2e_parity
cargo +1.92.0 test --manifest-path rust/Cargo.toml -p adom-search --locked --test search_budget_metadata
```

Não regenerar fixtures para fazer esses checks passarem. Os novos campos opcionais devem preservar a saída antiga quando não usados.

### Gate completo, antes do aceite do recorte

```powershell
cargo +1.92.0 fmt --manifest-path rust/Cargo.toml --all -- --check
cargo +1.92.0 clippy --manifest-path rust/Cargo.toml --workspace --all-targets --locked -- -D warnings
cargo +1.92.0 test --manifest-path rust/Cargo.toml --workspace --locked
cargo +1.92.0 build --manifest-path rust/Cargo.toml -p adom-napi --locked
npm run typecheck
npm run build
node --test dist/test/harvest-native.test.js dist/test/harvester-panel.test.js
npm test
npm run test:complete
npm run lint:lines -- --check
npm run lint:lines:rust
npm run test:adversarial
npm run test:ranking-challenger
git diff --check
```

- `npm test` recompila pelo pretest; isso é esperado. Não testar `dist/` após build vermelho.
- `test:adversarial` altera `dist/`: rodar isoladamente, nunca em paralelo com outro consumidor de `dist/`.
- Não copiar comandos antigos de harness que já não existem no `package.json`.
- Não truncar stdout de cargo com `Select-Object -First/-Last`; obter saída completa e exit code real.
- Nenhum teste importa `src/addon.ts`.
- Docker, smoke de rede real e validação de implantação são gates separados, somente numa execução explicitamente autorizada para esse ambiente. Este plano não sobe nem reconstrói o container atual.

## 7. Critérios de aceite e limites de afirmação

- [x] FULL sobrevive aos dois sentidos de coalescing, na fila e em voo.
- [x] Sucesso de sonda deixa uma FULL quando necessária; sucesso de FULL não duplica trabalho.
- [x] Falhas preservam modo e promoções, com três reinserções e quarta falha explícita.
- [x] Save/load não trunca retorno aceito; legado e JSON público continuam compatíveis.
- [x] Evicção por capacidade é deliberada e observável, nunca confundida com perda de intenção.
- [x] Sonda e FULL com resposta incompleta não certificam chaves novas como completas.
- [x] Found depende de delta gravado e viável; transição invalida somente a obra.
- [x] Prioridade, preview e evicção usam a mesma régua e snapshot; sem SQL no comparador ou rede com lock da fila.
- [x] BLUDV respeita kill-switch, prazo e SSRF; não entra na sonda nem no contador Jackett.
- [x] Config ao vivo existente continua funcionando; nenhuma nova API pública ou preferência de usuário é necessária.
- [x] Gates novos executam de fato e gates existentes passam, sem atualizar fixtures para esconder regressões. Evidência (2026-10-24, toolchain `+1.92.0`, um comando por vez, `$LASTEXITCODE=0`): `fmt --check`; `clippy -D warnings`; `test --workspace`; `build -p adom-napi`; `stream_frozen_parity` / `stream_e2e_parity` / `search_budget_metadata`; `typecheck`; `build`; `harvest-native`+`harvester-panel` 19/19; `npm test` 2495/2495; `test:complete`; `lint:lines --check`; `lint:lines:rust`; `test:adversarial`; `test:ranking-challenger`; `git diff --check`. Focados: `adom-harvest` 92/92, `adom-server harvest::` 56/56.
- [x] Documentação distingue código, validação local, implantação e limitações operacionais.

**Não coberto pelo aceite (5H / limites explícitos):** crash durante drain, replay exatamente uma vez, tentativas duráveis, transação entre todos os stores, fencing SWR, resposta sob SQLite corrompido, preempção intradrain e teto rígido por consulta. Esses itens impedem chamar a Fase 5 de operacionalmente idêntica ao oráculo.

## 8. Roteiro das fases restantes

A numeração abaixo mantém o vocabulário do plano anterior; a ordem de execução segue dependências, não o número da fase. Cada linha exigirá seu próprio detalhamento antes do código.

| Sequência | Frente | Próxima unidade de trabalho | Dependência / aceite |
|---|---|---|---|
| 1 | 5A–5G | Executar este recorte em checkpoints separados | Matriz da seção 7 e gates locais |
| 2 | Fases 3/4: contratos e propriedade | Refazer matriz serviço × método × chamador e processo × namespace/tabela × leitores/escritores | Código atual; não reutilizar matriz histórica como estado vivo |
| 3 | Fases 3/4: corte por serviço/estado | Resolver gaps dos adapters e transferir apenas um conjunto coerente de escritores/leitores por entrega | Auth/quota preservados, zero fallback silencioso, zero chamada dupla, readers do painel cobertos |
| 4 | Fase 7: autofetch/recheck | Migrar execução, holds, fila e reconciliação por conta, não só seletores puros | Dono de estado/adapters definido; aceite remoto com resposta perdida reconciliado; consumidor único |
| 5 | Fase 6 residual | Migrar ingestão `crawl-result`: identificação, record e confirmação | Motor dos nove sites já nativo; preservar S/E, idempotência e cerca contra escrita tardia |
| 6 | Fase 7: demais workers | Separar rd-warmer, dub-audit e varreduras em cortes próprios | Credencial/conta explícitas; kill-switches e confirmação para efeitos destrutivos |
| Transversal | Fase 2: metadados | Instrumentar incompletude nativa e fallback antes de remover a rota Node | Denominador de requests, corpus de falhas e janela observada; `name=IMDb` não conta como metadata completa |
| Hardening separado | 5H | Preempção/teto intradrain, inflight durável, consistência de restart e fencing de invalidação | Plano próprio de recuperação e fault injection; não embutir na correção FULL |

### Fases 3/4 — ordem interna obrigatória

1. Inventariar métodos reais de AllDebrid, TorBox, Premiumize, Real-Debrid e Debrid-Link por chamador: busca, play, autofetch, auditoria e painel.
2. Provar os envelopes de `known`, `cached`, `unusable:auth|quota`, erros HTTP, timeouts e métodos não suportados. `200 + unusable` não pode virar “desconhecido”.
3. Declarar dono de execução de `davail`, `mag:v1`/`mag_meta:v1`, inventário e holds. Regra em Rust não significa escritor nativo já transferido.
4. Migrar produtores e leitores correlatos na mesma fatia; impedir cache L1 antigo de regravar ou apagar estado novo.
5. Tratar `data/magnets.db` separadamente do magnetdb por conta. Verificar concorrência por tabela/coluna e read-modify-write real; namespaces distintos no mesmo SQLite não bastam para afirmar conflito.
6. Só remover corpo TS quando não houver chamador de produção nem fallback residual necessário. Rollback por imagem/commit compatível, com ensaio de dados quando o formato mudar.

`raw`, `idx`, `streams` e `harvest` já têm corte Rust: não reabrir esses motores apenas para uniformizar a migração.

### Fase 7 — unidade mínima de migração de worker

Cada worker entrega junto: seleção já existente + executor + contexto de conta + protocolo de aceitação remota + retomada/reconciliação + observabilidade. Teste central: serviço aceitou, resposta se perdeu, processo reiniciou — não submeter ou apagar duas vezes por suposição.

`dub-audit` permanece oportunista; torná-lo durável seria mudança de produto, não simples porte. Nenhum plano autoriza limpar conta ou habilitar switches destrutivos.

### Fase 6 — não refazer o que já migrou

Não planejar novamente Mico, `ownPace`, paginação dos nove sites ou remoção de `CRAWL_ENGINE`. A fronteira restante é ingestão/identificação/gravação e confirmação do resultado. Primeiro mapear os chamadores Node vivos e o contrato com o sidecar; depois cortar um fluxo verificável.

### Fase 2 — gate para retirar fallback

Instrumentação pode ocorrer em paralelo às outras frentes. Remoção exige janela representativa de observação e testes de falha: filmes, séries, episódio, aliases PT/EN, consultas incompletas e indisponibilidade nativa. Percentual baixo sozinho não basta: todo caso que ainda precisa do fallback deve estar explicado e coberto antes do corte. Coleta em ambiente real precisa de autorização própria.

### Alvo final do Node

Manter painel, `/configure` e fachadas administrativas justificadas. Apagar apenas I/O/rotas/workers que tenham sucessor nativo comprovado e nenhum consumidor restante. A meta não é “zero linhas TS”, mas regras e estado autoritativos bem definidos, sem caminhos duplicados de produção.

## 9. Rollback e entrega recomendada

Os campos novos são aditivos e omitidos quando inativos; o schema SQLite e os namespaces não mudam. Isso facilita leitura legada, mas não garante equivalência no downgrade: a imagem antiga ignora o snapshot FULL e contém os defeitos de coalescing descritos aqui.

Em uma implantação posteriormente autorizada, rollback é imagem/commit anterior, não env para reativar o colhedor TS. Antes de trocar a versão, pausar, aguardar o drain terminar e obter snapshot consistente da fila; não limpar fila ou índice para esconder incompatibilidade. Restaurar snapshot exige autorização e perde a janela posterior ao backup. A aprovação de implementação local não autoriza essa operação.

Implementar **5A + 5B**, validar e parar no checkpoint. Essa é a menor mudança que corrige o desaparecimento de FULL sem acoplar prioridade, fontes e estado de conta. Prosseguir depois com **5C → 5D → 5E → 5F → 5G**.

Este documento deixou de ser só planejamento: 5A–5G estão no working tree
validado. O commit local desta entrega não inclui WIP de painel/Jackett,
não altera `.env` e não faz push nem deploy. 5H continua fora.
