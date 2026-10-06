# Plano de melhoria dos raspadores — validação local

Data: 06/10/2026. Base: branch `esm`, HEAD `14cece9`.

## 1. Objetivo e limites

Evitar perda silenciosa de cobertura, associação de obra incorreta e avanço
indevido de cursor, preservando o motor multi-site e seus contratos atuais.

O pedido inicial entregou **plano e testes locais**, sem implementação.
Em 06/10/2026 a implementação foi autorizada, com **commit por parte e validação
somente local**. Não acessar VPS/produção, fazer deploy/push, ativar fontes,
alterar `.env`, limpar cache/acervo, gravar vereditos de sonda ou executar
reparação em dados reais.
Fixtures, mocks e bancos temporários isolados são a base da validação atual.
Não executar `smoke`, testes de resolver contra sites reais ou sonda externa.

Preservar alterações anteriores em `TEAM.md`, `team/adom-team.json`,
`package.json`, `package-lock.json` e arquivos não rastreados. O override local
de `proxy-addr` faz parte do ambiente testado, não desta entrega.

Não declarar os raspadores "perfeitos": aprovação offline não demonstra que
domínios, HTML, protetores e catálogos externos continuam funcionando hoje.

## 2. Estado de referência

- **Já entregue:** NerdFilmes migrou para `www.xfilmeshd.org` no commit
  `4feb825`, incluindo allowlist, defaults e limpeza de título. O bloqueio
  observado em 05/10 não deve ser apresentado como pendência atual do código.
- **Já entregue:** TheRARBG recuperado por headers no commit `5c7e3d9`.
  Trata-se de indexer, não de um dos nove raspadores desta matriz.
- **Achados históricos reproduzidos no checkout de `1241204`:** filtro de widget IMDb
  de HDR/Apache e descoberta mista com sitemap ilegível em Vaca/Comando.
  Reproduções no checkout atual serão registradas abaixo, separadamente.
- **Limite operacional histórico:** busca do Apache redirecionava para a home,
  mas listagens e páginas com magnet funcionavam. Não pressupor que a busca
  voltou, nem que o crawler depende dela. Sem nova medição externa nesta etapa.
- **Instabilidade observada:** teste do teto horário do colhedor falhou uma vez
  e passou em duas repetições. Causa não diagnosticada; interferência entre
  arquivos por estado de módulo foi descartada devido ao isolamento de processos.

### Classificação dos achados na auditoria de `14cece9`

| Achado | Evidência | Impacto e prioridade |
|---|---|---|
| Widget IMDb HDR/Apache | reproduzido em funções reais com fixtures | P0: perda de cobertura e associação espúria no banco; filtros posteriores mitigam a exibição errada |
| Sitemap desconhecido nas quatro fontes | reproduzido até `advanceCursors` com engine de memória | P0: descoberta incompleta pode avançar cursor sem avisar |
| Custo de série Mico | reproduzido com fetch stub | P1: tentativa falha não contabilizada; custo de metadado depende do contrato de orçamento |
| Listagem com cards brutos e zero aceitos | chamada da função real com transporte injetado, sem rede: `posts=[]`, `cardCount=20` consumiu página sem failure | P1: distinguir quebra de parser de filtros legítimos antes de corrigir |
| Tipo deduzido de slug, comentários HTML e widget IMDb do Nerd | lacunas estáticas/hipóteses; `nerdfilmes-discovery.ts` aceita IMDb único sem a guarda específica de Comando | criar fixtures e demonstrar impacto antes de mudar régua |
| `tracker` e comentários de manutenção | consistência de implementação | P2: não devem atrasar correções de integridade |

P0/P1 são prioridades de execução do plano. Não há evidência nesta rodada de
que todas as páginas reais de uma fonte sofram o defeito. Nenhum acervo real foi
inspecionado ou alterado para dimensionar contaminação/perda.

## 3. Ordem de execução futura

