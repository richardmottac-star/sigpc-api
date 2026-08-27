# SIGPC-API — ESTADO EM 27/08/2026

Cole no início do chat novo. Este arquivo é o que basta para retomar.

---

## ✅ 27/08/2026 — A CONFERÊNCIA COM O SIGEF. Leia isto antes de tudo.

> **TRÊS escritas em produção**, todas de estrutura + carga da planilha da CGE.
> **Nenhuma tocou em `baixada`, `enviado_ci`, `data_baixa`, `parecer_tipo` ou produtividade** —
> e cada uma provou isso com um `md5` do conteúdo de TODAS as colunas pré-existentes, linha a
> linha, antes e depois.

### O acervo, medido em 27/08 (não presumido)

| | |
|---|---|
| PCs | **14.658** (13.627 parciais · 1.031 finais) |
| TRs | **1.560** |
| baixadas | **4.063** · enviadas ao C.I. **3.161** |
| **produtividade** (`baixada` OU `enviado_ci`, PCs distintas) | **4.064** |
| sem dono | 6.055 |
| usuários | **54** (46 analista · 3 coordenador · 4 controle_interno · 1 superadmin) |
| colunas em `prestacoes_contas` | **57** |

⚠️ Os números antigos deste arquivo (14.652 PCs, 1.559 TRs, 6.090 sem dono) estão
**desatualizados, não errados** — o acervo andou.

### 1. As QUATRO colunas do SIGEF

O extrato `Baixas FCEE.xlsx` da CGE (3.359 parciais + 107 finais = **3.466 PCs**) entrou em
três rodadas, cada uma com dry-run mostrado antes:

| coluna | tipo | o que é | preenchidas |
|---|---|---|---|
| `data_baixa_sigef` | `date` | quando o SIGEF foi modificado (col. `Data Ult Mod - 07-08-26`) | **3.466** |
| `sigef_status` | `text` | o rótulo **literal** do SIGEF | **3.466** |
| `sigef_registro_em` | `date` | a data que o ANALISTA informa ter registrado | **0** |
| `sigef_declaracao` | `jsonb` | a declaração do analista — **array que só cresce** | **0** |

⚠️ **`data_baixa` NÃO FOI TOCADA, e não deve ser.** Ela é o carimbo do SISTEMA (quando o
SIGPC-GT registrou) e é ela que a produtividade usa. `data_baixa_sigef` é o carimbo do SIGEF.
São perguntas diferentes. **Qual das duas o relatório trimestral vai usar é decisão do
Richard, e não foi tomada.**

⚠️ **`sigef_status` NÃO SUBSTITUI `parecer_tipo`.** São duas fontes sobre a mesma PC, e
**38 discordam** em ressalva (das 3.064 com parecer dos dois lados). A discordância É o achado;
normalizar o rótulo para "ficar igual" a apagaria. Consultável direto:

```sql
SELECT codigo_pc, tr, analista_nome, sigef_status, parecer_tipo
  FROM prestacoes_contas
 WHERE sigef_status IS NOT NULL AND parecer_tipo IS NOT NULL
   AND (sigef_status ILIKE '%ressalva%') <> (parecer_tipo ILIKE '%ressalva%');
```

⚠️ **A data foi lida TRÊS vezes por caminhos independentes** e o script aborta se divergirem:
o `Date` do `cellDates`, o serial cru via `SSF.parse_date_code` (sem fuso) e o texto `m/d/yy`.
`11/4/25` é 04/11 ou 11/04 conforme a leitura. **0 divergências em 3.466 linhas.**

⚠️ **A aba `Parciais -TEVs` tem DUAS colunas `Parcial`** (índices 8 e 11) — armadilha 16-A.
Toda leitura é por ÍNDICE, com o nome do cabeçalho conferido antes.

### 2. As TRÊS situações — calculadas, NUNCA gravadas

| tag | regra | PCs |
|---|---|---|
| `SEM_REGISTRO_SIGEF` | `baixada`, `parcial`, sem `sigef_status` | **353** |
| `ABERTA_COM_BAIXA_SIGEF` | tem `sigef_status` e `baixada = false` | **401** |
| `VERIFICAR_FINAL` | `baixada`, `final`, sem `sigef_status` | **284** |
| `REGISTRO_DECLARADO` | as duas primeiras, já declaradas | 0 |

**Todas com `data_baixa < 2026-08-01`.** As três não se sobrepõem; 13.620 ficam sem tag.

⚠️ **NÃO EXISTE COLUNA `sigef_tag`, E NÃO PODE HAVER.** Ela mudaria sozinha a cada extração
nova da CGE e ficaria mentindo até alguém rodar um script. O que se grava é o FATO; a tag é
leitura, feita na hora, por `sigef.SQL_TAG` colado no SELECT.

⚠️ **O CORTE 01/08 VALE PARA AS TRÊS** — decisão do Richard, 27/08. Sem ele em
`VERIFICAR_FINAL` a conta dá **324** em vez de 284: são **40 finais** baixadas em agosto,
posteriores à extração. Acusá-las mandaria o analista conferir o que está certo.
(As parciais de agosto na mesma situação são **321**.)

⚠️ **O corte é inequívoco:** 0 PCs com `data_baixa` entre 31/07 20h e 01/08 04h. Não é caso da
armadilha 18 — é data fixa histórica contra coluna naive, sem conversão nenhuma.

### 3. A declaração do analista — **por PARCELA**

`POST /parcela/sigef_declaracao`, chave `(setorial_id, tr, parcial_num)` — a MESMA de
`carregarParcela`, do parecer e do C.I.

⚠️ **NASCEU POR `codigo_pc` E DUROU MEIO DIA.** O modal dizia "Vale para a PC 2021PC002125", e
numa parcela de 7 PCs o analista declarava sete vezes o mesmo fato. **A rota antiga foi
REMOVIDA, não comentada** — viva, seria um segundo caminho de escrita na mesma coluna, sem a
conferência de tag.

⚠️ **A TAG ENTRA NA CHAVE, e é RECALCULADA NO BANCO.** Uma parcela pode ter parciais vermelhas
ao lado da final azul; a declaração alcança só as PCs na tag do modal aberto. E a tag do corpo
**não escolhe linha** — ela é comparada com a do banco. Aceitá-la como alvo deixaria o cliente
escolher onde escrever.

⚠️ **A DECLARAÇÃO NÃO SE DESMARCA.** Não há rota de apagar, e o SQL só sabe apendar
(`sigef_declaracao || $2`). Se o analista errar, declara de novo e as duas ficam. **É a forma
do dado que impede o desfazer** — três colunas soltas permitiriam um `SET declarou = false`.

⚠️ **Só a vermelha e a azul aceitam declaração.** Na âmbar o SIGEF já registrou: o que falta é
o parecer AQUI, e a rota responde 409. Os próprios textos da tela dizem isso.

⚠️ **`podeDeclararParcela` exige ser responsável por TODAS as PCs alcançadas**, não por uma:
numa parcela de dono misto, bastar uma deixaria alguém gravar no acervo de outro.

### 4. As tags na tela — um componente, quatro lugares

Fila do analista · cartão da parcela · Estoque · Produtividade. `_sigefBadge` desenha;
`sigefBadges(pcs)`, `sigefBadgesDeTags(tags,n)` e `sigefBadgesContagem(mapa)` só decidem
quantas. **A tag chega pronta em `pc.sigef_tag`** — a tela não classifica nada.

O texto das quatro situações está em `SIGEF_TAGS`, **uma vez só**, e o balão do "?" lê dali.
O "?" é um **botão**, não um `title`: o texto tem quatro linhas e diz o que fazer.

Na âmbar o modal mostra **o que o SIGEF registrou** (PC · parecer · data, uma linha por PC) e
o botão **"→ Ir para a parcela"**, que chama `irPlanilha(tr, parcial)`.
⚠️ **Ele NÃO baixa nada** — a baixa continua sendo o passo do parecer. Um atalho que baixasse
do modal seria um terceiro caminho de baixa, sem parecer e sem trilha.

### 5. ⚠️ O DEFEITO QUE CUSTOU UMA REVERSÃO — e a lição

O `migracao_sigef_status_20260827.js --gravar` rodou **uma segunda vez**. Como o script é
idempotente, `valores_anteriores` saiu **vazia** e sobrescreveu o arquivo que guardava as
**3.466 chaves** do caminho de volta. **As 16 conferências passaram. O script disse COMMIT.**
Só não se perdeu porque havia uma cópia tirada minutos antes.

> **A lição não é "não rode duas vezes".** Idempotência existe para que rodar de novo seja
> seguro. Se rodar de novo destrói alguma coisa, o script era idempotente **no banco** e
> destrutivo **no disco**.

Corrigido em `lib/reversao.js`, e os três scripts de 27/08 passam por ela: quando já existe uma
reversão com `modo: "gravacao"`, escreve **ao lado** com sufixo de hora e preserva a antiga.
O critério é `modo === 'gravacao'`, **não** "tem conteúdo" — uma gravação legítima pode ter a
lista vazia e ainda ser o registro de que a escrita aconteceu.
`teste_reversao.js`, 31 checagens, em pasta temporária.

