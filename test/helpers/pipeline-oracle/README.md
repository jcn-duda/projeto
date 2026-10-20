# Oráculo congelado do pipeline de debrid

Este diretório é a **cópia congelada** de `applyDebrid` e da decisão de saída
(`debrid-play-guard`) usada pelos testes como harness/oráculo. Ele existe para o
F4.4 poder remover o pipeline TS de busca sem apagar a suíte: os testes deixam
de importar `src/providers/debrid-pipeline*`/`debrid-play-guard` e passam a
importar daqui.

**Status (F4.4 executado):** o pipeline TS saiu do `src/`; este diretório é a
única cópia viva do `applyDebrid`/`play-guard` e continua sendo o alvo dos
testes e do harness adversarial (MUT-09 branding, MUT-10 `resolveUncached`).

## Origem

- Commit: `c11cb720` (branch `rust`), janela §9.4 ainda aberta — o F4.4 pulou a
  janela com autorização do operador e adotou o corpus congelado como gate.
- `debrid-pipeline.ts` = cópia de `src/providers/debrid-pipeline-core.ts`
  (arquivo removido do `src/` no F4.4).
- `debrid-play-guard.ts` = cópia de `src/providers/debrid-play-guard.ts`
  (arquivo removido do `src/` no F4.4).
- `types.ts` = cópia de `src/providers/debrid-pipeline-types.ts` (o tipo
  correspondente no `src/` virou `debrid-apply-types.ts` por causa do rename).
- `debrid-check-frozen.ts` = cópia de `src/providers/debrid-check-frozen.ts`
  (removido do `src/` no F4.4; só o `applyDebrid` o consumia).
- `index.ts` = barrel da superfície pública do oráculo.

O corpo das funções é idêntico ao original (mesma ordem de ramos, mesmos
comentários e constantes); só os caminhos de import mudaram, porque o oráculo
mora um nível abaixo de `test/helpers/`.

## Fronteira

Entram apenas as dependências que **sobrevivem** ao corte: `autofetch*`,
`debrid/*`, `runtime`, `cache`, `format`, `episode-size`, `dub-audit`,
`debrid-cache-steps`, `stream-trace` e o núcleo nativo. `debrid-check-frozen`
também é cópia local (o único consumidor era o `applyDebrid`). Não entram
`search-orchestrator`, `search-cache`, `search-commit`, `stream-builder*`,
`tail-enqueue` nem o resto do pipeline de busca.

## Regra

Não edite estes arquivos para "acompanhar" produção. A regra nova mora no
núcleo Rust (`adom_core::play_disposition` e o pipeline nativo); este diretório
preserva o contrato que os testes medem. Se um teste precisar de comportamento
real do pipeline (e não do oráculo), ele deve ser tratado no F4.4, não
enfraquecido aqui.