| Etapa | Prioridade | Entrega | Dependência | Esforço relativo |
|---|---|---|---|---|
| A | P0 | Fixar reproduções e contratos de identidade/cursor | baseline local | pequeno |
| B | P0 | Corrigir filtro IMDb HDR/Apache | A | pequeno |
| C | P0 | Blindar descoberta de sitemaps | A | médio |
| D | P1 | Robustez de paginação, viewer e filmes/séries | B/C | médio |
| E | P1 | Custos, concorrência e recuperação do motor | A e evidências | médio |
| F | P1 | Diagnóstico operacional e testes estáveis | C/E | médio |
| G | P1 | Prévia de recuperação seletiva de cobertura | B/C/D validados | médio |
| H | gate futuro | Sondas por fonte antes de ativação | B–G e autorização | variável |

P0 significa prioridade de integridade do acervo, não constatação de corrupção
generalizada nem autorização para mudar dados. Implementar uma unidade por vez,
sem refactor amplo e sem abstrações de crawler sem consumidores reais.

## 4. A/B — Identidade da obra

Alvos principais:
`src/providers/crawl-sites/hdrtorrents-discovery.ts`,
`src/providers/crawl-sites/apachetorrent-discovery.ts`,
`src/providers/crawl-page.ts`, `src/providers/crawl-recorder.ts`.

1. Reproduzir `parseImdbId` com plugin `?ref_=tt_plg_rt`, link canônico, ambos,
   múltiplos IDs canônicos, ausência de ID e variações de query/HTML.
2. Excluir referências de widget antes de contar IDs únicos. Usar o precedente
   de Comando/Rede, sem lista de títulos proibidos ou confiança em qualquer `tt`.
3. Plugin sozinho deve produzir `null` e permitir identificação por título/ano;
   canônico + plugin deve preservar o canônico; ambiguidade deve continuar `null`.
4. Exercitar a página até o recorder com metadados mockados, verificando IMDb,
   `passedFilter`, índice e estado final, incluindo homônimos e ano contraditório.
5. Não relaxar o filtro de título para transformar zero releases em sucesso.

Aceite: nenhum IMDb de widget é usado como identidade; os casos corretos não
perdem o ID; falha temporária de identificação é retentável, sem `done` prematuro.

Testes-alvo: `test/crawl-hdrtorrents.test.ts`,
`test/crawl-apachetorrent.test.ts`, `test/crawl-recorder.test.ts` e
`test/crawl-recorder-integration.test.ts`.

## 5. A/C — Descoberta e segurança do cursor

Alvos: `crawl-sites/vaca.ts`, `nerdfilmes.ts`, `torrentdosfilmes.ts`,
`comandotorrents.ts`, seus módulos de discovery, `crawl-cursor.ts` e
`crawl-step.ts`, em `src/providers/`.

Separar quatro situações **antes** do filtro incremental:

1. Documento reconhecido, com entradas, sem novidade após `since`: sucesso vazio.
2. Documento ilegível, interstitial/desafio ou layout desconhecido: falha parcial.
3. Documento reconhecido sem entradas: anomalia de descoberta; nunca avançar
   como se o acervo tivesse sido lido, salvo contrato explícito de vazio legítimo.
4. Documento com entradas mas sem obras do tipo esperado: diferenciar sitemap
   dedicado de sitemap misto; não copiar a guarda do Rede cegamente para os mistos.

Em falha de um filho, preservar URLs já descobertas e o custo real, mas marcar
incompleto o tipo afetado e impedir seu avanço de cursor. Em sitemap misto sem
evidência de qual tipo foi perdido, bloquear ambos conservadoramente. O cursor
de outro tipo só pode avançar quando houver prova independente de completude.

Cobrir XML cru, CDATA, tabela viewer, `&amp;`, `<image:loc>`, datas ilegíveis,
timezones, URLs duplicadas, host externo e limite/timeout de leitura. A identidade
de página continua `(site, url_key)`, sem host.

Aceite central: filho válido + filho HTTP 200 ilegível **não** produz avanço de
cursor do conjunto incompleto; todos ilegíveis geram falha; sem novidades válidas
não cria retry eterno. Validar o resultado até `advanceCursors`, não só o parser.