### 6. O que foi publicado em 27/08

| repo | commit | o que é |
|---|---|---|
| `sigpc-api` | `e5f13d3` | `data_baixa_sigef` — a data real da baixa no SIGEF |
| `sigpc-api` | `07ad70e` | `sigef_status` e `sigef_registro_em` |
| `sigpc-api` | `96da540` | `lib/sigef.js`, as tags, a coluna `sigef_declaracao`, a rota |
| `sigpc-api` | `5f14482` | a declaração passa a ser por **parcela**, numa transação |
| `sigpc-api` | `a781c18` | `lib/reversao.js` — a reversão deixa de ser destruída |
| `sigpc-gt` | `1d316b6` | as tags nas quatro telas |
| `sigpc-gt` | `d38e7d5` | o modal fala de parcela, e declara numa chamada |
| `sigpc-gt` | `ea51384` | a âmbar mostra o do SIGEF e leva à parcela |

**Testes:** `sigpc-api` **24 suítes · 1.717 checagens · 0 falhas**.
⚠️ `sigpc-gt`: **19 checagens falham em 7 suítes** (`acoes` 1 · `busca` 2 · **`ci_fila` 10** ·
`links` 1 · `menu` 1 · `painel` 3 · `vercomo` 1). **Todas anteriores a esta frente** —
conferido restaurando o `index.html` de `8ac96f0`. Não foram olhadas uma a uma.

⚠️ **Cuidado ao contar falhas com `grep -v "0 falharam"`:** ele esconde "1**0** falharam". Foi
assim que as 10 do `ci_fila` ficaram invisíveis por meio dia.

### 7. O que ficou registrado e SEM EXECUTAR

- **As 19 checagens do front**, acima.
- **`ZZ TESTE TRAVA` (id 57) virou `controle_interno`, grupo 3, e está ATIVO.** Era analista
  quando esta pendência foi escrita. Como técnico do C.I., ele vê a fila do Controle Interno.
- **O cadastro diz `Sirlene Wolf dos Santos`** (id 64), e este documento dizia "Sirene".
  Corrigido — a armadilha 1 exige o nome copiado exatamente como está no cadastro.
- **A auditoria planilhas × base** continua aberta, sem medição.
- **Nove `.md` de diagnóstico** de 26–27/08 não versionados na raiz do `sigpc-api`.

---

## ✅ 17/08/2026 — O FECHAMENTO.

> **UMA escrita no banco em 17/08: o aviso id 6, às 09h54.** Uma linha, duas colunas.
> A **madrugada** (00h–01h30) foi só tela e documentação. As **doze escritas** grandes são de
> 16/08 e estão no bloco seguinte.

**Cinco commits, os dois repositórios publicados, nada pendente na árvore de trabalho.**

| repo | commit | o que é |
|---|---|---|
| `sigpc-gt` | `18a8e1e` `6130178` | as larguras finais do Estoque — a **entidade** cedeu os 10% do Status |
| `sigpc-gt` | `72d2d13` | **regressão corrigida:** a etiqueta de reserva vazava por cima do SGPe MÃE |
| `sigpc-gt` | `2f151f6` → `cbaf55c` | a **faixa de avisos** no Dashboard — primeiro errada (bloco parado), depois certa (rolando) |
| `sigpc-api` | `ea3f7ee` | `atualizar_aviso_id6.js` nasce — dry-run |
| `sigpc-api` | **09h54** | **o aviso id 6 GRAVADO** — texto curto e `fim` em 31/08 |

### ✅ 1. O AVISO id 6 — **GRAVADO EM 17/08/2026, às 09h54**

**Ordem do Richard: trocar o texto E estender o fim para 31/08.** As duas coisas foram numa
**única transação**, com as **9 conferências** passando depois da escrita.

| coluna | antes | depois |
|---|---|---|
| `texto` | 233 caracteres | **179** — saíram 54 |
| `fim` | `2026-08-18` | **`2026-08-31`** |

Os primeiros **178 caracteres são idênticos**: saiu a cauda *": há orientações sobre o que
verificar e como proceder."* e entrou *"."*.

**Não mudaram:** `inicio` (17/08), `escopo` (`urgente`), `ativo`, `grupo` (todos), `ordem`.
**Conferido depois do COMMIT, em conexão nova:** `lib/faixa.ativas()` devolve o id 6, e o
aviso id 5 (inativo) continua intacto.

**Reversão:** `reverter_aviso_id6_20260817.json`, com o texto e o `fim` antigos.

⚠️ **ESTE SCRIPT MUDOU DE ESCOPO.** Até 17/08 ele trocava **uma** coluna e o cabeçalho dizia,
com todas as letras, que não encostava em `fim`. Agora são **duas**, e é de propósito: duas
escritas separadas na mesma linha deixariam uma janela com o texto novo e o prazo velho.

⚠️ **Vai por script e não por `psql` de propósito:** o texto tem travessão, acento e cedilha, e
o `$1` do `pg` entrega a string byte a byte. Colar SQL com acento no terminal do Windows é como
se perde um "ç" sem ninguém ver.

⚠️ **`fim` é `DATE`, e o `pg` devolve `DATE` como objeto `Date`** — armadilha 25. Por isso toda
leitura de data no script sai do banco **já como texto ISO** (`to_char`), e nenhuma comparação
passa por `String(new Date(...))`, que daria `"Sun Aug 31 2026 ..."`.

⚠️ **O `fim` é INCLUSIVO** — `lib/faixa.js` filtra `fim >= HOJE_BR`. O aviso passa o dia **31
inteiro** e some em **01/09**.

⚠️ **A conferência "nenhum outro aviso foi tocado" deixou de ser uma CONTAGEM.** Ela era
`COUNT(*) = 1`, e a contagem continuaria 1 se um `UPDATE` largo tivesse reescrito o texto do
vizinho. Agora é `md5(string_agg(...))` de todas as outras linhas, antes e depois. **Contar
linhas não prova que elas não mudaram.**

### 🔴 2. O QUE AINDA ESPERA UMA ORDEM SUA — o `isMeuTR`

**O conserto certo é NESTE repositório.**
A tela decide "esta TR é minha" **comparando NOME**, com uma segunda cópia do mapa de nomes
curtos (`MAPA_PLAN_EST`, no `index.html`) — a **mesma tabela** que estava quebrada no
`lib/assumir.js`, com **as mesmas três chaves mortas**. Para Sandra Rocha (19), Ana Claudia
(22), Ana Letícia (23), Goreti (40) e Janaína (51) o botão **"Ver" não aparece** no Estoque.

⚠️ **NÃO foi corrigido de propósito**, e o motivo é que copiar o mapa arrumado repetiria o
defeito. O certo é a **armadilha 1**: comparar por `analista_id`. Mas
`GET /prestacoes_contas/resumo_tr` **não devolve `analista_id`** — só `MAX(analista_nome)`.

| saída | o que custa |
|---|---|
| **certa** — `MAX(analista_id)` no `resumo_tr` + `isMeuTR` por id | mexe na rota; **mata o `MAPA_PLAN_EST` inteiro** |
| paliativa — arrumar as 3 chaves no `index.html` | resolve hoje e deixa a segunda cópia viva, para divergir de novo |

**É decisão sua**, porque é frente nova no servidor e não o defeito que você relatou.

### Os testes, medidos agora — não copiados de ontem

| repo | suítes | checagens | falhas |
|---|---|---|---|
| `sigpc-api` | **19** | **949** | **0** |
| `sigpc-gt` | **18** | **1.033** | **0** |

⚠️ **Existe uma 20ª suíte no `sigpc-api` que NÃO está no `npm run teste`:
`teste_rotas_parcela.js`.** Ela é de **integração** — sobe contra servidor e banco de verdade,
e sozinha devolve `fetch failed`. **Isso não é regressão**, é o que ela é; não a inclua na
cadeia achando que está faltando.

---

## ⚠️ O RELATO DA NOICI (2020TR000761) — E UMA CONCLUSÃO ERRADA QUE FICA REGISTRADA

### ❌ Primeiro, o que estava errado aqui — retratado em 16/08/2026

Este arquivo chegou a afirmar que **"a recarga de 05/08 apagou trabalho de analista — perda
confirmada"**, com 3.619 PCs e 45 analistas "expostos". **Era falso, e a premissa também.**

⚠️ **O sistema só foi liberado aos analistas em 12/08/2026, às 20h.** Antes disso quem usava
era o Richard, testando. **Em 05/08 não havia analista nenhum dentro do sistema** — logo a
recarga daquele dia não tinha trabalho de analista para apagar.

**O erro de método, para não repetir:** eu medi a *ausência* de histórico antes de 05/08 e li
como *apagamento*. Uma tabela vazia num período em que ninguém usava o sistema não é prova de
perda — é exatamente o que se espera. **Falta de dado não é evidência de dano.** A pergunta que
eu não fiz, e que teria derrubado a conclusão em um minuto, é *"quando o sistema abriu?"*.

### O que o banco mostra, medido em 16/08

