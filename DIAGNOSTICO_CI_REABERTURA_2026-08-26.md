# C.I. — os 16 processos e a reabertura de PC encerrada

**26/08/2026 · SÓ LEITURA.** Nenhum `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE` foi executado.
O script de consulta ficou no scratchpad, não versionado.

> ## ⚠️ ANTES DE TUDO — DUAS COISAS QUE MUDAM O DIAGNÓSTICO ANTERIOR
>
> **1. "Não existe caminho no código para reabrir uma PC encerrada" está quase certo, e o
> "quase" é perigoso.** Não existe caminho que a devolva ao ciclo (`na_fila`/`com_analista`).
> **Existe** um caminho que a tira do ciclo inteiro: `POST /parcela/puxar_ci`
> (`correcao.SQL_PUXAR_CI`). O `WHERE` dele é **`enviado_ci = true`**, e não `ci_situacao`
> nenhum — logo ele **alcança hoje as 23 PCs encerradas**. E é destrutivo: derruba `baixada`,
> `enviado_ci`, `parecer_tipo`, marca `estornada = true` e **tira as PCs da produtividade da
> analista**. Se alguém do C.I. tentar "devolver" por ali, é isso que acontece. Detalhe na
> resposta 4.
>
> **2. O estado "encerrado sem carimbo" NÃO é destes 16 — é o acervo inteiro.** São **1.732**
> PCs assim, de **1.737** encerradas (99,7%). As 23 são um pedaço disso. Origem conhecida e
> deliberada: `executar_16_08.js`, decisão de 16/08/2026. Detalhe na resposta 2.

---

## 1. Estado atual das PCs dos 16 processos

**26 PCs no banco** — 23 `encerrado`, 3 com `ci_situacao` **nula** (nunca entraram no ciclo).
Dois processos (`SCC 21815/2022` e `SCC 20923/2025`) não existem em `prestacoes_contas`, em
grafia nenhuma. Chave normalizada pela mesma função da tela (`ci-fila.chaveSgpe`).

| chave | id | codigo_pc | TR | parc.seq | ci_situacao | rodada | encerrado_em | encerrado_por | tecnico_id | baixada | enviado_ci | analista | parecer |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SCC/19676/2020 | 32708 | 2020PC001898 | 2020TR000680 | 6 | encerrado | 1 | — | — | — | sim | sim | Marcelo (16) | Regular com Ressalva, sem texto |
| SCC/19676/2020 | 32715 | 2020PC002958 | 2020TR000680 | 13 | encerrado | 1 | — | — | — | sim | sim | Marcelo (16) | Regular com Ressalva, sem texto |
| SCC/5892/2022 | 35046 | 2021PC002038 | 2021TR001594 | 1 | **NULA** | 0 | — | — | — | sim | **não** | Juliana de Souza (45) | Regular com Ressalvas, sem texto |
| SCC/10389/2022 | 34900 | 2021PC002214 | 2021TR002029 | 1 | **NULA** | 0 | — | — | — | **não** | **não** | Ana Claudia Carvalho Costa (22) | **nenhum** |
| SCC/5261/2021 | 33715 | 2020PC000820 | 2020TR000762 | 1 | encerrado | 1 | — | — | — | sim | sim | Marisa (17) | Regular com Ressalva, sem texto |
| SCC/5261/2021 | 33716 | 2020PC000821 | 2020TR000762 | 2 | encerrado | 1 | — | — | — | sim | sim | Marisa (17) | Regular com Ressalva, sem texto |
| SCC/2877/2021 | 32485 | 2020PC000429 | 2020TR000633 | 1 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32486 | 2020PC000575 | 2020TR000633 | 2 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32487 | 2020PC000917 | 2020TR000633 | 3 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32488 | 2020PC001421 | 2020TR000633 | 4 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32489 | 2020PC001530 | 2020TR000633 | 5 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32490 | 2020PC001895 | 2020TR000633 | 6 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32491 | 2020PC002248 | 2020TR000633 | 7 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32492 | 2020PC002564 | 2020TR000633 | 8 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/2877/2021 | 32493 | 2020PC003136 | 2020TR000633 | 9 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular, sem texto |
| SCC/11337/2023 | 40389 | 2023PC000222 | 2020TR000633 | 25 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular com Ressalvas, sem texto |
| SCC/11337/2023 | 40390 | 2023PC000223 | 2020TR000633 | 26 | encerrado | 1 | — | — | — | sim | sim | Geisa Carla Pereira (25) | Regular com Ressalvas, sem texto |
| SCC/22203/2021 | 34341 | 2021PC002076 | 2020TR000719 | 17 | encerrado | 1 | — | — | — | sim | sim | Rita Inês Martini (33) | Regular com Ressalvas, sem texto |
| SCC/3033/2022 | 34343 | 2021PC002279 | 2020TR000719 | 19 | encerrado | 1 | — | — | — | sim | sim | Rita Inês Martini (33) | Regular com Ressalvas, sem texto |
| SCC/6082/2022 | 36515 | 2022PC000118 | 2022TR000027 | 1 | **NULA** | 0 | — | — | — | sim | **não** | Clodoaldo Fornari (37) | Regular com Ressalvas, sem texto |
| SCC/9976/2022 | 33848 | 2021PC002473 | 2021TR002189 | 1 | encerrado | 1 | — | — | — | sim | sim | Marlene Teodoro Ramos da Silva (46) | Regular com Ressalvas, sem texto |
| SCC/59/2023 | 35311 | 2022PC003325 | 2020TR000640 | 20 | encerrado | 1 | — | — | — | sim | sim | Cris (9) | Regular com Ressalva, sem texto |
| SCC/60/2023 | 35305 | 2022PC000447 | 2020TR000640 | 14 | encerrado | 1 | — | — | — | sim | sim | Cris (9) | Regular com Ressalva, sem texto |
| SCC/60/2023 | 35312 | 2022PC003326 | 2020TR000640 | 21 | encerrado | 1 | — | — | — | sim | sim | Cris (9) | Regular com Ressalva, sem texto |
| SCC/14766/2022 | 34730 | 2021PC002215 | 2021TR001849 | 1 | encerrado | 1 | — | — | — | sim | sim | Maria Goreti Korb (40) | Regular com Ressalvas, sem texto |
| SCC/14767/2022 | 41002 | **2021TR001849-PFINAL** | 2021TR001849 | 999 | encerrado | 1 | — | — | — | sim | sim | Maria Goreti Korb (40) | Regular com Ressalvas, sem texto |