## 6. D — Filmes, séries, packs e paginação

- Não usar a palavra `temporada` no slug como prova final de série quando o
  conteúdo a contradiz. Primeiro reproduzir o caso; depois corrigir a régua.
- Manter `dn=` como evidência prioritária da locação quando a página agrega
  temporadas; descartar linhas sem evidência em vez de enviá-las à raiz.
- Pack completo de temporada não pode carregar episódio fictício no título.
- Preservar os dois formatos do HDR: temporada declarada na página e página
  agregada. Avaliar se Apache também exige agrupamento por linha em fixtures.
- Mico: manter passos fixos 25/50, reconsulta de vazia intermitente, limite por
  vazias consecutivas e `Retry-After`; nunca voltar a avançar por `metas.length`.
  `test/crawl-mico.test.ts` e `test/crawl-mico-series.test.ts` já cobrem grande
  parte desse contrato: estender somente custo/falha, cache de metadado e
  cenários ainda ausentes, sem reescrever os testes verdes de paginação/retomada.
- Listagens: fim por evidência/contagem de cards brutos; âncora só no incremental.
  Testar páginas repetidas, redirecionamento para home, páginas intermediárias
  vazias, fim real e mudança do gate de séries invalidando cursor incompatível.
  Reproduzir `rawCards > 0` com zero `pageKeys` em `listing-discover.ts` antes
  de alterar a guarda: quebra de parsing/host não equivale a posts parseáveis
  excluídos legitimamente por tipo. Não transformar todo `urls=[]` em erro,
  nem usar a contagem de resultados filtrados para concluir fim do catálogo.

Aceite: cada release fica na obra/tipo/S/E comprovados, sem episódio inventado,
salto de catálogo, encerramento falso de carga ou mistura de progresso seco/vivo.

## 7. E — Motor, custos e persistência

Preservar os contratos existentes; ampliar testes onde a concorrência real não
é coberta, sem reimplementar a fila ou criar outro serviço.

- Falha de flush ou fila cheia: nada de half-write e nada de página `done`.
- Restart e `enabled: false → true`: recuperar órfãos antes de `takeNext`.
- `dryRun → live`: reprocessar progresso seco; preservar progresso vivo válido.
- Concorrência: máximo global respeitado, um trabalho ativo por site e faixa
  Flare exclusiva. Transporte fake com promises controladas deve provar isso.
- Tráfego do usuário, pausa, erro e starvation: testar retomada e liberação de
  slots em `finally`, sem timers de parede longos ou loop de espera.
- Cursor/URL/progresso: nunca persistir como concluído um lote que não foi
  gravado; preservar independência de sites e tipos.
- Mico: medir requests iniciados, falhos, metadados e episódios. Não somar
  requisição de metadado servida de cache como se tivesse ido à rede.
  Primeiro explicitar se o orçamento é do site Mico ou de toda a rede do passo:
  requisição Mico falha deve ser contada em ambos; metadado de Cinemeta pode
  exigir contador separado e cache compartilhado não pode pagar duas vezes.

Aceite: contadores e limites refletem o contrato de custo escolhido e testado;
nenhuma falha silenciosa perde URL ou mantém slot ocupado indefinidamente.
Validar em engine de memória e SQLite temporário, incluindo reabertura do banco.

Cobertura existente a estender, não duplicar: `test/crawl-dispatch.test.ts`
(faixa/seleção), `test/crawl-select-starvation.test.ts` (fome),
`test/crawl-boot-enable.test.ts` (boot), `test/crawl-recorder.test.ts` e
`test/crawl-recorder-integration.test.ts` (gravação/barreira),
`test/crawl-series-resume.test.ts` (retomada). Casos novos devem demonstrar
combinações/falhas não cobertas, com asserts de estado e transporte controlado.

## 8. F — Observabilidade e estabilidade dos testes

- Reportar por fonte e tipo: última descoberta, completude, cursor, fila,
  progresso, pausa, erros por motivo e resultado/data/escopo do probe.
