# AS TRÊS PENDÊNCIAS — 16/08/2026

**Nada foi gravado no banco. Nada foi publicado. O `index.html` não foi tocado.**
O que existe: um script em dry-run conferido, um mockup para você aprovar, e a resposta do item 3.

---

## 1 · AS 18 PCs COM `analista_id` SEM `analista_nome`

### O script está pronto e o dry-run passou nas 7 conferências

`corrigir_nome_analista.js` — padrão dry-run, grava só com `--gravar`.

```
── BACKUP _backup_nomevazio_20260816: 14658 linhas
── O ALVO: 18 PCs · 5 TRs · 3 analistas
>> 18 PCs com o nome preenchido

── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────
   OK     nenhuma PC criada nem apagada            14658 -> 14658
   OK     nome mexido fora da lista das 18         0
   OK     nas 18, as 24 colunas intocadas iguais   0
   OK     baixa/parecer/C.I. intactos no acervo    0
   OK     o nome gravado bate com o dry-run        18/18
   OK     "id sem nome" zerou                      0
   OK     ninguem ganhou um nome NOVO              0

>> DRY-RUN: ROLLBACK. Nada gravado.
```

A conferência roda **dentro da mesma transação**, compara contra o backup e faz `ROLLBACK`
se qualquer uma falhar. Ele escreve **duas colunas**: `analista_nome` e `atualizado_em`.
As outras 24 são testadas uma a uma contra o backup — inclusive `baixada`, `data_baixa`,
`parecer_tipo`, `enviado_ci` e os quatro `ci_*`.

Medição dupla, por dois caminhos independentes (linha a linha, e agregando por TR):
**18 = 18, 5 TRs = 5 TRs.** Bateram.

| TR | PCs | id | nome que entra | tipo |
|---|---|---|---|---|
| `2020TR000723` | 14 | 31 | **Noici** | parciais 2, 3 e 4 |
| `2020TR001636` | 1 | 22 | **Ana Claudia** | PFINAL |
| `2021TR002029` | 1 | 22 | **Ana Claudia** | PFINAL |
| `2022TR001328` | 1 | 41 | **Graciane** | PFINAL |
| `2023TR000039` | 1 | 41 | **Graciane** | PFINAL |

Todas as 18 estão baixadas, todas com parecer. O script **aborta** se aparecer uma aberta.

### ⚠️ MAS A RECEITA QUE ESTAVA ESCRITA NO `SESSAO.md` ERRA EM 2 DAS 18

O `SESSAO.md` dizia: *"a correção é de uma linha — `analista_nome =
assumir.nomeCurto(usuarios.nome)`"*. Medido contra o banco, essa linha escreveria:

```
id 22   cadastro "Ana Claudia Carvalho Costa"   nomeCurto() -> "Ana"
        mas as outras 105 PCs dela no acervo dizem "Ana Claudia"