**O que sai da tabela, e vale registrar:**

- As **23 encerradas** são idênticas no que importa: `ci_rodada = 1`, `ci_encerrado_em` e
  `ci_encerrado_por` **nulos**, `ci_tecnico_id` **nulo**, `baixada = true`,
  `enviado_ci = true`, `data_baixa` e `dt_envio_ci` = **30/06/2026** (a carga histórica),
  `status = 'baixada'`, `parecer_ci` nulo, **0 mensagens** em `ci_mensagem`.
- **Nenhuma das 26 tem texto de parecer** em `parcela_historico`. Só o `parecer_tipo`.
- **`SCC 14767/2022` é a PC FINAL da 2021TR001849** (`parcela_seq = 999`, sufixo `-PFINAL`),
  não uma parcial. Quem for tratá-la trata uma final — ela anda sozinha
  (`correcao.alvoDaAcao`), e as irmãs da parcial 1 da mesma TR não vêm junto.
- **As 3 de `ci_situacao` NULA não são caso de reabertura** — nunca entraram no ciclo. E as
  três são diferentes entre si:
  - `2021PC002038` (Juliana, 45): baixada, **sem** `enviado_ci`. Falta o passo 3.
  - `2022PC000118` (Clodoaldo, 37): baixada, **sem** `enviado_ci`. Falta o passo 3.
  - `2021PC002214` (Ana Claudia, 22): **não baixada, sem parecer, `status = 'livre'`**. Esta
    não tem nem o passo 1. O C.I. não pode ter recebido esta PC pelo sistema.

---

## 2. É caso destes 16, ou padrão do acervo?

**Padrão do acervo, e por decisão registrada.** Medido no acervo inteiro (14.658 PCs):

| | |
|---|---|
| `ci_situacao = 'encerrado'` | **1.737** |
| destas, **sem `ci_encerrado_por` E sem `ci_encerrado_em`** | **1.732** (99,7%) |
| sem `ci_encerrado_por` (isolado) | 1.732 |
| sem `ci_encerrado_em` (isolado) | 1.732 |
| com os dois carimbos | **5** |
| sem `ci_tecnico_id` | **1.737** — *todas* |
| `na_fila` | 1.392 |
| `com_analista` | **2** |
| `ci_situacao` nula (fora do ciclo) | 11.527 |

**Das 1.732 órfãs: 23 são destes 16 processos e 1.709 são o resto do acervo.**

As **5 únicas com carimbo** são as decididas pela tela desde que ela existe:

| quem | de | até | n |
|---|---|---|---|
| Atemilson Bispo dos Santos (63) | 21/08/2026 | 24/08/2026 | 3 |
| Marcia Terezinha Miranda (62) | 21/08/2026 | 21/08/2026 | 2 |

E `ci_mensagem` tem **2 mensagens, em 2 PCs**, no acervo inteiro.

**As 1.732 órfãs são todas iguais:** `ci_rodada = 1`, `baixada = true`, `enviado_ci = true` —
uma única combinação, sem exceção.