**A linha do tempo do `parcela_historico` bate com a abertura em 12/08:**

| dia | linhas | TRs | analistas |
|---|---|---|---|
| 05/08 | 6 | 5 | 0 — todas `migracao_ci`, script |
| **12/08** | **28** | 14 | **5** |
| 13/08 | 211 | 90 | 17 |
| 14/08 | 415 | 122 | 16 |
| 15/08 | 47 | 11 | 4 |
| 16/08 | 36 | 4 | 3 |

**Não houve recarga depois de 12/08.** Só existem três valores de `origem_baixa`:
`carga_historica`, `recarga_parcial_20260805` (todas com `data_baixa = 30/06`) e `sistema`
(211 PCs, de 12/08 a 16/08 — o trabalho real na tela).

**A Noici (id 31) não tem NENHUM registro no sistema:** 0 linhas em `parcela_historico`, como
autora ou executora, e nenhuma baixa com `origem_baixa = 'sistema'` em nenhum dos cinco dias.

### A explicação do relato, com a planilha dela na mão

A `2020TR000761` tem **44 PCs em 18 parciais, 37 baixadas**. Na planilha do Grupo 2, abas
`Planilha1` e `backup`, ela tem **17 linhas** para essa TR:

| situação na planilha | linhas | foi para o sistema? |
|---|---|---|
| Parecer Regular | 6 | **sim** |
| Parecer Regular com Ressalvas | 9 | **sim** |
| **Análise** | **2** | **NÃO** |

⚠️ **`recarga_exec.js:50-55,72` — o `ehBaixada()` só aceita parecer e C.I.** Tudo que era
*Análise*, *Diligência* ou complementação documental **nunca foi carregado**. E a aba
`Anexo IV` da mesma planilha traz **122 linhas** dessa TR com *Em Análise* (72) e *Em
Diligência* (50) — nada disso existe no sistema.

**A conclusão que o dado sustenta:** o trabalho dela estava **na planilha**, e a migração
carregou **só os pareceres**. Não é apagamento — é **estado que nunca foi importado**. O que
ela procurou e não achou é o acompanhamento (diligência, análise, complementação), que o
`ehBaixada()` descartou por construção.

**E "a PC 18 não existe" se inverte:** a base tem **18 parciais**, a planilha dela tem 17. O
sistema tem *mais*, não menos.

### O que fica valendo

- **Nada a corrigir na 2020TR000761.** Não houve perda; houve importação parcial por desenho.
- ⚠️ **A lacuna real é de FUNCIONALIDADE, não de dado:** o acompanhamento anterior a 12/08 —
  diligências, análises e complementações — **não está no sistema para ninguém**, porque a
  carga só trouxe parecer/C.I. Quem lembrar de trabalho "que sumiu" desse período vai estar
  falando disto, e a resposta é honesta: nunca entrou.
- **O `recarga_exec.js` continua desarmado** (o pacote `xlsx` não está instalado no projeto).
  Se for rearmado, a zeragem universal de `recarga_exec.js:263` passa a ser perigosa **agora
  que há analista dentro** — o que não era verdade em 05/08.

## ✅ 16/08/2026 — O ESTADO DE HOJE. Leia isto primeiro.

**DOZE escritas em produção**, todas com backup, conferência pós-escrita e ROLLBACK se não
batesse. Publicado nas duas branches dos dois repositórios.

| | |
|---|---|
| **Banco** | **14.658 PCs** · 1.031 finais · 760 no histórico · 3.804 baixadas |
| **C.I.** | **2.318** com `enviado_ci` — 585 `na_fila` · 1.733 `encerrado` |
| **Sem dono** | **6.090 PCs, todas `livre`** — nenhuma fora disso, nenhuma órfã em TR com dono |
| **Nome do analista** | **0 PCs com `analista_id` e sem `analista_nome`** (eram 18) |
| **Testes** | 19 suítes no `sigpc-api` · **17** no `sigpc-gt` (983 checagens) · 0 falhas |

### O que foi gravado

1. **Renumeração pelo SIGEF** — 2.432 PCs · 1.408 parciais · **211 TRs** (2.151 no lote + 281 das 15 TRs que tinham ficado fora)
2. **Histórico realinhado** — 103 linhas movidas · **15 cópias** onde a parcela se parte
3. **Controle Interno** — 1.699 marcadas + **33 da Simone** (registro retroativo)
4. **Histórico sem dono** — 28 linhas com `analista_id` preenchido
5. **6 PCs incluídas** — as únicas que faltavam de verdade
6. **87 PCs** sem dono com `status='analise'` → `livre`
7. **78 PCs soltas** em TR com dono → atribuídas ao dono
8. **18 PCs sem `analista_nome`** → preenchido pelo nome que o **acervo** já usava
   (`corrigir_nome_analista.js`, backup `_backup_nomevazio_20260816`). 14 da Noici, 2 da Ana
   Claudia, 2 da Graciane — **todas baixadas, e nem a baixa nem o parecer foram tocados**:
   as 24 outras colunas foram conferidas uma a uma contra o backup, na mesma transação.

### E as DUAS correções de código que saíram do dia

**`lib/assumir.js` — o `MAPA_NOME` tinha TRÊS CHAVES MORTAS.** `Sandra Rocha`, `Ana Claudia` e
`Ana Leticia` eram o nome **curto**, e a chave é o `usuarios.nome`: nunca disparavam. **Cinco
analistas** saíam com o rótulo errado, e **os ids 22 e 23 viravam os dois "Ana"**. Estava vivo
em `POST /tr/assumir`. Mapa agora com **10 chaves** (entraram a Goreti, chamada pelo *segundo*
nome, e a Janaína, cujo acervo é **sem acento**). Conferido contra o banco: **0 divergências**
nos 45 ids.

**A tela Estoque de TRs** — cabeçalho maior, e a tabela sem as duas colunas mudas. Detalhe no
`SESSAO.md` do `sigpc-gt`. **Não foi aberta no navegador** — é o que ficou para o Richard.

⚠️ **A LIÇÃO QUE ATRAVESSA AS DUAS:** a receita da correção estava escrita neste arquivo
(*"é de uma linha, `nomeCurto(usuarios.nome)`"*) e **estava errada** — ela teria escrito "Ana"
onde o acervo diz "Ana Claudia". **Receita registrada não é receita medida.** Rodar o dry-run
contra o banco antes de acreditar no que o próprio documento manda fazer é o que pegou isso.

---

### ⚠️ A REGRA QUE MUDOU: um processo SGPe carrega VÁRIAS parcelas do SIGEF

**113 pares (TR, processo), 78 TRs, 465 PCs**, medidos no estoque da CGE por dois agentes
cegos um ao outro. A `2019TR000193` tem 11 parcelas num processo. A direção contrária existe
em 81 pares — **a relação é N:N**. A armadilha 16 foi reescrita: a regra antiga tinha sido
lida do banco **já deformado** pela recarga de 05/08.

**Duas armadilhas de leitura que saíram disso:** a aba `Parcial` do estoque tem **DUAS colunas
com esse nome** (ler por índice), e **`Parcial` × `PARCELA N°` dá 113 contra 2.372** — a coluna
errada inverte a resposta.

### ⚠️ O defeito de fundo, corrigido em TRÊS rotas

`parecer`, `estornar` e `ci` faziam `UPDATE ... WHERE tr AND parcial_num` **sem filtrar
`baixada`**. O 409 não protege: só dispara quando **todas** estão baixadas. Em parcela mista o
parecer reescrevia `data_baixa` e `parecer_tipo` de PCs fechadas em junho. **Ninguém reclama
de uma baixa que ficou mais recente.**

### ⚠️ "Livre" passou a ter UMA definição só

`lib/assumir.js` → `PC_LIVRE_SQL = 'analista_id IS NULL AND status = \'livre\''`.
O `SQL_LIVRES`, o `resumo_tr` (`pcs_livres`) e a tela usam **a mesma string**. Antes a tela
derivava de `!analista_nome` e o assumir exigia os dois — **87 PCs em 6 TRs** apareciam como
Livre e recusavam ao assumir, desde 10/08.
⚠️ **TR com dono nunca é Livre**, mesmo com PC solta dentro.

### ⚠️ A data do C.I. não é data de envio

`data_baixa`, `dt_envio_ci` e `dt_situacao` são `timestamp` **em UTC**, e o Railway roda em
`Etc/UTC`: depois das 21h de Brasília o `slice(0,10)` mostrava o dia seguinte. Agora
`planData` (coluna `date`) e **`planDataTs`** (timestamp) são funções separadas — juntar as
duas faria os prazos mostrarem a véspera. E **meia-noite cravada não é convertida**: a carga
gravou `data_baixa = 30/06` sem hora, e converter voltaria 3.619 baixas um dia.

Quando `dt_envio_ci == data_baixa`, a faixa diz **"registrado em"** e o contador de espera
some — a data real do envio está no SIGEF, não aqui.

