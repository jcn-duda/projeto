import { list, num } from './helpers.js';

// Fábricas (não objetos prontos): módulo ESM é cacheado, e cada re-avaliação
// do compositor src/config.ts (ex.: bust de cache nos testes) precisa reler o
// process.env — a chamada re-executa, o objeto de módulo não.
// Preferências de resultado (cotas, vagas BR, estilo do nome do stream).
export const searchSettings = () => ({
  // Dublado antes de legendado DENTRO da mesma qualidade. Ligado por padrão: o
  // diferencial do addon é conteúdo BR dublado, e desligado as cotas por
  // qualidade (max1080p e cia.) não distinguem áudio — três releases legendadas
  // do mesmo post enchiam a cota do 1080p e empurravam a DUAL para fora.
  preferDubbed: String(process.env.PREFER_DUBBED || 'true') === 'true',
  // `compact` deixa na coluna estreita do Stremio só qualidade/áudio/BR/seeds;
  // a release inteira fica no `title`, que é a coluna larga. `full` duplica a
  // release nas duas — só faz sentido em cliente que ignora o `title`, e custa
  // ~11 linhas de altura por stream no Stremio.
  streamNameStyle: process.env.STREAM_NAME_STYLE === 'full' ? 'full' : 'compact',
  // Mostra o indexer no `name`, além da linha de metadados. Alguns clientes
  // só exibem a fonte se ela vier neste campo, sem reconhecer o marcador ⚙️.
  streamNameShowSource: String(process.env.STREAM_NAME_SHOW_SOURCE || 'true') !== 'false',
  qualityFilter: list(process.env.QUALITY_FILTER),
  minSeeders: num(process.env.MIN_SEEDERS, 1),
  maxResults: num(process.env.MAX_RESULTS, 40),
  // 6 em todas: a página de configurar tem UM controle para as seis cotas, e
  // 6 era o número que o balde "unknown" (as fontes BR, que não publicam
  // resolução) já usava. Uniformizar por baixo encolheria BR sem motivo.
  qualityLimits: {
    '2160p': num(process.env.MAX_STREAMS_2160P, 6),
    '1080p': num(process.env.MAX_STREAMS_1080P, 6),
    '720p': num(process.env.MAX_STREAMS_720P, 6),
    '480p': num(process.env.MAX_STREAMS_480P, 6),
    SD: num(process.env.MAX_STREAMS_SD, 6),
    unknown: num(process.env.MAX_STREAMS_UNKNOWN, 6),
  },
  // Teto de streams por indexador no resultado final (0 = sem limite). Impede
  // que uma fonte com muitos resultados ocupe quase todas as vagas. As vagas
  // reservadas BR não contam para esta cota.
  maxPerIndexer: num(process.env.MAX_STREAMS_PER_INDEXER, 0),
  // Quantos candidatos considerar antes do filtro do debrid.
  candidatePoolFactor: num(process.env.CANDIDATE_POOL_FACTOR, 4),
  // Vagas garantidas para fontes BR dubladas no resultado final. "Garantidas"
  // ao pé da letra: elas atravessam a cota por qualidade E o teto por indexador,
  // e não consomem a cota -- as globais ficam com o balde inteiro delas. Só o
  // MAX_RESULTS as corta.
  brReservedSlots: num(process.env.BR_RESERVED_SLOTS, 6),
  // Reserva BR POR FAIXA de qualidade: com a reserva global, 1080p BR
  // abundante tomava todas as vagas e a faixa 4K/720p ficava sem BR mesmo
  // quando existia fonte. Garante até N BR (dublado primeiro) por balde de
  // qualidade antes de a cota da faixa ser preenchida por globais.
  // 0 restaura o comportamento de reserva única global.
  brReservedPerQuality: num(process.env.BR_RESERVED_PER_QUALITY, 1),
  // Se o orçamento normal terminou só com globais, espera um pouco pela
  // primeira fonte BR. Algumas UIs não repetem a resposta parcial, então o
  // passe tardio sozinho não torna o dublado visível na lista já aberta.
  brPartialGrace: num(process.env.BR_PARTIAL_GRACE_MS, 1500),
});

// Orçamento de tempo da busca — o invariante 1 é sagrado: o cliente Stremio
// aborta em 10s e toda a cadeia deriva destes prazos.
export const budgets = () => ({
  // Menor que o limite de 10s do cliente Stremio.
  searchTimeout: num(process.env.SEARCH_TIMEOUT_MS, 8000),
  // 10s é o teto dos DOIS clientes: o Stremio aborta a requisição de stream
  // nesse prazo e o Power Movie declara o mesmo (kStreamReceiveTimeoutSeconds).
  // 9200 usa a folga que sobrava e ainda deixa 800ms para rede e parse —
  // passar de ~9500 troca "lista parcial" por "erro de timeout", que é pior.
  replyDeadline: num(process.env.REPLY_DEADLINE_MS, 9200),
  // Fatia do deadline reservada pra checagem no debrid depois da coleta. O
  // 2800 antigo era dimensionado pela AllDebrid (270-290ms medidos) — mas quem
  // manda no prazo é o serviço mais lento da casa: Premiumize medido em
  // 1,9-4,7s no passo de resposta (mediana ~3,2s), e 2800 perdia a corrida na
  // maioria das buscas, degradando a lista inteira para known:false (sem ⚡
  // nenhum). 4500 cobre a mediana com folga e chega perto do pior caso; os
  // outliers de 6,5-7,5s ficam para o passe tardio, que re-checa sem teto
  // curto e regrava o cache. O custo é direto: a coleta cai de 6400 para
  // 4700ms, e fonte BR lenta passa a cair mais no passe tardio — que já é o
  // caminho dela (orçamento próprio de 20s). NÃO compense subindo o
  // REPLY_DEADLINE: o cliente Stremio aborta perto de 10s.
  debridReserve: num(process.env.DEBRID_RESERVE_MS, 4500),
  // Piso que a graça BR nunca invade: o que a checagem de cache precisa ter
  // sobrado, aconteça o que acontecer. Era literal (2000) dentro do cálculo da
  // graça, e por isso baixar a reserva encolhia a janela BR em vez de ampliá-la.
  debridCheckFloor: num(process.env.DEBRID_CHECK_FLOOR_MS, 1500),
});

export const search = () => ({
  // A busca complementar de pack fica no passe tardio: duas varreduras de
  // Jackett em série não cabem no deadline da resposta.
  packTail: String(process.env.SEARCH_PACK_TAIL || 'true') === 'true',
  // Episódio abaixo deste piso é fraco; o pack pode ter um swarm saudável.
  packMinSeeders: Math.max(0, Math.trunc(num(process.env.SEARCH_PACK_MIN_SEEDERS, 3))),
  // Sem uma fonte tocável, explica ao cliente por que a lista não ficou vazia.
  noticeStream: String(process.env.SEARCH_NOTICE_STREAM || 'true') === 'true',
});
