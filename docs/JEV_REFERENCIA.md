# Jev / TypeSafe System One — referência do serviço

> **Recorte deste documento.** Manual do **serviço**, não do Adom. Descreve o
> que o Jev é, o que ele aceita, o que devolve e onde erra — independente de
> como este projeto o usa. Para o uso no Adom (probes `dub-lie` e
> `audio-classify`, runtime shadow, corpora e resultados medidos), ver
> [`TYPESAFE_SYSTEM_ONE.md`](TYPESAFE_SYSTEM_ONE.md).
>
> **Snapshot de 2026-09-22**, extraído da documentação oficial
> (<https://docs.typesafe.ai>). Preço, limites de taxa e comportamento do
> modelo mudam sem aviso — a página [Models](https://docs.typesafe.ai/models)
> é a fonte viva. A doc inteira em markdown está em
> <https://docs.typesafe.ai/llms.txt> (índice) e `llms-full.txt` (~910 KB).

---

## 1. O que é

Um **System One model** é uma classe de modelo treinada para tomar decisões
**estruturadas e rápidas que software consome direto**. O **Jev** é o modelo
principal da TypeSafe e o primeiro dessa classe.

O problema que ele ataca: um LLM é feito para produzir texto para humano ler.
Quando você precisa de um julgamento que o *seu código* vai consumir, usar um
LLM significa forçar um gerador de texto a cuspir decisão estruturada e depois
parsear de volta. O Jev corta o meio de campo — devolve valor tipado e
distribuição de probabilidade, sem geração de texto e sem parsing.

O nome vem do *Thinking, Fast and Slow* do Kahneman: System 1 é o julgamento
rápido e intuitivo; System 2 é o deliberado. A ênfase aqui é julgamento rápido
e focado.

**O que ele NÃO faz:** não escreve resposta, não gera código, não explica o
raciocínio dele. Só aceita texto (string, objeto JSON ou array de textos) —
imagem, áudio e vídeo não são suportados.

**Calibração.** As probabilidades são otimizadas contra desfechos reais para
refletir incerteza. Importante: calibração é medida **em grupos de predições**
— ela não garante que uma resposta individual esteja certa.

---

## 2. Os três primitivos

Toda pergunta é de um de três tipos. Os três podem ser misturados numa mesma
chamada.

| Tipo       | Pergunta                        | Devolve                             |
| ---------- | ------------------------------- | ----------------------------------- |
| **Noul**   | Esta afirmação é verdadeira?    | `noul` (0–1)                        |
| **Choice** | Escolha uma opção da lista      | `choice`, `probabilities`, `confidence` |
| **Score**  | Pontue o estado numa rubrica    | `score`, `probabilities`, `legend`, `confidence` |

Cada pergunta é avaliada **em paralelo e em isolamento** contra o mesmo estado,
numa única passada. Consequências práticas:

- acrescentar perguntas quase não muda o tempo de resposta;
- como cada uma é avaliada isolada, não existe *context rot* entre elas;
- o `state` é ingerido uma vez só para todas.

### 2.1 Perguntas atômicas, compostas no código

É o princípio de design central do serviço. Cada pergunta deve pedir **uma
coisa específica e bem delimitada** — o tipo de julgamento que uma pessoa muito
bem informada faria em poucos segundos com o contexto certo.

Se a pergunta exigiria raciocínio longo ou pesa vários fatores independentes,
**decomponha**: pergunte cada fator separado e combine no seu código. Em vez de
"avalie este pitch de startup", pergunte tamanho de mercado, viabilidade
técnica e diferenciação em três perguntas, e componha com a sua fórmula. Quando
a prioridade mudar, você muda um coeficiente no código em vez de reescrever
prompt.

---

## 3. Estado (`state`)

É o conteúdo que você manda avaliar. Cada requisição avalia **um** estado
contra uma ou mais perguntas, e todas as perguntas enxergam o mesmo estado.

| Formato | Serve para                                   | Exemplo |
| ------- | -------------------------------------------- | ------- |
| String  | Uma mensagem, artigo ou trecho               | `"Meu cartão foi cobrado duas vezes."` |
| Objeto  | Campos nomeados, registros, estado do app    | `{"message": "...", "order_id": "A-104"}` |
| Array   | Sequência de mensagens ou registros          | `["Oi", "Meu número é TS1337.", "..."]` |

A recomendação oficial é **usar objeto na maioria dos casos**, para que cada
parte do estado tenha nome descritivo e as relações fiquem claras. String serve
quando o caso é simples e só há um texto.

A metáfora da doc: o estado é o material que você apresentaria a um painel de
especialistas antes de pedir um julgamento. Informação relacionada anda junta
num mesmo estado — um ticket, o pedido e a política de reembolso são **um**
estado só, quando a decisão exige comparar as três partes.

**Separe conteúdo de pergunta.** O estado carrega o conteúdo e os fatos de
apoio; as perguntas definem os julgamentos sobre esse material.

**Idioma.** O inglês é a língua primária de treino e onde a acurácia é melhor.
Outros idiomas, incluindo escritas CJK, são aceitos mas com acurácia menor —
a doc recomenda testar no seu próprio conteúdo antes de confiar, e olhar
confiança de perto ao rotear.

---

## 4. Formato da pergunta

Toda pergunta tem `type` e `instructions`; cada tipo acrescenta seu `criteria`.

`instructions` aceita **string, objeto ou array**. Uma pergunta longa que
precisa referenciar dados pode virar objeto: a pergunta num campo, os dados nos
outros, referenciados por nome entre crases.

```json
"instructions": {
  "potential_duplicate": {
    "name": "John Smith",
    "location": "Oakland, California",
    "last_employer": "Google"
  },
  "question": "Is the resume for the same person as `potential_duplicate`?"
}
```

### 4.1 Noul

`criteria` é **opcional**, com as chaves `true` e `false` descrevendo o que
significa cada lado.

```json
{
  "type": "noul",
  "instructions": "Does this convey urgency?",
  "criteria": {
    "true": "Explicitly time-sensitive",
    "false": "No urgency expressed"
  }
}
```

### 4.2 Choice

`criteria` é **obrigatório**: mapa de opção → descrição (`null` quando a opção
dispensa detalhe). **Máximo de 255 opções.**

### 4.3 Score

`criteria` é **obrigatório**: array **ordenado** de descrições de nível.
Mínimo de 2 níveis, **máximo de 10**.

---

## 5. Formato da resposta

Uma entrada em `answers` por pergunta, sob as mesmas chaves que você escolheu.
A chave **não é enviada ao modelo** e não participa da inferência.

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.95 }
  },
  "usage": { "input_tokens": 296, "output_tokens": 20 }
}
```

| Tipo   | Campos da resposta |
| ------ | ------------------ |
| Noul   | `noul` (0–1). **Sem `confidence`.** |
| Choice | `choice` (opção de maior probabilidade), `probabilities` (soma 1), `confidence` |
| Score  | `score` (média ponderada, pode cair entre níveis), `legend`, `probabilities`, `confidence` |

O campo `model` da resposta traz o **ID versionado** que respondeu — use-o para
registrar qual modelo produziu cada resultado quando você chamou por alias.

---

## 6. Confiança

`confidence` é uma estatística **derivada da distribuição de probabilidade** que
a resposta já entrega, num intervalo de 0 a 1. Distribuição mais achatada =
confiança menor.

**Só existe em Choice e Score.** Um Noul não tem confiança separada porque a
distribuição dele só tem dois desfechos — o próprio valor `noul` já a descreve
por inteiro. Choice e Score espalham probabilidade por várias opções ou níveis,
e é esse espalhamento que a confiança resume.

A doc é explícita em que essa é **uma conveniência, não uma camisa de força**:
as `probabilities` completas vêm na resposta justamente para você computar outra
medida se a sua for melhor para o caso.

> Fórmula do widget interativo da página de Confidence, para Choice com `n`
> opções e pico `p`: `confidence = clamp((n·p − 1) / (n − 1), 0, 1)`.
> Distribuição uniforme dá 0; toda a massa numa opção dá 1. Isto foi extraído
> do código do widget, não de uma especificação publicada — trate como
> ilustração, não contrato.

### 6.1 Três caminhos

O padrão recomendado divide a confiança em três faixas com comportamentos
distintos no seu código:

- **Alta** — age automaticamente.
- **Média** — prossegue com cautela: pede confirmação, marca para revisão ou
  busca mais informação antes de agir.
- **Baixa** — **não age**: manda para humano, pede esclarecimento ou cai em
  outro sistema. O modelo está dizendo que não tem base.

**O limiar escala com o risco, e não é um número só.** Ações diferentes dentro
do mesmo sistema devem ter portões diferentes conforme a consequência do erro:
mostrar a tela errada é recuperável e aceita limiar baixo; aprovar uma
transferência não é e exige limiar alto. A doc recomenda começar conservador,
testar com dados próprios e ajustar observando resultado.

---

## 7. Lendo um Noul

O número é **a resposta e a certeza ao mesmo tempo**. Perto de 1 é um sim
forte; perto de 0, um não forte; perto de 0,5 o modelo dá probabilidade
parecida aos dois lados.

Valores reais de `jev-1.13.0` para *"Is this an escalation to a human?"*:

| Estado                                                       | `noul` |
| ------------------------------------------------------------ | ------ |
| Thanks, that fixed it!                                       | 0.02   |
| How do I reset my password?                                  | 0.07   |
| I need this sorted today, whatever it takes.                 | 0.26   |
| Are you a bot?                                               | 0.40   |
| Is there any way to speak to someone about my invoice?       | 0.84   |
| I have asked three times now. Can I please talk to a person? | 0.99   |

"I need this sorted today" é urgente mas nunca pede uma pessoa: 0,26. "Are you
a bot?" insinua sem pedir: 0,40. Esses são os casos que o **limiar no seu
código** decide.

**Onde pôr o limiar** depende do custo de errar: 0,5 quando sim e não custam o
mesmo; mais alto quando agir num falso sim é caro (acordar alguém, emitir
reembolso); mais baixo quando perder um sim verdadeiro é caro (deixar de sinalizar
risco). O meio pode ir para revisão humana em vez de qualquer um dos caminhos.

### 7.1 A armadilha: Noul não é escala de grau

O valor vai de 0 a 1, **mas não é uma escala da coisa que você perguntou** — é a
probabilidade de a resposta ser sim. Se a sua pergunta é sobre *grau*, o valor
não mede o grau.

Comparação da doc, "Is the candidate strong in Python?" (Noul) contra um Score
de quatro níveis:

| Candidato                                       | Noul | Score |
| ----------------------------------------------- | ---- | ----- |
| Experiência em Java e Go, nunca usou Python     | 0.03 | 0.0   |
| Usa Python ocasionalmente para scripts pequenos | 0.14 | 1.0   |
| Python diário por dois anos, data pipelines     | 0.81 | 2.05  |
| Python diário há oito anos, Django grande       | 0.92 | 2.89  |

Você até pode inventar faixas (0,3–0,7 = "alguma experiência"), **mas o modelo
não as viu** e nada na resposta foi julgado contra elas. Um valor no meio pode
significar experiência média *ou* caso ambíguo, e o espaçamento entre
candidatos não foi escolhido por você. O Score julga cada descrição de nível
por si, então todo mundo cai sobre um nível que você escreveu.

### 7.2 Escrevendo uma boa pergunta Noul

- **Uma condição por pergunta.** "O cliente está bravo *e* pedindo reembolso?"
  obriga o modelo a julgar duas coisas de uma vez e o valor perde significado.
  Faça dois Nouls e combine no código.
- **Frase de modo que alto signifique sim.** "A mensagem contém dado pessoal?"
  é claro; "A mensagem está livre de dado pessoal?" inverte, e o código que ler
  depois vai entender ao contrário.
- **Afirmação funciona tão bem quanto pergunta.** "O cliente está pedindo
  reembolso" com valor perto de 1 = afirmação verdadeira. Teste as duas formas.
- **Torne a fronteira inequívoca.** "Tem *alguma* experiência em Python?"
  funciona bem porque "alguma" não deixa meio-termo. Quando a fronteira é
  sutil, acrescente `criteria`. A instrução basta na maioria dos Nouls — teste
  com e sem e fique com o que responder melhor nos *seus* documentos.
- **Pergunte várias por chamada.** Para um checklist de condições, uma pergunta
  por condição na mesma requisição; o código decide o que a combinação
  significa. Como avaliam em paralelo, o custo de tempo é quase nulo.

---

## 8. API HTTP

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

Corpo: `state` (obrigatório), `model` (obrigatório), `questions` (mapa
obrigatório de id escolhido por você → pergunta tipada).

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "state": "Meus repasses falham há 3 dias.",
    "model": "jev-latest",
    "questions": {
      "is_urgent": { "type": "noul", "instructions": "Does this convey urgency?" }
    }
  }'
```