### ⚠️ `recarga_exec.js` DESARMADO
A linha 263 zera `baixada`, `parecer_tipo` e `parcial_num` nas 14.652. Em 05/08 foi inofensivo
(o sistema abriu aos analistas em **12/08 às 20h**); hoje apagaria trabalho de 45 analistas.

### Encaminhar ao C.I. em lote
`POST /parcela/ci_lote` — uma transação, lista explícita, **tudo ou nada**, uma linha de
histórico por parcela. Na tela: checkbox só no passo 2, a etiqueta `🏛 N sem C.I.` seleciona
todas da TR, barra no rodapé, uma confirmação. Existe porque são **764 parcelas** fora do C.I.

---

### 🔴 O QUE FICOU ABERTO

- **1.361 PCs baixadas com parecer fora do C.I.**, em 41 analistas (+126 finais). Listas por
  analista em `CI_PENDENTE_POR_ANALISTA/`. **Não quer dizer que não foram — quer dizer que o
  sistema não sabe.** A planilha do C.I. veio incompleta: das 33 da Simone, nenhuma estava lá.
- **A frente das PCs ausentes está DESATIVADA.** Das 180 linhas do CSV, **129 o banco já tem
  completas** e a coluna `valor` é o total da **parcela** — 130 das 180 têm esse valor igual ao
  centavo à soma já gravada. Precisa de **uma linha por PC com o valor da PC**.
- **56 TRs não fecham `1..N`** (8 → 56). **42 são de 2024 sem analista, faltando só o número 1.**
- **3 parcelas mistas** (`2020TR000761 p17` · `2021TR002375 p1` · `2022TR001248 p7`) e 38 com
  2+ processos nas 15 TRs — consequência aceita do split.
- **`2022TR001687`**: a PC baixada tem `analista_id = 45` (Juliana) e `analista_nome =
  'Tanimeri'`. **Dois donos em dois campos** — a produtividade conta para a Juliana.
- **18 PCs em 5 TRs com `analista_id` sem `analista_nome`** — o inverso do caso acima.
- **`2022TR000720`** está com a Marlene, não com o Rafael. As 2 PCs estão **baixadas**.
- **9 processos digitados errado no CSV** — resolvem pelo lápis.
- **20 processos do C.I.** sem dado em planilha nenhuma.
- **77 PCs com `processo_pc = '-1'`** — a etiqueta âmbar mostra onde. O cruzamento com as
  planilhas **não recuperou nenhuma com segurança** (12 candidatos, todos reprovados pela
  armadilha 19).

### Os backups de hoje — não apagar
```
_backup_exec_pc_20260816      _backup_exec_hist_20260816     (frentes 1, 3, 4)
_backup_15trs_pc_20260816     _backup_15trs_hist_20260816    (as 15 TRs)
_backup_5pcs_20260816         _backup_5pcs_20260816b         (as 6 PCs)
_backup_ci_simone_20260816    _backup_87livres_20260816      _backup_soltas_20260816
```

### As lições do dia
1. **Falta de dado não é evidência de dano** — afirmei que a recarga de 05/08 apagou trabalho;
   o sistema só abriu em 12/08. Retratado.
2. **Trava que imprime e não usa a variável não é trava.** Duas vezes hoje.
3. **Check absoluto sobre a base inteira acusa o passado** — compare com a foto do início.
4. **O JOIN contra o backup é cego para a linha que acabou de nascer** (R$ 890 mi passaram em
   11 conferências).
5. **Quem decide o que é um processo é a `lib/sgpe-link.js`** — regex próprio recusou 70 PCs.
6. **Comentário dentro de template literal não leva crase** (armadilha 10) — três vezes.
7. **A manutenção precisa de um ciclo do polling (20s)** para derrubar a tela.
8. **Teste que casa a redação impede refatoração** e não pega defeito nenhum.

---

---

## 📌 PENDÊNCIAS REGISTRADAS EM 16/08/2026 — NÃO EXECUTAR SEM ORDEM

### 1. ✅ PCs soltas em TR com dono — **JÁ FOI FEITO**, fica aqui só para não ser refeito

O Richard pediu para registrar como pendência, mas **isto foi executado** em 16/08
(`atribuir_soltas.js`, commit `800aa0b`): **78 PCs em 5 TRs** atribuídas ao dono da TR.

| TR | dono | soltas |
|---|---|---|
| `2020TR000632` | Aline | **66 de 70** |
| `2020TR000723` | Noici | 9 de 32 |
| `2022TR001328` | Graciane | 1 de 2 |
| `2022TR002068` | Juliana | 1 de 3 |
| `2020TR000940` | Ana Claudia | 1 de 2 |

**Conferido depois:** "TR com dono e PC solta" = **0**. Backup `_backup_soltas_20260816`.
⚠️ **Não repetir** — rodar de novo não acha nada, mas a lista acima já não descreve o banco.

### 2. ✅ 18 PCs em 5 TRs com `analista_id` SEM `analista_nome` — **GRAVADO em 16/08/2026**

O inverso da `2022TR001687` (onde o nome contradiz o id). Aqui o id existia e o nome era NULL:

| TR | PCs | `analista_id` | nome gravado | baixadas |
|---|---|---|---|---|
| `2020TR000723` | **14** | 31 | **Noici** | 14 |
| `2020TR001636` | 1 | 22 | **Ana Claudia** | 1 |
| `2021TR002029` | 1 | 22 | **Ana Claudia** | 1 |
| `2023TR000039` | 1 | 41 | **Graciane** | 1 |
| `2022TR001328` | 1 | 41 | **Graciane** | 1 |

Feito por `corrigir_nome_analista.js --gravar`. Backup `_backup_nomevazio_20260816` (14.658
linhas) e reversão em `reverter_nomevazio_20260816.json`. **Conferido depois de gravar, na
mesma transação, 7 checagens**, e de novo em conexão nova: `analista_nome` mudou em **18**;
baixa, parecer, C.I., valor, status, `analista_id` e `parcial_num` mudaram em **0**.
Hoje "PC com id e sem nome" = **0**.

⚠️ **Todas as 18 estavam BAIXADAS** — por isso o `atribuir_soltas.js` não as tocou: ele só
mexe em PC livre. A produtividade sempre **contou certo** (filtra por `analista_id`,
armadilha 1); quem mentia era a tela, que mostrava o nome vazio.

### ⚠️ E O QUE ESTA PENDÊNCIA REVELOU: o `MAPA_NOME` tinha TRÊS CHAVES MORTAS

**A receita escrita aqui estava errada.** Dizia *"a correção é de uma linha —
`analista_nome = assumir.nomeCurto(usuarios.nome)`"*. Medida contra o banco, essa linha
escreveria **"Ana"** nas duas PFINAIS da Ana Claudia, contra as **105** PCs dela que dizem
"Ana Claudia". Por isso a gravação usou o **acervo** como fonte — o nome que o próprio
`analista_id` já tem nas outras PCs dele.

A causa: **três chaves do `MAPA_NOME` eram o nome CURTO, não o `usuarios.nome`** — e por isso
**nunca disparavam**. Não existe usuário chamado "Sandra Rocha", "Ana Claudia" nem
"Ana Leticia": o `MAPA_NOME[n]` não casava e a função caía no `split(' ')[0]`.

Eram **5 analistas** com rótulo errado, e **dois deles colapsavam no mesmo "Ana"**:

| id | `usuarios.nome` | dava | o acervo tem |
|---|---|---|---|
| 19 | Sandra Cezária Ronchi Rocha | `Sandra` | **Sandra Rocha** (354) |
| 22 | Ana Claudia Carvalho Costa | `Ana` | **Ana Claudia** (105) |
| 23 | Ana Letícia Wloch de Oliveira | `Ana` | **Ana Leticia** (147) |
| 40 | Maria Goreti Korb | `Maria` | **Goreti** (52) — chamada pelo SEGUNDO nome |
| 51 | Janaína Frederico Dittrich | `Janaína` | **Janaina** (188) — o acervo é sem acento |

⚠️ **Estava no ar**: `nomeCurto()` é chamado em `POST /tr/assumir` (server.js:2489 e 2501), na
transferência do motivo 1 do pedido de devolução (3082 e 3095) e no `atribuir_soltas.js`.
Qualquer uma das cinco assumindo uma TR ganhava um **segundo nome** no acervo.

**Corrigido em 16/08:** o mapa passou a **10 chaves**, todas `usuarios.nome`. Conferido contra
o banco: **0 divergências** entre `nomeCurto()` e o nome dominante dos 45 ids, e as 10 chaves
casam com um id real. `teste_assumir.js` foi de 47 para **56** checagens, com uma que percorre
o mapa inteiro e recusa chave que seja apelido.

⚠️ **Ao acrescentar alguém ao mapa, copie o `usuarios.nome` exatamente, ACENTO INCLUSIVE** —
a comparação é literal, e uma entrada que não dispara **não dá erro**: só devolve outro nome.

### 2-B. ⚠️ Os vizinhos: 10 PCs em que o nome CONTRADIZ o id — **NÃO corrigidas**