- Diferenciar desconhecido, não testado, desativado, bloqueado e falha. Card de
  saúde verde não comprova que o raspador está ativo ou que a sonda passou.
- Dar visibilidade a sitemap não reconhecido, linhas sem identidade/locação e
  gravação recusada, sem incluir cookie, token, magnet completo ou protetor.
- Viewer: fixtures com datas/entidades/coluna de imagens e equivalência XML.
- `parseImdbId` do Nerd merece uma fixture de widget único e outra com IMDb em
  comentário; é lacuna estática, não uma nova falha viva demonstrada. Correção
  só depois da reprodução, preservando a âncora legítima e identificação segura.
- Colhedor: preservar log integral na próxima falha; injetar relógio somente
  após reproduzir a causa. Testar virada de hora e isolamento de estado no próprio
  processo, sem culpar arquivos executados em processos diferentes.
- Ajustes cosméticos (`tracker` de HDR/Apache, comentários antigos de Mico)
  ficam depois das correções de integridade, sem mudar classificação BR.

## 9. G — Recuperação seletiva, sem limpeza global

Esta etapa é **proposta**, não executada nem autorizada a escrever dados agora.

Depois dos fixes, gerar prévia por `(site, url_key)` das páginas suspeitas de
widget/kind incorreto e dos intervalos de descoberta potencialmente omitidos.
Não assumir que todo IMDb de HDR/Apache é inválido. A seleção exige evidência.

Antes de aplicar: backup consistente, lock, lista explícita de linhas e plano
de ação, teste em cópia temporária e revisão. Reenfileirar somente o conjunto
afetado, corrigir associações comprovadas sem apagar magnets/sources alheios,
preservar releases válidas e provar idempotência. Reversão por snapshot/manifesto.
Não usar "Zerar site", reset global ou limpeza de debrid como atalho.

## 10. Matriz mínima por fonte

Todas precisam de fixtures de filme e série, identificação e host safety.

| Fonte | Descoberta | Casos distintivos obrigatórios |
|---|---|---|
| Vaca | sitemap | XML/viewer, direto→Flare por desafio, protetor, retomada de série |
| NerdFilmes | sitemap misto | domínio novo, títulos novos, gate 400 vs timeout, temporada |
| TorrentDosFilmes | sitemap misto | ano no meio, IMDb de plugin ignorado, magnet direto |
| ComandoTorrents | sitemap misto | plugin ignorado, protetor, classificação de tipo |
| RedeTorrent | sitemap | dois formatos, zero parcial, temporadas agrupadas por linha |
| BLUDV | sitemap misto | desafio, arquivo ilegível, série/pack, custo e faixa Flare |
| HDRTorrent | listagem | fim real/âncora, widget IMDb, temporada e página agregada |
| ApacheTorrent | listagem | widget IMDb, paginação; crawler independente da busca do site |
| Mico | API | skip 25/50, vazias, 429, custo/cache e retomada por episódio |

Nenhuma linha desta matriz equivale a aprovação dos sites externos hoje.
No Nerd, incluir também o teste de hipótese de widget/comentário indicado em F;
no Mico, reaproveitar a cobertura verde existente e acrescentar apenas lacunas.

## 11. Gates de implementação futura

1. Escrever regressões que falhem antes de cada correção e passem depois.
2. Rodar `npm run typecheck`, `npm run build`, testes focados, `npm test`,
   `npm run test:complete`, `npm run lint:lines -- --check`, `git diff --check`.
3. Novo `.test.ts` deve entrar em `testFiles` pelo nome compilado `.test.js`.
   Teto 400 linhas sem `--bless`.
4. Ao editar testes/parsers/resolvers, seguir os seis harnesses de AGENTS antes
   e depois conforme o escopo. `test:adversarial` muta `dist/`: execução serial,
   snapshot/restauração e nenhum outro consumidor do emit durante o processo.
5. Nenhuma rede inesperada nos testes novos: fetch de host não mapeado deve falhar.
6. Integração de Docker, se necessária: container de teste com volumes temporários
   e sem credenciais de conta. Não reconstruir/tocar o container vivo por padrão.