`GET /v1/models` lista os nomes que a sua conta pode mandar no campo `model`,
com descrição e data de lançamento. Hoje lista os aliases; IDs versionados como
`jev-1.13.0` são aceitos no campo mesmo sem aparecer na lista.

### 8.1 Erros

| Status | Significado |
| ------ | ----------- |
| `401 Unauthorized` | Chave ausente ou inválida — confira o header `Authorization`. |
| `422 Unprocessable Entity` | Corpo reprovado na validação; o corpo da resposta detalha o campo ofensor. |
| `429 Too Many Requests` | Limite de taxa estourado. |
| `529 Overloaded` | TypeSafe temporariamente sobrecarregado. |

Em `429` e `529`, a orientação é **backoff exponencial**, nunca retry imediato.
Quando a resposta traz `retry-after`, honre o header. Os SDKs oficiais já fazem
isso por padrão.

---

## 9. Modelos, preço e limites

Tudo é servido pelo mesmo endpoint; o campo `model` escolhe quem atende.

| Jev 1.13 | `jev-1.13.0` |
| -------- | ------------ |
| **Preço** | US$ 42 por Btok / US$ 0,042 por Mtok — **cobrado só no token de entrada; saída é grátis** |
| **Limite de taxa** | 250.000 tokens por segundo / 1.200 requisições por minuto |
| **Contexto** | 64k tokens por requisição; 32k para o `state` mais a pergunta mais longa |
| **Entrada** | Só texto — string, objeto JSON ou array de textos |