| id | cadastro | nomes gravados |
|---|---|---|
| 41 | Graciane Mondardo Constantino | Graciane (40) · **Juliana (1)** |
| 45 | Juliana de Souza | Juliana (163) · **Marlene (2)** · **Tanimeri (1)** |
| 47 | Rafael | Rafael (135) · **Samoel (4)** · **Guilherme (1)** |
| 48 | Samoel | Samoel (41) · **Elisandra (1)** |

A `2022TR001687` já registrada é uma destas. ⚠️ **A `2023TR000039` está nas duas listas**: a
parcial diz "Juliana" com `analista_id = 41`, e a PFINAL que acabou de ser preenchida diz
"Graciane". A TR mostra os dois nomes — não é regressão, é a contradição ficando visível.
**A produtividade conta pelo `analista_id`**, então o número está certo nos dois casos.

### 3. ✅ Os ajustes da tela **Estoque de TRs** — **FEITOS em 16/08/2026**

Cabeçalho: faixa **54 → 62 px**, logo do Estado **40 → 48 px**, caixa branca **220 → 240 px**,
e o **ícone de pessoas antes do ponto verde** de "N usuários online".

Tabela: **BAIXADAS e ANALISTA saíram** (9 colunas → 7), entidade com a maior largura e
**quebrando em mais de uma linha**, cabeçalho centralizado, `nowrap` na TR e no SGPe MÃE.
Larguras: TR 14% · SGPe 20% · **Entidade 32%** · PCs 7% · NLs 7% · Status 10% · Ações 10%.

⚠️ **O `table-layout:fixed` é o que faz o `nowrap` valer** — e mora na classe `.tbl-est`, não
no seletor `table{}`, que é global e vale para o relatório CGE. Teste falha se vazar.

⚠️ **A COLUNA STATUS FICOU — decisão do Richard.** E a conta das larguras não fechava: ele
passou TR 14 · SGPe 20 · **Entidade 42** · PCs 7 · NLs 7 · Ações 10, que somam 100% para
**seis** colunas, e com o Status são sete. **Os 10% saíram da ENTIDADE** (42 → 32), pela regra
de desempate que ele mesmo escreveu: *"se faltar espaço, tira da ENTIDADE"*. As outras cinco
estão intactas, e há teste que fixa cada uma.
⚠️ **Isso não esconde nome nenhum:** com a quebra ligada a largura decide quantas **linhas** o
nome ocupa, não se ele aparece.

**17 suítes no `sigpc-gt` · 977 passaram · 0 falharam**, com a nova `teste_front_estoque.js`.
**Não foi clicado por ninguém.** Detalhe no `SESSAO.md` do `sigpc-gt`.

### 3-B. ⚠️ A tabela `estoque` — MEDIDA em 16/08, e nada depende dela

| no banco | |
|---|---|
| FOREIGN KEYs apontando para ela | **0** |
| VIEWs · TRIGGERs · FUNÇÕES | **0 · 0 · 0** |
| linhas · TRs · disco | 4.476 · 1.030 · 1.176 kB |
| `atualizado_em` | de **14/06** a **18/07/2026** — parada há um mês |
| cobertura | **incompleta**: 536 TRs existem na `prestacoes_contas` e não nela |

Na API são **SETE** pontos que tocam a tabela, não seis. E **nenhum é chamado pela tela**:
o `index.html` faz fetch em **63 rotas**, e nenhuma delas é `/estoque`, `/contadores` nem
`/planilha_analista` — medido lendo todas as chamadas do arquivo.

| ponto | server.js | quem chama |
|---|---|---|
| `GET /estoque` | 710 | ninguém |
| `GET /estoque/:id` | 738 | ninguém |
| `PATCH /estoque/:id` | 747 | ninguém — **e ver o alerta abaixo** |
| `GET /estoque/grupos-analistas` | 838 | ninguém, **e não roda** — ver abaixo |
| **`GET /planilha_analista/completa`** | **854** | **ninguém** — ⚠️ **`LEFT JOIN estoque`** |
| `DELETE /migracao/limpar-estoque` | 1053 | ninguém |
| `POST /migracao/estoque` | 1067 | ninguém |
| `GET /contadores` | 1036 | **ninguém** — o `COUNT(*)` está lá, mas a rota não é chamada |

⚠️ **CORREÇÃO DO QUE FOI DITO ANTES.** Este documento chegou a afirmar que "o único consumidor
vivo é o `COUNT(*)` do `GET /contadores`". **Duas coisas estavam erradas:**
1. **Faltava o `GET /planilha_analista/completa`** (`server.js:875`), que faz
   `LEFT JOIN estoque e ON e.tr = p.tr AND e.parcela = p.parcela`. **É a única dependência que
   quebraria de verdade** com um `DROP` — as outras leem a tabela sozinha, esta a *junta*.
2. **O `/contadores` também não tem quem o chame.** A tela conta pelo
   `GET /prestacoes_contas?limit=1` (a função `carregarContadores` do `index.html`, que apesar
   do nome **não** usa a rota `/contadores`). Achar a rota e parar ali foi o erro de método:
   **procurei quem lê a TABELA e não quem chama a ROTA.**

**Então "se algo usar, quebra?"** — o que quebraria é `GET /planilha_analista/completa`, e
`GET /contadores`, e as quatro de `/estoque`. **Nenhuma das oito é chamada pela tela.** Não é
prova de que ninguém no mundo as chame: a API é pública e sem credencial na maior parte.

⚠️ **`GET /estoque/grupos-analistas` NUNCA RODA — é a armadilha 13, viva.** Está declarada na
linha **838**, depois de `/estoque/:id` na **738**. O Express casa na ordem: o pedido cai na
rota de cima com `id = "grupos-analistas"`, e como `estoque.id` é `integer`, o Postgres recusa
e a rota devolve **HTTP 500**. E mesmo que rodasse devolveria lixo: os 45 pares
`(tecnico_nome, grupo)` têm `grupo = NULL` nos **45**.

⚠️ **`PATCH /estoque/:id` é um `UPDATE` aberto, sem credencial e sem lista de colunas.**
O **nome da coluna vem do corpo do pedido** e é concatenado no SQL:
`for (const [k,v] of Object.entries(b)) sets.push(\`${k} = $${i++}\`)`. Não há conferência de
perfil nem `usuario_id`. Some junto se a tabela sair.

⚠️ **7 chaves só existem na `estoque`, e não são dado — são lixo da carga:** `NULL`,
`2020TR000`, **`ANA CLAUDIA`** (o nome de uma analista no campo TR), `2023TR000114`,
`2023TR000845`, `2023TR001063` e `2021TR000719`. **A `2021TR000719` é uma das "6 TRs que não
casaram"** que o `CLAUDE.md` marca como lista obsoleta — **é aqui que elas moram.**

**O que se perderia:** `situacao` (4.476 linhas) e `prazo_analise` (3.802) — uma foto de 18/07
que já não descreve o banco. As três colunas de devolução têm **uma linha cada**: o rastro do
`confDev` morto, que gravava numa rota que nunca existiu.

⚠️ **NADA FOI MEXIDO NA TABELA — ordem do Richard, 16/08/2026.** Ela continua no banco, com as
4.476 linhas, e as oito rotas continuam no `server.js`. Isto aqui é **medição**, não plano.

Se um dia for para sair, a decisão é uma só: se a foto de 18/07 (`situacao`, `prazo_analise`)
tem valor histórico, renomear para `_backup_estoque_20260816` em vez de `DROP` — mesmo custo,
e reversível. E **as oito rotas teriam de sair junto**, senão viram 500 em vez de 404 — em
especial o `GET /planilha_analista/completa`, que é o único com JOIN.
⚠️ **Vale o mesmo para a `planilha_analista`** (3.122 linhas, parada em 14/06, já marcada como
DESCONTINUADA), e **o `desfazer_assuncoes.js` mexe nessas duas e em nenhuma outra**.

### 3-C. O que ficou de fora dos ajustes da tela

- **A tabela `estoque`** — medida em 16/08. Ver **3-B** acima: nada depende dela no banco, e
  a decisão de apagar (ou renomear para backup) continua sendo do Richard.
- **O filtro de status da tela** ainda tem `<option value="livre" selected>` fixo; com
  `pcs_livres` vindo do servidor, vale conferir se os outros valores do filtro continuam
  batendo com o `statusDerivado`. **Não foi tocado nos ajustes de 16/08.**
- **⚠️ A coluna STATUS do filtro e a da tabela são a mesma pergunta.** Se o Status sair da
  tabela (a alternativa registrada em 3), o filtro passa a ser o único lugar onde ele existe.
- **Não foi clicado por ninguém.** A regra unificada foi provada contra o banco (788 TRs
  Livres antes, 788 depois) e por teste; os ajustes de 16/08 têm 32 checagens novas. Mas o
  Estoque **não foi aberto no navegador**.

### 4. ✅ `CI_PENDENTE_POR_ANALISTA/` — **42 arquivos já gerados**

Um CSV por analista, mais o `_RESUMO.csv`. **1.487 PCs** baixadas com parecer e fora do C.I.
Colunas: `TR, parcial, codigo_pc, tipo, processo_pc, parecer, entidade, valor, data_baixa,
JA_FOI_AO_CI?` — a última em branco, para o analista preencher. UTF-8 com BOM.