7. Review independente dos contratos de identidade, cursor e persistência.

### Reversão por etapa

Separar B, C, D e E em alterações independentes, sem misturar recuperação de
dados com mudança de parser. Se um gate reprovar, não ativar a fonte afetada e
preservar fila, cursor anterior e evidências para diagnóstico. Retirar somente
o patch da etapa em uma nova alteração revisada; não usar reset do checkout nem
reverter mudanças locais alheias. Não voltar automaticamente a um parser sabido
inseguro para "ficar verde". A recuperação G exige backup e manifesto próprios;
reverter código não desfaz associações ou cursores já gravados.

### Gate externo futuro, fora da execução atual

Somente após autorização, medir a sonda de 40 por fonte, sem `--write` por padrão,
com representação explícita de filmes e séries e relatório por tipo. Um agregado
GO não pode esconder série sem amostra. Registrar denominador, erros, cobertura,
latência/custo e limite inferior de Wilson (gate existente ≥ 50%). Amostras só de
sucesso não valem. Falha sistêmica de formato/identidade bloqueia ativação.

Ativar uma fonte de cada vez somente após GO vigente; manter `CRAWL_REQUIRE_PROBE`
quando exigido. BLUDV por último, em janela ociosa/madrugada; Flare em faixa única.
Não presumir que série ligou ou que probe de uma versão valida outra versão.

## 12. Validação realizada nesta entrega

Execução local em `14cece9`, com as alterações locais preexistentes preservadas:

| Comando | Resultado |
|---|---|
| `npm run typecheck` | passou; os comandos seguintes só executaram com saída zero |
| `npm test` (inclui build via `pretest`) | 3.968 testes, 319 suites, 3.968 passou, 0 falhas |
| `npm run test:complete` | 406 arquivos registrados, 10 harnesses validados |
| `npm run lint:lines -- --check` | 888 arquivos, 0 acima do teto |
| `git diff --check` | passou antes da criação deste plano |
| Seleção específica dos raspadores | 100 arquivos, 1.180 testes, 1.180 passou, 0 falhas |
| `harvester.test.js` repetido em processos novos | 5/5 rodadas; 9/9 testes em cada uma, sem falha |
| Testes focados de listagem (agente novo) | `crawl-listing-discover`, `crawl-listing-false-end` e `crawl-listing-cursor`: 53 passaram, 0 falharam |
| Reproduções adicionais offline | IMDb, quatro fábricas de sitemap e custo Mico reproduzidos; ver quadro abaixo |

Os dez harnesses validados por `test:complete` são conferência de integridade,
não declaração de execução dos seis scripts nesta rodada. Nenhum teste externo,
VPS, deploy, ativação, escrita de probe, reparação de banco ou commit foi feito.

Na suíte completa o runner reportou `duration_ms 21159.9918`; na seleção,
`21777.1201`. São durações do runner, não o tempo total incluindo compilação.
O teste intermitente do colhedor não falhou na suíte, seleção ou cinco repetições;
isso não prova
que a instabilidade histórica foi corrigida.

Seleção local reproduzível (após build verde; comando em uma linha):

```powershell
node --input-type=module -e "import {createRequire} from 'node:module'; import {spawnSync} from 'node:child_process'; const require=createRequire(import.meta.url); const p=require('./package.json'); const f=p.testFiles.filter(x=>/crawl|crawler|harvest|mico|work-name|sitemap|listing|vacatorrent|nerdfilmes|apachetorrent|hdrtorrent|redetorrent|bludv|torrentdosfilmes|comandotorrents|index-only|dashboard-actions-crawl/.test(x)); const r=spawnSync(process.execPath,['--test','--import','./dist/test/setup-env.js',...f.map(x=>'dist/'+x)],{stdio:'inherit',env:{...process.env,DOTENV_CONFIG_PATH:'test/fixtures/env-empty',CACHE_PERSIST:'false'}}); process.exit(r.status??1);"
```