```

Duas PCs da Ana Claudia sairiam com um nome que não existe em lugar nenhum do acervo dela.

**Por isso a fonte padrão do script é o ACERVO** — o nome que o próprio `analista_id` já
tem gravado nas outras PCs dele. Nos três ids o dominante é inequívoco (Noici 158, Ana
Claudia 105, Graciane 40). O script **recusa** se houver empate, e tem `--fonte=cadastro`
se você preferir a receita antiga.

### ⚠️ E A CAUSA É MAIOR QUE ESTAS 18 — É DEFEITO VIVO NO `lib/assumir.js`

O `MAPA_NOME` tem 8 chaves. **Três delas são o nome CURTO, não o `usuarios.nome`**, e por
isso **nunca disparam** — não existe usuário chamado assim:

| chave do mapa | existe em `usuarios.nome`? |
|---|---|
| `Richard Motta Coelho` · `Nayara Limas Ferreira` · `Zadir Teresinha Machado Ferreira` · `Sandra Paul` · `Grace Oliveira` | ✓ casam |
| **`Sandra Rocha`** · **`Ana Claudia`** · **`Ana Leticia`** | ⚠️ **ninguém se chama assim — nunca dispara** |

Consequência medida: **5 analistas** em que `nomeCurto(usuarios.nome)` diverge do que o
acervo já grava.

| id | cadastro | `nomeCurto()` daria | o acervo tem |
|---|---|---|---|
| 19 | Sandra Cezária Ronchi Rocha | `Sandra` | **Sandra Rocha** (354) |
| 22 | Ana Claudia Carvalho Costa | `Ana` | **Ana Claudia** (105) |
| 23 | Ana Letícia Wloch de Oliveira | `Ana` | **Ana Leticia** (147) |
| 40 | Maria Goreti Korb | `Maria` | **Goreti** (52) |
| 51 | Janaína Frederico Dittrich | `Janaína` | **Janaina** (188) — acento |

⚠️ **Os ids 22 e 23 dão o MESMO nome: "Ana".** Duas analistas diferentes colapsariam num
rótulo só na tela.

⚠️ **Isto está no ar agora.** `assumir.nomeCurto()` é chamado em três pontos de escrita:
`POST /tr/assumir` (server.js:2489 e :2501), a transferência do motivo 1 do pedido de
devolução (server.js:3082 e :3095), e o `atribuir_soltas.js`. **Se a Sandra Rocha, a Ana
Claudia, a Ana Letícia, a Goreti ou a Janaína assumir uma TR hoje, o acervo ganha um
segundo nome para ela** — e a Minha Planilha dela passa a mostrar dois rótulos.

Não é escopo desta pendência e **não mexi**. Fica registrado como frente. O conserto é
trocar as três chaves pelo `usuarios.nome` correspondente — mas isso muda o que 5 analistas
veem na tela, então é decisão sua, não minha.

### ⚠️ E OS VIZINHOS, QUE **NÃO** SÃO ALVO DESTE SCRIPT

**10 PCs em que o `analista_nome` CONTRADIZ o `analista_id`** — o inverso das 18:

| id | cadastro | nomes gravados |
|---|---|---|
| 41 | Graciane Mondardo Constantino | Graciane (40) · **Juliana (1)** — em `2023TR000039` |
| 45 | Juliana de Souza | Juliana (163) · **Marlene (2)** · **Tanimeri (1)** |
| 47 | Rafael | Rafael (135) · **Samoel (4)** · **Guilherme (1)** |
| 48 | Samoel | Samoel (41) · **Elisandra (1)** |

A `2022TR001687` que o `SESSAO.md` já registra é uma destas: a PFINAL tem `analista_id = 45`
(Juliana) e `analista_nome = 'Tanimeri'`. **A produtividade conta para a Juliana**, porque
filtra por id (armadilha 1).

⚠️ **Repare na `2023TR000039`:** ela está nas duas listas. A parcial diz "Juliana" com id 41,
e a PFINAL tem id 41 sem nome. Depois desta correção a TR vai mostrar **"Graciane" e
"Juliana" lado a lado** — não é regressão, é o defeito de contradição ficando visível. Ele já
está lá.

### ▶ O QUE FALTA — só a sua ordem

```
node corrigir_nome_analista.js                     # dry-run (rodado, 7/7 OK)
node corrigir_nome_analista.js --gravar            # grava, fonte = acervo
node corrigir_nome_analista.js --fonte=cadastro    # dry-run com a receita antiga
```

O comando de escrita é este `UPDATE`, repetido três vezes (uma por analista), com a lista
explícita de `codigo_pc` capturada antes:

```sql
UPDATE prestacoes_contas
   SET analista_nome = $2, atualizado_em = NOW()
 WHERE codigo_pc = ANY($1);