Maiores: `Geisa.csv` (132/63) · `Perla.csv` (115/77) · `Sandra_Rocha.csv` (100/53) ·
`Grace_Oliveira.csv` (85/37) · `Valderi.csv` (77/39).

⚠️ **Não versionados** (entidade, CNPJ e valor). Estão na raiz do `sigpc-api`, no `.gitignore`.
⚠️ **Regenerar depois de qualquer marcação em lote** — a lista muda a cada encaminhamento.

## ▶ A PRÓXIMA SESSÃO COMEÇA AQUI (fechado em 14/08/2026)

Cinco frentes, na ordem em que o Richard as deixou.

### 1. ⚠️ AUDITORIA: as planilhas dos analistas × a base do sistema — **SÓ LEITURA PRIMEIRO**

**Vários analistas relatam divergência de número de PCs e de VALORES** entre a planilha deles
e o que o sistema mostra. Isso ainda não foi medido nesta sessão.

⚠️ **NÃO "consertar" o banco para bater com a planilha.** Já há um caso medido em que a
PLANILHA é que estava errada: a coluna "Número de PCs" do **Grupo 2** está inflada — 44,7% das
chaves com razão exatamente 2,0 contra o banco, e o gabarito de 1.899 da aba Monitoramento
saiu da mesma coluna (o real apurado é ~1.217). G1 e G3, lendo o mesmo banco com a mesma
regra, deram 96,4% e 93,1% de razão 1,0. Prova aritmética guardada: a `2020TR000681` declara
26 parciais somando **98 PCs**, e a TR inteira tem **53 PCs** no banco.

**Ordem de trabalho, e ela importa:**
1. **Medir sem escrever.** Por analista e por TR: contagem de PCs e soma de valores, dos dois
   lados, com a chave explícita (TR + processo SGPe, ou `codigo_pc`).
2. **Separar quem diverge de quanto diverge.** Razão 2,0 é linha duplicada na planilha; razão
   quebrada é outra coisa.
3. **Levar a lista ao Richard antes de qualquer `UPDATE`.** Escrita continua exigindo ordem
   expressa.

⚠️ **A base é a fonte única** (`prestacoes_contas`, 14.652 linhas). A planilha é o que se
audita, não o gabarito — salvo se o Richard decidir o contrário caso a caso.

### 2. Ativar o time de agentes
Os quatro estão prontos em `.claude/agents/` e o fluxo em `TIME_AGENTES.md`. **Nada foi
acionado.** Falta o Richard mandar, e decidir o `deny` do `settings.local.json` e se entra o
plugin `pr-review-toolkit`.

### 3. As 14 telas que ninguém clicou
A lista está em "O QUE O RICHARD IA TESTAR NA TELA", mais abaixo. As duas últimas são as mais
novas: **os dois papéis** e o **agir pela conta**.

### 4. As 3 PCs FINAIS com `parcial_num = '1'`
`2021TR001689` (Grazielly) · `2021TR002133` (Richard) · `2023TR000048` (Elisandra).
A FINAL ficou agrupada junto da parcial 1, e como toda rota grava por
`WHERE tr = ... AND parcial_num = ...`, **um parecer na parcial 1 dessas três baixaria a FINAL
junto**. É correção de DADO, não de código — com o comando na tela antes.

### 5. A Caroline sem cadastro
Meta 27 vigente, **sem linha em `usuarios`**. É a única nessa situação, e agora tem
consequência prática: se alguém a indicar no motivo 1 do pedido de devolução, **a aprovação
trava** com o motivo escrito na tela (é o que se decidiu, em vez de mandar a TR ao estoque em
silêncio).

---

## ⚠️ O SISTEMA ESTÁ ABERTO

Modo preparação **desligado**. Modo manutenção **desligado**. A equipe trabalha.

**Os dois interruptores ficam em Configurações**, em abas separadas. Se ligar a manutenção,
lembre: **ninguém além do superadmin entra** — nem coordenador, nem o Controle Interno.

---

## O QUE FICOU PRONTO EM 12–14/08

### 🔒 Modo manutenção — a janela segura de escrita
Antes dele, gravar dependia de pedir no WhatsApp e esperar 30 min de inércia do
`ultimo_acesso`. **Funcionou na primeira: de 3 analistas online para 0.**

⚠️ **São TRÊS mecanismos, e os três são necessários:**
1. `sessao_fim = clock_timestamp()` em todos menos o superadmin, na MESMA transação;
2. **`PATCH /usuarios/:id` recusa quem não é superadmin** — SEM ISTO O ITEM 1 NÃO SEGURA:
   o heartbeat de `onlineCarregar()` bate de 5 em 5 min e ressuscitaria a pessoa na lista;
3. o polling de `config_sistema`, agora de 20 s, derruba a tela de quem está dentro.

⚠️ **O superadmin NÃO bloqueia a janela** — nem no `janela_livre.js`, nem no
`renumerar_parcial_num.js`. Ele nunca é derrubado (de propósito), mas é o mesmo que ligou o
modo e roda o script. **Custou uma recusa real:** um dos dois critérios tinha sido corrigido
e o outro não. **Se houver dois critérios de "pode gravar", eles têm de ser o mesmo.**

```bash
node janela_livre.js            # uma foto
node janela_livre.js --vigiar   # até dar LIVRE
```

### ✅ As parciais foram renumeradas — 1.189 PCs em 70 TRs
`parcial_num` voltou a ser o número do SIGEF em **1.545 das 1.554 TRs**.

⚠️ **NÃO renumerar por `parcela_seq`** — era o caminho escrito aqui e foi **medido e
reprovado**: reescrevia 592 parcelas cujo rótulo veio da planilha do analista, que é o número
do SIGEF. Na própria 704, 44 dos 48 rótulos conferidos mudariam. `parcela_seq` **não é a
ordem do SIGEF**.

O que se fez: **preservar o rótulo da planilha e preencher só a lacuna.**
⚠️ **O gabarito é o `_backup_parcial_num_20260805`. Não apagar.**

9 TRs ficaram de fora, e nenhuma é numeração: 7 têm rótulo acima do total (o SIGEF tem
parcela que a base não tem) e 2 têm o mesmo SGPe em duas grafias.

### ↩ Devolver a TR ao estoque — só superadmin
Existia desde 30/07 e tinha sido **perdida de vista**: em 05/08 a Minha Planilha foi
reconstruída e levou o botão junto. Voltou no cartão da TR, agora com rota transacional,
guarda no servidor e rastro em `parcela_historico`.

⚠️ **PC no ciclo do C.I. BLOQUEIA a devolução** (opção B). E atenção: **as PCs no C.I. são
todas `baixada = true`** (são 585 em 114 TRs, medido em 16/08 — o "13" era falso) — encaminhar ao C.I. já conta como baixa. A primeira versão procurava
C.I. só entre as não baixadas e **a trava nunca disparava**.

### ✎ Corrigir o processo SGPe — em todas as telas
O lápis entrou no `procHtml`, que é usado em 11 pontos: aparece nas onze de uma vez.
`processo_mae` também é editável. **Automático primeiro, manual depois** — o campo de colar
o link só aparece quando mapa + cache + SGPe ao vivo não resolvem.

⚠️ **`origem = 'MANUAL'` é imune ao job**, em DOIS lugares: `montarFila` não o põe na fila e
as três gravações de `lib/sgpe-lote` recusam sobrescrevê-lo.

**Resultado:** `processo_pc` 14.419 de 14.652 com link (98,4%) · `processo_mae` 14.501 (98,9%).

### ✓ Assumir a TR numa transação — o último PATCH-por-PC
Era o mesmo defeito da devolução, e o único lugar que restava. `POST /tr/assumir`.

⚠️ **A trava de limite era conferida a cada PATCH.** Numa TR de 83 PCs, 83 consultas — e
como a PC 1 já contava como assumida, o limite podia estourar no meio e deixar a TR pela
metade. Agora é conferida UMA vez, dentro da transação.

O **nome curto** (`analista_nome` = "Richard", não "Richard Motta Coelho") saiu do
`index.html` e virou `lib/assumir.js`.

### 🔍 Busca global — localizar qualquer TR ou PC numa tela só. SÓ SUPERADMIN.
Menu → bloco Superadmin. Um campo, seis identificadores (TR, PC, NL, processo mãe,
processo da PC, entidade). **Um card por TR, nunca uma linha solta.**

⚠️ **A guarda é da ROTA, não do menu.** `GET /busca_global` devolve o acervo de qualquer
analista — o oposto do recorte por `analista_id` das outras telas. O perfil vem do banco;
coordenador, analista e C.I. levam 403 (conferido em produção).

⚠️ **`tr = ANY(...)`, e não o termo no `WHERE` das agregações** — o defeito de 09/08. Com o
filtro junto, as contagens veriam só as linhas que casaram: a 2019TR000168 tem 20 PCs e
aparecia com 2.