O orçamento de 64k cobre o `state` mais **todas** as perguntas somadas; o de
32k se aplica ao `state` mais a **única** pergunta mais longa.

> **Os limites de taxa estão mudando dinamicamente.** A doc oficial avisa que
> eles podem mudar sem aviso enquanto a TypeSafe absorve demanda. Limites
> maiores existem em planos custom/enterprise.

### 9.1 Aliases

| Alias | Aponta para | Significado |
| ----- | ----------- | ----------- |
| `jev-latest` | `jev-1.13.0` | Release estável mais recente. Default dos SDKs e dos exemplos da doc. |
| `jev-preview` | `jev-1.13.0` | Release mais recente, oficial ou não. Anda à frente quando há build de preview. |

**Alias se move sem ação sua** — a resposta por trás dele pode mudar. Se você
calibrou limiares contra uma versão específica, **fixe o ID versionado** e mude
de versão no seu próprio calendário. O campo `model` da resposta sempre diz quem
de fato respondeu.

### 9.2 Customização e dados

O Jev **não é fine-tuned nem LoRA-adaptado com dado de cliente** — os mesmos
pesos servem todas as contas. Você molda as respostas ao seu domínio pela
requisição, não por pesos:

- conteúdo proprietário e material de referência no `state`;
- regras de domínio e casos de fronteira em `instructions` e `criteria`;
- julgamentos amplos decompostos em perguntas atômicas, combinados no código.