**A origem é conhecida e foi deliberada:** `executar_16_08.js` (16/08/2026) marcou
`ci_situacao = COALESCE(ci_situacao, 'encerrado')` nas PCs cujo C.I. foi feito **por fora do
sistema**, e deixou `ci_encerrado_em`/`ci_encerrado_por` nulos de propósito — o comentário no
script diz, com todas as letras, *"não sei quando nem por quem, e inventar data é pior que não
ter"*. `'na_fila'` foi recusado ali porque afundaria a fila real dos três técnicos embaixo de
1.699 encaminhamentos datados de junho.

> **Conclusão:** o estado das 23 **não é defeito e não é específico destes 16**. É o rótulo do
> C.I. histórico. O que estes 16 têm de particular é que o SGPe os devolveu depois — e é o
> ciclo que não tem porta de volta, não o dado.

---

## 3. A reabertura — em quais colunas ela escreveria (descrição, não implementação)

O destino que corresponde a "voltar à fila do analista" é **`ci_situacao = 'com_analista'`** —
é literalmente o estado que `lib/ci.js` chama de *"devolve ao analista para corrigir ou
argumentar"*. `'na_fila'` devolveria à fila **do C.I.**, não à do analista.

### Escreveria — uma transação, por `codigo_pc` (nunca por `parcial_num`)

| coluna | de | para | por quê |
|---|---|---|---|
| `ci_situacao` | `'encerrado'` | `'com_analista'` | é o único estado que o analista vê como pendência dele |
| `ci_rodada` | `1` | `GREATEST(ci_rodada,1) + 1` → `2` | é o mesmo que o ramo `ressalva` de `ci.decidir` faz; é a rodada que faz o sino avisar de novo, e é ela que `ci.gravarMensagem` lê da PC |
| `ci_encerrado_em` | `NULL` | `NULL` | é a marca do encerramento; **nestas 23 já está nula**, então na prática não muda nada — mas o `UPDATE` precisa zerá-la para não deixar carimbo de encerramento numa PC reaberta, nos outros 1.709 casos e nas 5 com carimbo |
| `ci_encerrado_por` | `NULL` | `NULL` | idem |
| `atualizado_em` | — | `NOW()` | padrão de toda escrita na tabela |

### Escreveria fora de `prestacoes_contas`

- **`ci_mensagem`** — uma linha **por PC**, `direcao = 'ci_para_analista'`, `rodada` lida da
  PC (a nova), com o motivo da reabertura. Sem ela o analista recebe uma pendência sem saber
  por quê — e hoje essas 23 PCs têm **zero** mensagens.
- **`parcela_historico`** — uma linha **por PC**, com o `codigo_pc` no texto (a tabela é
  indexada por `(tr, parcial_num)` e não tem coluna `codigo_pc`), `valor_anterior =
  'encerrado'`, `valor_novo = 'com_analista'`, `analista_id` = o **dono**, `executado_por` =
  quem clicou (nulo quando for o próprio dono).

### NÃO escreveria — e a lista é a regra, não uma escolha

`baixada` · `data_baixa` · `enviado_ci` · `dt_envio_ci` · `enviado_ci_por` · `parecer_tipo` ·
`status` · `situacao_atual` · `estornada` · `baixado_por` · `analista_id`.

Há teste que falha se um `UPDATE` do ciclo do C.I. mencionar `baixada`, `data_baixa` ou
`enviado_ci`.

### Depois disso, o caminho de volta JÁ EXISTE — e a tela também

`POST /ci/responder` (`ci.responder`) exige exatamente `ci_situacao = 'com_analista'` e
devolve a PC para `'na_fila'`, sem subir a rodada. Não precisa de nada novo.
No `index.html`, o botão de responder já aparece em `pa.ci_situacao === 'com_analista'`, e o
cartão já trata `ci_situacao !== 'encerrado'` como ciclo aberto. **A tela do analista não
precisaria de mudança.**

### ⚠️ DUAS DECISÕES DE REGRA QUE SÃO SUAS — e uma delas conflita com o contexto fixo

1. **`ci_tecnico_id` / `ci_tecnico_em`.** Sua regra fixa diz: *"só podem ser escritos dentro
   de `ci.decidir`, na mesma transação do parecer"*. Uma reabertura **não é um parecer**.
   As três saídas possíveis são regra, não técnica:
   (a) a reabertura **não** carimba técnico — a PC volta anônima, como está hoje;
   (b) a reabertura vira um **terceiro ramo de `ci.decidir`**, e aí carimba por dentro da
   regra existente;
   (c) a regra é ampliada para "`ci.decidir` **e** `ci.reabrir`".
   **Não escolhi nenhuma.**

2. **Quem reabre.** Só `controle_interno`? Superadmin no papel `tecnico` também? E vale sobre
   PC de qualquer analista, como as outras ações do C.I. valem?

---