⚠️ **O prazo antigo quase voltou.** O `pg` devolve `date` como **objeto `Date`**, e
`String(d).slice(0,10)` num Date dá `"Thu Mar 31"` — que, comparado como TEXTO contra
`"2026-08-01"`, PASSA no corte. A busca chegou a mostrar **9.221 dias de atraso**. Corrigido
com `paraIso()`. Ver a armadilha 18: é a mesma família de erro do fuso.

**O encaminhamento** sai por `window.print()` (PDF) e `Blob application/msword` (.doc), com o
cabeçalho institucional do CGE. **Sem biblioteca nova** — o `package.json` continua com seis
dependências. Um botão abre a janela com o documento pronto e as duas ações no topo, que
somem no papel.

**A coluna "Código da PC" é dimensionada pela FINAL**: `2018TR000093-PFINAL` tem 19
caracteres contra 12 de `2018PC000015`. `nowrap` na tela e no papel.

⚠️ **"No estoque desde" só nas devolvidas.** Das 795 TRs sem dono, **793 nunca tiveram um** —
para essas não existe "desde quando", e usar a data da carga (18/07, igual para todas) daria
um número que parece resposta e não é.

### 🏛 O botão do C.I. nunca tinha acendido — e agora são TRÊS passos
**O defeito mais caro do dia, e nenhum dos 15 testes pegava.** Sem parecer o botão
"Encaminhar ao CI" ficava cinza; **com** parecer a parcial virava `baixada` e caía no ramo
verde do cartão, **que não desenhava botão nenhum**. Medido: **4.259** parciais no cinza,
**2.181** sem botão, e **zero** encaminhamentos feitos por analista em produção — as 13 PCs
que estão no C.I. entraram pela `migracao_ci` de 05/08, não pela tela.

⚠️ **A trava do servidor NÃO mudou.** `POST /parcela/ci` continua exigindo parecer prévio.
O que se corrigiu foi a tela esconder o botão depois que o parecer existe.

⚠️ **Encaminhar ao C.I. é OBRIGATÓRIO** (decisão do Richard). A primeira versão do texto dizia
"opcional — a parcial já está baixada" e convidava a parar na baixa.

```
Passo 1 de 3  âmbar  registre o parecer para poder baixar   · botão cinza COM o motivo ao lado
Passo 2 de 3  verde  baixada em <data> · parecer: <tipo>    · botão ATIVO
                     FALTA ENCAMINHAR AO CONTROLE INTERNO
Passo 3 de 3  azul   No Controle Interno desde <data> · aguardando retorno há N dias
                     o retorno do CI não cancela a baixa
```

⚠️ **Havia uma SEGUNDA tela com a regra invertida** — o detalhe da TR (o "Ver PCs"):
`!p.baixada && !p.enviado_ci` escondia o botão justamente quando a PC era baixada. E era pior:
gravava por **PATCH de UMA PC** (o encaminhamento é por PARCELA, e há parcela com 7), montava
`baixada`/`data_baixa` **no navegador** com o relógio de quem clicou, e por ser PATCH genérico
**passava por fora da trava do parecer**. As duas telas agora decidem pelo mesmo `pPasso` e
gravam pela mesma rota transacional.

### 🏛 Etiqueta "N sem C.I." na lista — a dívida que ninguém enxergava
Encaminhar é obrigatório e **nada exige**: sem trava no servidor, sem sino, sem relatório. O
cabeçalho da TR agora mostra `🏛 3 sem C.I.` em âmbar — **inclusive na TR "✓ concluída", e
principalmente nela**, que é onde a dívida se perde de vista.

**2.181 parciais em 550 TRs vão nascer com a etiqueta.** A contagem é conferida contra o banco
em `prova_banco_ci.js` — contagem que diverge do banco é pior que contagem nenhuma.

### ↩ O analista PEDE a devolução da TR — e quem devolve é a coordenação
Tabela nova **`solicitacao_devolucao`** (criada em 13/08, com autorização). Botão no cartão da
TR, ao lado do "Ver PCs"; modal com **seis motivos** em lista fechada e justificativa
obrigatória em todos; fila em **Aprovações**, aba nova ao lado de "Vagas extras".

⚠️ **TABELA SEPARADA, e o motivo é medido.** Sete consultas de `lib/limite-tr.js` leem a
`solicitacao_vaga` **sem filtro nenhum** — um pedido de devolução gravado lá viraria +1 no
limite de quem pediu para devolver, reservaria no Estoque a TR que ele quer largar, e seria
consumido como autorização para furar o limite. Nada disso dá erro. **Não fundir as duas.**

⚠️ **A TR continua contando no limite enquanto o pedido está pendente** — o pedido não toca em
`analista_id`. Só a aprovação devolve. Senão qualquer um abriria vaga só pedindo devolução.

