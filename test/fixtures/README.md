# Fixtures dos parsers BR

HTML congelado para exercitar `parsePosts`/`parseDownloadLinks`/`releaseTitle`
dos quatro resolvedores sem rede.

**O que estas fixtures pegam e o que não pegam.** Elas travam o *parser*: se
alguém refatorar as regexes e a seção de áudio parar de valer para os botões
seguintes, ou "TEMPORADA COMPLETA" deixar de zerar o episódio, o teste quebra.
Elas **não** avisam quando o site muda de layout — o HTML aqui está congelado,
então uma mudança lá fora deixa a fixture (e o teste) verdes enquanto a busca
real volta vazia. Para esse caso o sinal é o status por indexador na página de
configuração, não o CI.

**Procedência.** Foram reconstruídas a partir do contrato dos parsers (as
regexes e os comentários de cada `server.js`), não capturadas dos sites. Elas
reproduzem a estrutura que o código espera e os casos difíceis que os
comentários citam — codec entre a qualidade e o parêntese, tamanho com lixo
depois, marcador de áudio válido para os botões seguintes.

**Atualizando com HTML real.** Vale mais que o reconstruído, e é uma chamada:

```bash
node dist/scripts/capture-fixture.js https://exemplo/post/ test/fixtures/bludv-post.html
```

Confira o arquivo antes de commitar: página de post costuma trazer link de
afiliado e id de sessão no HTML.