`setup-env` isola `.env` e magnets em temporários por processo; as reparações
executadas pela suíte usam bancos de teste. Não rodar esses scripts manualmente
com caminhos de `docker-data` durante a validação offline.

### Reproduções de bugs existentes, separadas da suíte verde

Chamadas de funções reais em `dist/`, com transporte injetado, sem rede externa
e com store em memória para os cursores. Não foram adicionados testes permanentes
nem aplicada correção de código; os cenários abaixo descrevem o comportamento
atual defeituoso. A implementação futura deve convertê-los em regressões.

| Cenário | Resultado atual |
|---|---|
| IMDb: único `tt1959490/?ref_=tt_plg_rt` | HDR/Apache devolvem `tt1959490`; Comando/Rede devolvem `null` |
| IMDb: link canônico `tt0340163` | os quatro preservam `tt0340163` |
| IMDb: canônico + plugin | HDR/Apache devolvem `null`; Comando/Rede preservam `tt0340163` |
| Índice com filho válido 09/30 + filho HTML desconhecido 200 | Vaca/Nerd/TDF/Comando: `complete=true`, zero failures, uma URL, cursor movie avança |
| Sitemap ALLUNKNOWN | quatro fontes: zero URLs e `complete=true`, sem max e sem avanço; falha não sinalizada |
| Sitemap válido, sem novidades após `since` | zero URLs, completo; precisa continuar sendo sucesso legítimo |
| Filho lança erro HTTP 500 | quatro fontes sinalizam incompleto/failure e bloqueiam avanço afetado |
| Cursor movie futuro e tv `null` | série antiga continua descoberta; os tipos estão corretamente independentes |
| Mico ep2 falha após ep1 válido, metadado frio | `requestCost=1` para três fetches: um metadado, dois streams |
| Mico ep1 falha, metadado frio | `requestCost=1` para dois fetches: um metadado, um stream |
| Mico metadado devolve `null` | erro com `requestCost=0` para um fetch de metadado; motor aplica piso próprio |
| Mico dois episódios válidos, metadado frio | `requestCost=2` para três fetches; metadado não incluído |
| Listagem: leitor devolve `posts=[]`, `cardCount=20` | `complete=false`, `failures=[]`, `pagesConsumed=1`, cursor 1→2, `reason=already-seen-page`, zero URLs |

O filtro de título posterior mitiga IMDb de outra obra na lista/índice, mas não
evita que a identificação por título seja pulada e que a URL termine associada
ao IMDb inadequado. Não descrever esse achado como corrupção generalizada de
streams. A prova do custo Mico não autoriza somar metadados cegamente sem definir
semântica de orçamento e cache.

Na reprodução de listagem, o catálogo **não** foi declarado completo. O risco
é consumir a página sem sinalizar erro, não um `complete=true` demonstrado. O
controle de posts parseáveis excluídos legitimamente por tipo ainda precisa ser
adicionado; a evidência não justifica a regra genérica "zero aceitos = erro".

As reproduções adicionais de descoberta foram feitas em Vaca/Nerd/TDF/Comando,
não em Rede/BLUDV nesta rodada. Estes últimos participaram da suíte mockada e
da revisão de código; não atribuir a eles uma nova medição externa ou a mesma
reprodução de descoberta sem execução específica.

Revisões finais: documental e arquitetural aprovadas. Ajustes de terminologia,
paths, cobertura existente e hipóteses não reproduzidas foram incorporados.
A aprovação técnica foi do plano. A autorização posterior permite implementar
e commitar por parte, mas não ativar fontes nem executar o gate externo.

## 13. Definition of done do plano

- Correções entregues em etapas pequenas, todas com regressão e review.
- Identidade não vem de widget; sitemap desconhecido não deixa cursor avançar.
- Séries/filmes/packs preservam identidade, locação e retomada comprovadas.
- Fila, custo, restart e concorrência passam nos cenários de falha isolados.
- Recuperação de cobertura é seletiva, revisável e idempotente, não destrutiva.
- Saúde offline e saúde externa ficam explicitamente separadas no relatório.
- Nenhuma fonte é ativada só porque a suíte ficou verde.