⚠️ **DOIS CAMINHOS NA APROVAÇÃO.** Motivo 1 ("já estava em análise por outro antes de
01/08/2026") vai **direto para o analista indicado**, pela `lib/assumir.js` — mandar ao
estoque uma TR que tem destino a entrega a quem chegar primeiro. Os outros cinco vão ao
estoque, pela `lib/devolucao.js`. **O limite NÃO é conferido** na transferência: 29 dos 44
analistas já estão em 6 ou acima, e a trava vale no *ato de assumir*. A carga do indicado
aparece no cartão e quem decide é o coordenador.

⚠️ **Indicado sem cadastro ativo BLOQUEIA** (409) em vez de cair no estoque em silêncio. O
primeiro caso real é a **Caroline** — meta vigente, nenhum cadastro.

⚠️ **O solicitante não decide o próprio pedido.** Exceção: o superadmin, e aí o histórico
ganha `AUTODECIDIDO — quem pediu e quem decidiu sao a mesma pessoa`.

**Provado contra o Postgres em dois ciclos completos, e os dois revertidos por inteiro:**
o índice único (segundo pedido → 409), a segunda decisão (→ 409), a `dt_inicio_analise`
preservada, a baixada que fica no nome de quem baixou, o sino nas duas decisões, e a marca do
autodecidido. **Nada sobrou no banco.**

### 🛠 AGIR pela conta do analista, e os DOIS PAPÉIS do superadmin (14/08)

**O "Ver como analista" deixou de ser leitura.** Sem agir não se dava suporte nenhum.

**Autoria dupla:** `parcela_historico.executado_por` (ALTER de 14/08). `analista_id` é o
**dono**, `executado_por` é **quem clicou**, e fica **NULO quando são a mesma pessoa** — nulo
quer dizer "foi ele mesmo", e o que importa achar é a linha em que os dois diferem.

⚠️ **O `fetch` do `index.html` deixou de BLOQUEAR e passou a CARIMBAR**, trocando DOIS campos:
`analista_id = alvo().id` e `executado_por = U.id`. Trocar só um gravaria a baixa na
produtividade errada. É num ponto só porque são **56 chamadas de escrita** no arquivo.

**10 ações liberadas · 4 travas ficam:** estornar · devolver TR · solicitar devolução ·
decidir no C.I. Não são "leitura" — são decisões **sobre** o trabalho dele. Há teste que falha
se aparecer uma quinta.

**Os dois papéis:** `usuarios.papel_ativo` + tabela `papel_historico`.
`analista` (padrão ao entrar, **14 itens somem do menu**) · `tecnico` (tudo, e o único que
age por outro). O reset ao entrar é do SERVIDOR.

⚠️ **UMA REGRA SÓ, dos dois lados: `perfilEfetivo`.** No papel analista o superadmin **é**
analista em toda parte — 10 pontos no servidor, e o menu recebe o usuário já com o perfil
efetivo. Resolve sozinho o ponto que passaria batido: as **seis rotas de "coordenador OU
superadmin"**, onde tirar só o `superadmin` da lista não bastaria, porque ele não é
coordenador de ninguém.

⚠️ **Quatro rotas liam o `perfil` do CORPO** — excluir usuário, excluir no repositório e os
dois estornos. Passaram a ler do banco.

**Provado contra o Postgres, os dois revertidos:** autoria dupla 11/11 (dono 18 + executor 4
gravados; analista mandando `executado_por` → 403) e papel 14/14 (no papel analista a busca
global e a prévia da devolução → 403; depois da troca, respondem).

### 👁 "Ver como analista" — o botão morto pintado de vivo
O `vcOff()` mandava a opacidade num **segundo atributo `style=`**, e o HTML fica com o
primeiro: os sete botões do modo apareciam com a cor inteira e **não respondiam ao clique**.
Quem pinta agora é o CSS (`.btn-acao:disabled`). **Eles nunca gravaram** — são três travas:
o `disabled`, a conferência dentro das funções, e o `window.fetch` envolvido, que bloqueia
todo não-GET para a API (menos o logout).

A faixa dizia *"no nome dela"* e supunha o gênero de quem estava sendo visto. Agora é
**"no nome deste analista"**.

---

## ⚠️ OS 11 PROCESSOS SGPe QUE FICARAM PENDENTES

**Resolvem pelo lápis, quando alguém tiver o número certo do SGPe.**

**O SGPe responde que NÃO TEM o processo** (6 textos):
```
ADR05 00011020/2017   21 PCs      ADR07 1064/2016      21 PCs
SDR05 001028/2017     21 PCs      SDR13 458/2017       21 PCs
fcee 6291/2024         7 PCs      fcee 7198/2024        1 PC
```

**Nenhuma leitura plausível existe** (4 textos):
```
AR355478172           21 PCs   333 candidatos testados, nenhum confirma
ADR19 0011181.2017    19 PCs   só ADR19 1181/2017 existe — e é de OUTRA TR
ADR 1181/2017         19 PCs   "ADR" sem o número da regional
ER221202154            4 PCs   só na coluna mãe; "ER" fora do mapa de 183
```

**AMBÍGUOS — vários anos confirmam** (2 textos):
```
SCC7537    2 PCs   existe em 2017, 2019, 2020, 2021, 2022, 2023 e 2024
SCC 6579   1 PC    existe em 2020, 2021, 2022, 2023, 2024 e 2025
```

⚠️ **Estes dois quase entraram por engano.** A primeira versão testou UM ano — o da TR —,
confirmou, e ia corrigir como se fosse certeza. **Um candidato só esconde a ambiguidade em
vez de revelá-la.** Link para o processo errado não dá erro na tela: ninguém percebe.

---

## AS LIÇÕES QUE CUSTARAM CARO EM 13/08

**1. Confirmar no SGPe e não gravar no cache deixa o texto certo e a tela SEM LINK.**
Foi o estado em que as correções ficaram até se perceber. O cache é o que faz o link existir.

**2. A conferência de fusão dava alarme falso** na coluna mãe e nos textos já corretos: ela
pergunta se o `processo_pc` da TR já tem aquele valor — e tem, porque é o da própria PC.
Fusão só existe para `processo_pc`, e nunca quando `de` é igual a `para`.

**3. Validação que compara com backup antigo acusa o que rodadas anteriores fizeram de
propósito.** Compare com uma **foto do início da rodada**.

**4. `AT TIME ZONE` sozinho está errado para coluna `timestamp` que guarda UTC.** Mostrou
03:31 às 21:31. O certo são dois passos:
`(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`.

**5. Um `kill` pode não pegar.** Uma rodada que mandei parar seguiu até o fim e só notificou
depois. Não causou dano porque era dry-run, mas foi sorte de sequência. **Confirme que o
processo morreu antes de seguir.**

---

## COMO TESTAR

```bash
npm run teste     # 16 suítes, sem rede e sem banco
node --check server.js lib/*.js
```

⚠️ **Antes de publicar, rode contra o banco.** Foi o que pegou todos os defeitos de 10–13/08,
inclusive a trava do C.I. que nunca disparava — invisível para o dublê.

⚠️ **Nunca teste função que abre a própria transação de dentro de outra** (regra 11).

## O QUE ESTÁ NO AR

`sigpc-api` e `sigpc-gt` — `main` e `feature/baixa-por-parcial` iguais nos dois.
**Produção roda da `feature` na API; o GitHub Pages publica da `main`.** Publique nas duas.

## BACKUPS DE 12–13/08 — não apagar

```
_backup_parcial_num_20260805     ← o GABARITO dos números do SIGEF
_backup_parcial_num_20260813     ← antes da renumeração
_backup_parcela_historico_20260813
_backup_processo_pc_20260813     ← antes da correção dos processos
_backup_processo_20260813b       ← antes da rodada final
```

## ⚠️ O QUE O RICHARD IA TESTAR NA TELA (13/08, fim da manhã)

Ele ficou de abrir os três primeiros e avisar o que encontrasse. **Se este chat é novo,
pergunte o resultado antes de mexer nessas telas.**

1. **Assumir uma TR** — a mais usada, e reescrita em 13/08. A TR **inteira** tem de aparecer
   na Minha Planilha, não parte dela. No erro o modal fica aberto com o motivo.
2. **Devolver a TR ao estoque** — ✅ **ELE TESTOU, E FUNCIONOU.** Há duas devoluções reais no
   histórico: `2020TR001601` e `2020TR001599`, ambas com motivo "TESTE DO SISTEMA", 2 PCs
   cada. As duas estão livres no estoque — se ele quiser desfazer, é só reassumir.
3. **O lápis do processo SGPe** — em 11 telas; âmbar onde não há link.
4. **A busca global** — nunca aberta. É a tela mais nova.
5. **Modo manutenção** — ficou para o **fim do expediente**: ligar derruba a equipe na hora.

Faltam também, com menos risco: o cabeçalho do cartão ("assumida em" + ✨ NOVA) e a seta do
indicador de online (fechar pelo botão, clicando fora e com Esc).

**E o que entrou depois, à tarde — nada disso foi clicado por uma pessoa:**

6. **Os três passos da parcial.** O caso direto é o do **Rafael**: `2020TR001230` e
   `2021TR000777`. A faixa verde tem de **cobrar** "falta encaminhar ao Controle Interno", e o
   botão azul ao lado tem de estar **ativo**. Se ele encaminhar, a parcela pula para o passo 3
   — seria **o primeiro encaminhamento feito pela tela na história do sistema**.
7. **A etiqueta `🏛 N sem C.I.`** no cabeçalho da TR, na lista. 550 TRs a têm.
8. **O detalhe da TR ("Ver PCs")** — o "Enviar ao CI" agora aparece nas PCs **baixadas**, e o
   `title` avisa que vai a parcela inteira.
9. **"Ver como analista"** — os botões nascem apagados **de verdade** agora.
10. **O modal do limite atingido** — faixa `#C62828`, o "Assumir" sai da tela, o pedido vira
    botão de largura total. ⚠️ **O print nunca chegou** — se ele mandar, ajustar só `limiteAviso`.
11. **⚠️ Solicitar devolução, ponta a ponta.** O botão no cartão, o modal dos seis motivos, e
    a fila em Aprovações. **O caminho do MOTIVO 1 — a transferência direta — só foi provado
    por unidade**: os dois ciclos reais usaram o motivo 4, que vai ao estoque. Para exercitar
    o 1 é preciso indicar alguém com cadastro ativo.
12. **A etiqueta `🏛 N sem C.I.`** — 550 TRs a têm.
13. **⚠️ Os dois papéis.** Entre normalmente: você nasce **analista**, e as telas de
    coordenação e superadmin **não estão lá**. A caixa fica no pé do menu → "🛠 Virar técnico
    do sistema" → o menu cresce e a faixa azul aparece no topo.
14. **⚠️ Agir pela conta de um analista** (só no papel técnico). Confira no console do
    navegador a linha `[agir como] POST /parcela/... · dono X · executor 4` a cada escrita —
    se ela não aparecer, o carimbo não pegou. E confira no histórico da parcela que o
    trabalho ficou no nome dele.

---

## ⚠️ O QUE AINDA NÃO CHEGOU

O **print do mockup** e o **modelo do documento em PDF** que o Richard ia colar na pasta.
Procurados nos dois repositórios em 13/08: não estão lá. O layout do encaminhamento seguiu a
especificação escrita dele e o cabeçalho do relatório CGE. **Quando o modelo chegar, ajustar
SÓ o documento** () — a busca e o card não mudam.

---

## O QUE FALTA

- [ ] **Os 11 processos SGPe** acima — pelo lápis, com o número do SGPe em mãos.
- [ ] **`ZZ TESTE TRAVA`** continua entrando no sistema. Se não é conta de teste, olhar.
- [ ] **A fusão de parcelas** está implementada e testada por unidade, mas **nunca foi
      exercitada contra o banco** — não há hoje correção que a dispare.
- [ ] **Scheila (49)** e **Eduardo (52)** — sem CPF, não entram. Eduardo também inativo.
- [ ] **A sua senha** ainda é a antiga, agora em bcrypt. Esteve pública por meses.
- [ ] **A camada de autorização** continua sendo o buraco de fundo: quem montar um pedido
      HTTP e se declarar coordenador passa. Preparação e manutenção são cortina, não tranca.
- [ ] **11,3 MB por tela** — seis telas ainda baixam o acervo inteiro para filtrar no cliente.

### O que ficou parado esperando o Richard

- [x] ~~Solicitar devolução de TR pelo analista~~ — **PRONTO em 13/08.** Ver a seção própria
      acima. Falta só **clicar na tela**.
- [ ] **3 PCs FINAIS com `parcial_num = '1'`** — `2021TR001689` (Grazielly), `2021TR002133`
      (Richard) e `2023TR000048` (Elisandra). A FINAL ficou agrupada junto da parcial 1, e
      como toda rota grava por `WHERE tr = ... AND parcial_num = ...`, **um parecer na parcial
      1 dessas três baixaria a FINAL junto**. É correção de DADO, não de código.

### O time de agentes está pronto na gaveta
`.claude/agents/` tem os quatro — `orquestrador`, `coder`, `qa-banco`, `revisor` — e o fluxo
está em `TIME_AGENTES.md`. **Nada foi ativado.** As três regras do Richard (13/08) estão no
`CLAUDE.md` e repetidas dentro do prompt de cada um: nenhum agente escreve no banco, nenhum
decide regra de negócio, nenhum publica.