A TypeSafe declara que **não treina com requisições nem respostas de cliente**;
retenção zero (ZDR) é oferecida a clientes enterprise.

---

## 10. Onde o `jev-1.13` erra (*jaggedness*)

A TypeSafe publica uma página própria de arestas conhecidas
([jev-1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13), revisada em
2026-09-17). Resumo dos nove modos de falha:

| # | Modo de falha | Faça isto |
| - | ------------- | --------- |
| 1 | **Leitura literal** | Escreva a condição exata; casos de fronteira nos `criteria`. |
| 2 | **Matemática e números** | Deixe a aritmética no código. |
| 3 | **Comparação de data/hora** | Extraia os componentes; compare no código. |
| 4 | **Indireção** | Reduza saltos; aponte para o trecho relevante do estado. |
| 5 | **Estado grande e irrelevante** | Filtre antes; mande só o que a pergunta precisa. |
| 6 | **Conteúdo adversarial** | Critérios explícitos; teste casos de borda antes de publicar. |
| 7 | **Instruções × critérios contraditórios** | Alinhe os dois. |
| 8 | **Invariantes estruturais de senso comum** | Pergunte cada decisão de um jeito só; garanta identidades no código. |
| 9 | **Geração de texto** | Use um modelo generativo. |

Três merecem destaque por serem contraintuitivos:

**Leitura literal (1).** O modelo responde a pergunta que você escreveu, não a
que você quis dizer. Negação, escopo e condição implícita são lidos ao pé da
letra. O teste prático da doc é ótimo: *quando você olha uma resposta errada e
se pega explicando o que realmente queria dizer, essa explicação é a metade
faltante da instrução.*

**Conteúdo adversarial (6).** **O estado é tratado como dado, não como hostil.**
Texto escrito para manipular o modelo — instrução injetada, enquadramento
enganoso, ou conteúdo que argumenta pela própria classificação — pode mover a
resposta. Isto importa muito quando o estado vem de fonte não confiável.

**Invariantes estruturais (8).** O modelo é muito consistente (entradas
semanticamente parecidas dão saídas quantitativamente parecidas), **mas
invariantes que você imaginaria válidos não são garantidos.** Dois exemplos
medidos:

- a mesma pergunta como Noul e como Choice sim/não não é comparável:
  `noul` 0,22 contra `probabilities["yes"]` 0,01 com confiança 0,97;
- uma pergunta e a negação dela como dois Nouls **não somam 1**: 0,72 e 0,47,
  soma 1,19.

Consequência direta: **não carregue um limiar calibrado num Noul para um
Choice**, e não cobre identidades aritméticas entre perguntas separadas. Um
Choice é *relativo* (decide **qual** opção); um Noul é *absoluto* e pode ser
baixo para todas.

---

## 11. Regras de bolso

Destilado das páginas de design e da lista de arestas:

- **Nunca pergunte o que o código calcula exato.** Aritmética, comparação de
  data, contagem — tudo isso é trabalho do código.
- **Uma pergunta, um julgamento.** Vários julgamentos escondidos numa pergunta
  é o erro mais comum.
- **Filtre o estado antes de mandar.** Acurácia cai conforme o estado cresce
  com conteúdo irrelevante, e estado grande dificulta descobrir qual parte
  produziu a resposta errada.
- **Ponha o limiar no código, não na pergunta.** O valor cru na resposta é o
  que permite recalibrar sem repetir chamada.
- **Guarde o valor cru, não o booleano**, se pretende recalibrar depois.
- **Alias em produção só com o ID versionado registrado** junto do resultado.
- **Teste no seu próprio conteúdo** — especialmente fora do inglês.

---

## 12. Mapa da documentação oficial

| Página | URL |
| ------ | --- |
| Introduction | <https://docs.typesafe.ai/introduction> |
| System One | <https://docs.typesafe.ai/concepts/system-one> |
| State | <https://docs.typesafe.ai/concepts/state> |
| Primitives | <https://docs.typesafe.ai/primitives> (+ `/choice`, `/score`, `/noul`, `/advanced`) |
| Confidence | <https://docs.typesafe.ai/confidence> |
| How to build | <https://docs.typesafe.ai/concepts/how-to-build-with-system-one> |
| Models | <https://docs.typesafe.ai/models> |
| API reference | <https://docs.typesafe.ai/api> |
| Jaggedness (jev-1.13) | <https://docs.typesafe.ai/model-jaggedness/jev-1.13> |
| Patterns | <https://docs.typesafe.ai/patterns> (fan-out, confidence routing, composite scoring, intent routing) |
| Cookbooks | <https://docs.typesafe.ai/cookbooks> |
| SDKs | <https://docs.typesafe.ai/sdk> (Python, JavaScript) |
| Índice em markdown | <https://docs.typesafe.ai/llms.txt> |
| Console / chaves | <https://console.typesafe.ai/keys> |