```

---

## 2 · A TELA ESTOQUE DE TRs — MOCKUP PRONTO, NADA IMPLEMENTADO

O mockup está publicado e usa o **logo real**, a **paleta real** e **TRs, entidades e
processos reais lidos do banco agora** — as cinco maiores entidades do acervo, que é onde a
largura dói. A fonte não é a Barlow (a página não pode buscar fonte externa); o resto é fiel.

### Cabeçalho — três mudanças, sem ambiguidade

| | antes | depois |
|---|---|---|
| altura da faixa (`.top`) | 54 px | **62 px** |
| logo do Estado | 40 px | **48 px** |
| caixa branca do logo (`min-width`) | 220 px | **240 px** — senão o logo encosta na borda |
| ícone de pessoas | não existe | **15 px, antes do ponto verde** |

### Tabela — saem BAIXADAS e ANALISTA

Você tem razão sobre o motivo: a TR some desta tela quando é assumida, então as duas só
sabiam mostrar `0` e `—`.

### ⚠️ DUAS DECISÕES QUE SÃO SUAS

**A) O Status entra na conta ou sai da tabela?**
Seus números somam exatos 100% **sem a coluna STATUS** (14+20+42+7+7+10). Mas você só mandou
tirar BAIXADAS e ANALISTA.

| | TR | SGPe MÃE | Entidade | PCs | NLs | Status | Ações |
|---|---|---|---|---|---|---|---|
| **A** — Status fica | 13% | 19% | **36%** | 6% | 6% | 10% | 10% |
| **B** — seus números | 14% | 20% | **42%** | 7% | 7% | — | 10% |

Recomendo **A**, e o motivo é o filtro "Todos": ali as cinco situações vêm misturadas e o
separador é a única pista. Na B o status não some — o separador `Livre — 788 TRs` continua
marcando cada bloco.

**B) A ENTIDADE quebra em duas linhas, ou continua cortando?**
Medido agora: o maior nome tem **81 caracteres** e **365 TRs passam de 60**. Hoje a coluna é
`nowrap` com reticências — o nome **nunca** aparece inteiro, só no `title`.
⚠️ **Largura não resolve sozinha:** mesmo com 42%, num monitor de 1366 px cabem ~55
caracteres. Para o nome aparecer inteiro, que é o que você pediu, ele precisa **quebrar**.
No mockup está quebrando.

### O que garante o `nowrap`, e não é a largura

Percentual em `<th>` é sugestão — o navegador estica a coluna se o conteúdo exigir. O que
**obriga** é `table-layout:fixed` no `<table>`. Sem ele os 20% do SGPe viram "o que sobrar" e
a TR quebra em duas linhas mesmo com o `nowrap` escrito.

O `SDR16 00003159/2013` que você citou tem 19 caracteres. **O maior do acervo tem 20** —
`ADR05  00001022/2017`, com dois espaços depois do ADR05. Está no mockup para conferência.

**Nenhuma linha do `index.html` foi alterada.** Decidido A ou B e a quebra, é uma rodada só.

---

## 3 · A TABELA `estoque` — O QUE DEPENDE DELA

### No banco: NADA

| | |
|---|---|
| FOREIGN KEYs apontando para ela | **0** |
| VIEWs que a mencionam | **0** |
| TRIGGERs | **0** |
| FUNÇÕES | **0** |
| tamanho em disco | 1.176 kB (a `prestacoes_contas` tem 20 MB) |

**4.476 linhas · 1.030 TRs · uma setorial.** `atualizado_em` vai de **14/06** a **18/07/2026**
— parada há um mês. E está **incompleta**: 536 TRs existem na `prestacoes_contas` e não nela.

### Na API: 6 rotas, e nenhuma tem consumidor

| rota | server.js | situação |
|---|---|---|
| `GET /estoque` | 710 | **sem consumidor.** O `index.html` não chama `/estoque` em lugar nenhum — a tela lê `GET /prestacoes_contas/resumo_tr` |
| `GET /estoque/:id` | 738 | sem consumidor |
| `PATCH /estoque/:id` | 747 | sem consumidor — **e ver o alerta abaixo** |
| `GET /estoque/grupos-analistas` | 838 | ⚠️ **INALCANÇÁVEL** — ver abaixo |
| `DELETE /migracao/limpar-estoque` | 1053 | migração antiga |
| `POST /migracao/estoque` | 1067 | migração antiga |
| `GET /contadores` | 1036 | ⚠️ **lê a `estoque`** — é o único consumidor vivo |

### ⚠️ TRÊS COISAS QUE APARECERAM AO MEDIR

**1. `GET /estoque/grupos-analistas` nunca roda — é a armadilha 13, viva.**
Ela é declarada na **linha 838**, depois de `/estoque/:id` na **linha 738**. O Express casa na
ordem: o pedido cai na rota de cima com `id = "grupos-analistas"`, e como `estoque.id` é
`integer`, o Postgres recusa e a rota devolve **HTTP 500**. É exatamente o caso do
`/usuarios/pendentes` que já está no `CLAUDE.md`.
E mesmo que rodasse, devolveria lixo: os **45** pares `(tecnico_nome, grupo)` têm
`grupo = NULL` nos **45**.

**2. `PATCH /estoque/:id` é um `UPDATE` aberto, sem credencial e sem lista de colunas.**

```js
for (const [k, v] of Object.entries(b)) { sets.push(`${k} = $${i++}`); values.push(v); }
await pool.query(`UPDATE estoque SET ${sets.join(', ')} WHERE id = $${i}`, values);
```

O **nome da coluna vem do corpo do pedido e é concatenado no SQL**. Não há conferência de
perfil, não há `usuario_id`, não há lista de colunas permitidas. Quem souber o endereço
escreve na tabela. É a mesma família da armadilha 8 — e some junto se a tabela sair.

**3. Sete chaves só existem na `estoque`, e não são dado — são lixo da carga.**

```
NULL   ·   2020TR000   ·   ANA CLAUDIA   ←  o nome de uma analista no campo TR
2023TR000114   ·   2023TR000845   ·   2023TR001063   ·   2021TR000719
```

A `2021TR000719` é uma das **"6 TRs que não casaram"** que o `CLAUDE.md` marca como lista
obsoleta — **é aqui que elas moram.** Não há PC nenhuma para elas na fonte única.

### O que se perde se apagar

Colunas que a `prestacoes_contas` não tem, e o quanto estão preenchidas:

| coluna | linhas com dado |
|---|---|
| `situacao` | 4.476 |
| `prazo_analise` | 3.802 |
| `assumido_em` · `tecnico_id` | **2** |
| `dev_motivo` · `dev_justificativa` · `dev_solicitado_por` | **1** |

As três de devolução têm **uma linha** cada — é o rastro do `confDev` morto, que gravava em
`db.from('estoque')` numa rota que nunca existiu. O `status` dela é uma **foto de 18/07**
(1.763 baixado · 1.488 livre · 684 análise · 541 diligência) e já não descreve o banco.

### A resposta curta

**Nada no banco depende dela.** Na API, o único consumidor vivo é o `GET /contadores`, e ele
só faz `COUNT(*)` — é uma linha da lista `tabelas` no `server.js:1036`.

**Se apagar, some junto:** as 6 rotas, um `UPDATE` sem credencial, e uma rota que devolve 500.
**O que precisa de decisão sua** é se a `situacao` e o `prazo_analise` (a foto de 18/07) têm
valor histórico. Se tiverem, o caminho é renomear para `_backup_estoque_20260816` em vez de
`DROP` — mesmo custo, e reversível.

⚠️ **Vale para a `planilha_analista` no mesmo movimento:** 3.122 linhas, última atualização
**14/06/2026**, já marcada como DESCONTINUADA no `CLAUDE.md`, e com as mesmas rotas de
migração apontando para ela. **E o `desfazer_assuncoes.js` mexe nas duas e em nenhuma outra**
— se rodar hoje não faz nada de útil.

---

## O QUE NÃO FOI FEITO, E POR QUÊ

- **Nenhuma escrita no banco.** O dry-run está conferido; falta a sua ordem (regra 1).
- **O `index.html` não foi tocado** — as duas decisões da tela são suas, e você disse que vai
  colar o print.
- **O `MAPA_NOME` do `lib/assumir.js` não foi corrigido** — muda o nome que 5 analistas veem
  na tela, e isso é regra (regra 2).
- **Nada foi commitado nem publicado** (regra 3).