## 14. Execução autorizada por partes

Registro incremental; a seção 12 descreve o baseline anterior às correções,
não o resultado do código final. Commits locais, sem push ou ativação de fontes.

| Parte | Estado | Commit | Validação local |
|---|---|---|---|
| Plano e baseline | concluído | `7caad28` | baseline e seis harnesses antes das edições |
| 1 — identidade IMDb HDR/Apache | concluída | `af5c7a8` | regressões antes/depois, 125 focados, compatibilidade de caminhos/query/host móvel; review aprovado |
| 2 — sitemap parcial e cursor | concluída | `83155f6` | RED nos quatro adaptadores, 83 focados; cursores reais em memória e review aprovado |
| 3a — listagem e escopo/contagem bruta | concluída | `7a70d64` | 71 focados e 3.996 testes completos; bloqueador de host resolvido e review aprovado |
| 3b — comentários, tipo e rótulo da fonte | concluída | `09b5140` | regressões locais; 4.000/4.000 testes, boot focused 14/14; review aprovado |
| 4 — custo e contratos do motor | concluída | `9c761c3` | regressões RED→GREEN, 4.008/4.008 testes, typecheck/build, lista 409/10 e lint 894 |
| 5a — motivo de sitemap desconhecido | concluída | `5f4a68e` | 92 focados; 4.010/4.010 testes; typecheck/build, lista 409/10, lint 894 e review aprovado |
| 5b — flake de teto horário | sem patch | — | execução histórica não reproduzida; não atribuir causa |
| 5c — casos adicionais do viewer | planejado | — | auditoria não encontrou bug; cobertura atual parcial documentada |
| 6 — prévia seletiva offline | concluída antecipadamente | `3a0482b` | teste de manifesto/CLI/bancos temporários e auditoria independente aprovada; sem apply |

Após as partes 1/2 e a prévia, os gates foram repetidos pelo coordenador sem
builders concorrentes: **3.988/3.988 testes**, typecheck, build, lista de
408 arquivos/10 harnesses e lint de 893 arquivos passaram. Uma rodada anterior
foi invalidada por limpeza concorrente de `dist/` (`ERR_MODULE_NOT_FOUND`); ela
não foi usada como evidência de aprovação.

A prévia aceita apenas evidências explícitas de um manifesto `evidence/v1` e
propõe reenfileiramento; não há executor de reparação. Não deduz contaminação só
por um IMDb/site. Os testes verificam imutabilidade de DB/WAL; para `-shm`, a
garantia testada é de tamanho, não de conteúdo byte a byte. Uma futura aplicação
exige backup/lock/revisão própria e continua fora da execução atual.

Etapa H permanece fora do escopo: nenhum site real foi sondado ou liberado com
`--write`, nenhuma fonte foi ativada, nenhuma VPS foi acessada e nenhum acervo
real foi reparado. As mudanças locais anteriores em packages/TEAM/team foram
preservadas; só o registro de teste pertinente entrou no commit de cada parte.

Após a Parte 5, o coordenador repetiu serialmente: **4.010/4.010 testes**,
typecheck, build, 409 arquivos/10 harnesses e lint de 894 arquivos/zero acima
do teto. Os seis harnesses adicionais também passaram em série: stress 154;
adversarial 10/10 mutações, 20/20 sequenciais e 6/6 workers; adversarial M1
69; protector 42; challenger M2 11; ranking 13.

A falha histórica em `harvester.test.ts` ocorreu em uma execução e não voltou a
aparecer nas cinco repetições locais subsequentes. A análise causal delegada
atingiu limite de execução; a hipótese relacionada a virada de hora refere-se a
outro teste e não foi provada como causa. Portanto, não foi alterado o colhedor
nem o relógio do teste. Para o viewer do Vaca, a análise não encontrou defeito
confirmado; `&amp;`, fusos adicionais, datas inválidas e empate com cursor foram
registrados como lacunas de fixtures, não como bugs. Nenhum desses casos teve
mudança de comportamento ou teste novo nesta etapa.