## 4. O que acontece com produtividade, `baixada` e `enviado_ci`

### Pela regra: **nada muda. Zero efeito.**

A produtividade é *PCs distintas com `baixada = true` OR `enviado_ci = true`*. A reabertura
descrita em (3) **não toca em nenhuma das duas** — nas 23 PCs as duas já são `true`, e
continuariam. `ci_situacao` **não entra em contagem de produtividade nenhuma**. Conferido nas
três que existem no sistema:

| contagem | onde | o que lê | lê `ci_situacao`? |
|---|---|---|---|
| `GET /prestacoes_contas/produtividade` | `server.js:1659` | `data_baixa <= corte` **AND** `(estornada = false OR data_estorno > corte)` | **não** |
| tela Produtividade (`prodCarregar`) | `index.html` | `status === 'baixada'` | **não** |
| Board / Gestão Grupo | `index.html` | `status === 'baixada'` e, à parte, `enviado_ci === true` | **não** |

E é a própria regra do ciclo: `lib/ci.js` diz que a baixa **nunca** é tocada, qualquer que
seja o desfecho — *"se a baixa caísse na devolução, o analista perderia produtividade por um
ajuste de forma"*. A ida ao C.I. e a volta do C.I. já são, por decisão de 13/08, passos
**depois** da baixa.

Números de hoje, para referência: **4.049 PCs produtivas** (4.048 baixadas + 1 no C.I. sem
baixa). As 23 estão dentro, e continuariam dentro.

### ⚠️ Mas há UM caminho no sistema que faz o contrário — e ele alcança estas 23 hoje

`POST /parcela/puxar_ci` → `correcao.SQL_PUXAR_CI`. É a única porta do sistema em que o C.I.
derruba a baixa, e ela existe para desfazer **erro de encaminhamento** ("não houve relação
C.I.–analista"), não para devolver trabalho.

O `UPDATE` dele grava, de uma vez: `enviado_ci = false` · `dt_envio_ci = NULL` ·
`enviado_ci_por = NULL` · `ci_situacao = NULL` · `ci_rodada = 0` · `ci_encerrado_em = NULL` ·
`ci_encerrado_por = NULL` · `parecer_ci = NULL` · **`baixada = false`** ·
`status = 'analise'` · **`estornada = true`** · `data_estorno = NOW()` ·
**`parecer_tipo = NULL`** · `baixado_por = NULL`.

**Três coisas a saber sobre ele:**

1. **O `WHERE` é `enviado_ci = true`** — não `ci_situacao = 'na_fila'`. Ele **não recusa** PC
   encerrada. As 23 têm `enviado_ci = true`, logo estão ao alcance dele **agora**.
2. **Ele tira a PC da produtividade nas duas contagens** — `baixada = false` derruba a tela,
   `estornada = true` derruba a rota. E apaga o `parecer_tipo`. É o oposto do que o C.I.
   quer: as 23 são trabalho **feito**, que precisa de mais uma volta, não de anulação.
3. **`podePuxarCi` deixa o analista passar quando `enviado_ci_por` é nulo** — e nestas 23,
   vindas da carga de 16/08, ele é nulo. Não é só o C.I. que alcança: **a própria analista
   alcança**, e o efeito é perder as PCs da produtividade dela.

**Achado lateral, não pedido, registrado e não corrigido:** `SQL_PUXAR_CI` limpa
`ci_encerrado_em`/`ci_encerrado_por` mas **não limpa `ci_tecnico_id`/`ci_tecnico_em`** — as
duas colunas nasceram em 26/08, depois dele. Uma PC puxada de volta ficaria com `ci_situacao`
nula e um técnico do C.I. pendurado. Hoje não há caso: as 1.737 encerradas têm `ci_tecnico_id`
nulo. Vira linha em Pendências, não tarefa.

---

## Resumo em uma linha de cada

1. 26 PCs · **23 `encerrado`** (todas rodada 1, sem carimbo, baixadas e no C.I., de 30/06) · 3
   fora do ciclo · 2 processos inexistentes · 1 delas é a **PC FINAL**.
2. **1.732 no acervo** estão assim — 23 destes 16 e **1.709 do resto**. É o rótulo do C.I.
   histórico marcado em 16/08, por decisão registrada. **Não é defeito destes 16.**
3. `ci_situacao → 'com_analista'` · `ci_rodada + 1` · `ci_encerrado_*` nulos · mensagem em
   `ci_mensagem` · linha em `parcela_historico`. Nada mais. `POST /ci/responder` e a tela do
   analista já funcionam a partir daí.
4. **Nenhum efeito** em produtividade, `baixada` ou `enviado_ci` — é a regra do ciclo.
   ⚠️ **Mas `POST /parcela/puxar_ci` alcança as 23 hoje e faz o oposto: tira da
   produtividade.**
