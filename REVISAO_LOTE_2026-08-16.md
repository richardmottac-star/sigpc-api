# Revisão do lote da renumeração — 16/08/2026

**Revisor: voltou.** · **qa-banco: voltou.** (a seção dele está no fim do arquivo)
Nada foi editado depois da revisão, nada gravado no banco. O `renumerar_sigef.js` está como
rodou no dry-run, para o qa-banco ver o mesmo código.

> O revisor reproduziu o lote **fora do script**, só com `SELECT`, e chegou ao mesmo total.
> A partir daí mediu o que os 6 checks **não** medem. Os três bloqueios saíram daí.

---

## 🔴 BLOQUEIO 1 — o realinhamento do histórico erra em 6 linhas, e a conferência aprova

`renumerar_sigef.js`, a captura do `parcela_historico`.

```sql
 WHERE p.codigo_pc = ANY($1)      -- ← filtra ANTES do agregado
 GROUP BY h.id, h.tr, h.parcial_num
HAVING COUNT(DISTINCT m.parcial_sigef) = 1
```

O `WHERE` restringe o grupo **só às PCs que estão no lote**. O `COUNT(DISTINCT)` conta os
destinos **dessas**, não os da parcela inteira. As PCs que ficam — as que já estão certas, as
45 do `-1`, as excluídas — são invisíveis para ele. **Uma parcela em que 1 PC sai e 2 ficam
conta "1 destino" e passa.**

| | |
|---|---|
| parcelas de origem que **se partem** em 2+ números | **69** |
| linhas de histórico dentro de uma parcela que se parte | **6** |
| **movidas mesmo assim**, pelo falso "1 destino" | **2** |
| **não movidas**, ficando na parcela que perdeu as PCs | **4** |

```
id=757  2020TR000686 p5  ci           -> destinos 4/5   ficam 2  saem 1   MOVIDA para a 4
id=330  2022TR001279 p2  parecer      -> destinos 2/3   ficam 2  saem 1   MOVIDA para a 3
id=238  2020TR000831 p5  parecer      -> destinos 8/9   ficam 0  saem 6   NAO movida
id=316  2022TR000851 p6  parecer      -> destinos 7/8   ficam 0  saem 3   NAO movida
id=1    2020TR000657 p1  migracao_ci  -> 1/2/3/4        ficam 1  saem 6   NAO movida
id=37   2022TR000848 p2  situacao     -> destinos 2/3/4 ficam 1  saem 2   NAO movida
```

**Como aparece na tela.** A `2020TR000686` parcial 5 são 3 PCs do `SCC19120/2020`, todas
`baixada = true` e todas `ci_situacao = 'na_fila'`. A linha `id=757` é o *"encaminhado ao
Controle Interno"*. O script a move para a parcial 4 — `SCC 00003160/2023`, 3 PCs **abertas,
sem parecer**. Resultado: a parcela que **está** no C.I. perde o registro de ter sido
encaminhada, e a que **nunca foi** passa a exibi-lo.

O `id=238` é o pior: a parcial 5 da `2020TR000831` **esvazia**, outras PCs entram no número 5,
e o parecer *"Diligência → Regular com Ressalvas"* do analista 13 vira histórico de PCs
alheias. **Não vira órfão** justamente porque alguém ocupa o lugar — por isso o check de
órfão dá `1 -> 1` e o dry-run imprime **6/6 OK**.

### ⚠️ E aqui há uma decisão que é sua

Quando uma parcela legitimamente vira duas, **para qual das duas vai a linha de histórico?**
As 69 parcelas partidas vêm do mapa da CGE — não são defeito do recorte. O defeito é o script
**escolher em silêncio** (pela minoria, em 2 dos 6 casos) e a conferência aprovar.

Enquanto isso não for decidido, o lote não deve gravar: seis linhas de trilha mudam de dona.

---

## 🔴 BLOQUEIO 2 — o lote faz 55 TRs deixarem de fechar 1..N, e nada disso aparece

```
hoje (nada aplicado) ...........................  8 TRs
lote como o script monta .......................  57 TRs   ← +49
lote sem o recorte falso das mistas ............  56
bruto inteiro, sem recorte nenhum ..............  57
mapa inteiro, sem excluir as 15 TRs ............  58
```

**Os recortes quase não influem: a quebra vem do próprio mapa da CGE**, que numera parcelas
que a base não tem — é a armadilha 16 ("7 TRs com rótulo acima do total"), multiplicada por 7.

Pode estar certo (o SIGEF tem parcela que a base não tem). **Mas o script não apresenta o
número**: ele grava e você descobre pela Minha Planilha, que passa a mostrar parciais 1, 2, 4,
7 — com buracos — em 49 TRs a mais.

⚠️ O antecessor `renumerar_parcial_num.js` **tem** essa medição (`contarNaoFecham`, virou delta
hoje). O sucessor perdeu. Bloqueia porque nenhum agente pode decidir isso por você, e hoje o
dry-run nem dá o número.

---

## 🔴 BLOQUEIO 3 — ⚠️ AS 12 PARCELAS MISTAS NÃO EXISTEM. O recorte é artefato.

**Este contradiz a sua instrução, e por isso vem inteiro.**

A projeção recebe `$1 = [...setBruto]` — o candidato **antes** dos recortes. Mas o `$1` do
UPDATE é `codigos`, **depois** deles. A projeção pergunta *"e se as 45 PCs do processo `-1` se
movessem?"* — e elas não se movem: o recorte do `-1` já as tirou.

| | |
|---|---|
| mistas com `$1` = bruto (o que o dry-run imprimiu) | **19 PCs · 12 parcelas** |
| mistas com `$1` = bruto **sem os `-1`** (o lote real) | **0** |

**Nenhuma parcela mista é criada pelo lote.** Das 19, 17 já sairiam pelo `-1`; **2 PCs estão
sendo excluídas da correção sem motivo nenhum**.

⚠️ **A lista de 12 parcelas que o dry-run imprimiu — a que virou o "bloqueio nº 2" do
`SESSAO.md`, com as *"2 PCs nunca analisadas que somem dentro da faixa azul do C.I."* —
descreve um estado que o lote não produz.**

O dano de dado é pequeno e fail-safe (2 PCs a menos corrigidas). O que bloqueia é que **o
relatório que você lê para decidir está errado**.

✅ O outro lado da projeção está certo: PCs fora do mapa entram corretamente (`LEFT JOIN` +
`ELSE p.parcial_num`), e hoje há **0** PCs fora do mapa dividindo parcela com PCs do lote.

---

## 🟡 PODE ESPERAR

| # | onde | o quê |
|---|---|---|
| 4 | check `p2` | "parcelas mistas criadas" é **absoluto**, não delta — incoerente com o vizinho. Uma analista baixando uma PC no meio manda `ROLLBACK` por algo que a rodada não fez. Falha fechada, mas queima a janela. |
| 5 | check do órfão | compara **contagem**, não conjunto: resolver um e criar outro empata. Medido hoje: 0 novos, 0 resolvidos. E o `orfaosAntes` é medido **antes** do `BEGIN`, noutro snapshot. |
| 6 | as 13 colunas | **não há falso OK** por NULL, tipo ou colação. Única fresta: o `JOIN` é interno, então uma linha **apagada** sumiria sem acusar. Nada nesta rodada apaga. |
| 7 | dry-run que escreve | sem `lock_timeout` e **sem trava de janela** — o `--gravar` recusa com gente online, o dry-run só avisa. Segura lock em 2.102 linhas durante os 13 `COUNT`. Se o processo for morto entre o UPDATE e o `ROLLBACK` (**armadilha 23**), a fila trava até o TCP cair. `SET LOCAL lock_timeout = '3s'` resolveria. |
| 8 | 2ª rodada de `--gravar` | aborta com o erro cru do Postgres, depois de já ter carregado o mapa. É a proteção certa, só a mensagem é feia. ✅ **`_backup_parcial_num_20260816` (11 colunas) está seguro** — nenhum `DROP` no arquivo, e a `...b` não existe hoje. |
| 10 | `convive` | correto nos três pontos que levantei (não escreve · `sort` não quebra com não numérico · `IS DISTINCT FROM` com NULL ok). Menor: é lido **antes** do UPDATE, então não cita as parciais que a própria correção trouxe. Subconta, nunca superconta. |
| 11 | histórico da rota | correção que atravessa várias parciais grava **uma** linha, na parcial da PC clicada. Comportamento antigo — mas com o N:N ficou mais provável. |
| 12 | `FOR UPDATE` sem `ORDER BY` | janela de deadlock com `carregarParcela` (ordens diferentes na mesma TR). Dá erro 500 visível, não é o defeito silencioso. `ORDER BY codigo_pc` nas duas fecharia. |

### 🟡 E dois defeitos nos testes que eu escrevi hoje

**13.** `conf(/parseInt\(String\(x\)\.replace/...)` prova que **o código está escrito de um
jeito**, não que a ordem sai certa. **Passa se alguém trocar `nx - ny` por `ny - nx`.** O certo
é extrair o comparador para `lib/processo-edit.js` e testar a propriedade.

**14.** Em `rotaCodigo`, o segundo ramo do filtro é `\\` (barra invertida) — era para ser `\*`,
continuação de bloco `/* */`. Hoje é no-op; se alguém puser um comentário de bloco na rota, o
teste de posição volta a medir a prosa — exatamente o que o comentário acima dele proíbe.

---

## ✅ O que foi conferido e está certo

- **Regra 12** — `codigo_pc = ANY($1)` com lista capturada antes; histórico por lista de `id`;
  `FORA_DO_LOTE` e `FORA_PCS` escritas à mão. Nenhuma condição derivada em `WHERE` de escrita.
- **Armadilha 21** — o backup das 13 colunas é tirado **dentro** da transação, imediatamente
  antes do UPDATE: é a foto do início da rodada, não um backup antigo.
- **Armadilha 17** — os 4 sinais batem **um a um** com o `janela_livre.js`: mesmos 30 min,
  mesmos contadores, mesma exclusão do superadmin, mesma falha aberta para `ci_mensagem`.
  **O defeito 4 está resolvido.**
- **Armadilha 18** — todos os `AT TIME ZONE` novos são de dois passos.
- **Armadilha 25** — nenhum `Date` comparado como texto.
- **O CSV** — cabeçalho bate com as chaves do `lerCsv`; 8.998 linhas; **0** com `parcial_sigef`
  não numérico. ⚠️ Se o nome da coluna não batesse, o script gravaria **NULL em 8.998 PCs** sem
  check nenhum acusar — vale uma asserção, hoje não morde.
- **PCs `tipo = 'final'` no lote: 0** — as 3 FINAIS com `parcial_num = '1'` não entram.
- **Nenhuma decisão registrada foi desfeita** — lê o mapa da CGE, não renumera por
  `parcela_seq`, não usa `dt_limite_pc` como prazo, não ressuscita `planilha_analista`.
- **`carregarParcela`** — só ganhou comentário, chave inalterada. ✓
- **`index.html`** — o `juntar` saiu do estado e do corpo, o ramo do 409 saiu inteiro, o
  `convive` entra nos dois caminhos do toast. Não sobrou referência a `_procEd.juntar`. ✓

---
---

# qa-banco — a prova contra o Postgres (15h07–15h50)

**Janela OCUPADO. Nada gravado.** Confirmado ao fim: `_backup_parcial_num_20260816` casa 100%
com o banco (0 divergentes), `..._20260816b` e `_backup_parcela_historico_20260816b` **não
existem**, e a última linha de `parcela_historico` é anterior aos testes.

Ele subiu o Express de verdade contra o Postgres de produção e trocou todo `COMMIT` por
`ROLLBACK`, lendo o estado **na mesma conexão** antes do rollback — a única leitura que
enxerga o efeito da escrita.

## ✅ A DUPLA VERIFICAÇÃO BATEU

| | script | qa-banco (SQL próprio) | revisor (cego) |
|---|---|---|---|
| PCs · parciais | 2.102 · 1.209 | **2.102 · 1.209** ✓ | ✓ |
| bruto · `-1` · nominal · histórico | 2.151 · 45 · 2 · 81 | **idem** ✓ | ✓ |
| **parcelas mistas** | 19 / 12 parcelas | **0** | **0** |

⚠️ **O bloqueio 3 do revisor está CONFIRMADO por medição independente e cega.** As duas
leituras chegaram a `0` por SQL diferente.

## 🔴 A rota: 23 OK, e um defeito NOVO que o revisor não viu

| resultado |
|---|
| `controle_interno` → 403 · id inexistente → 403 · sem `usuario_id` → 400 · PC inexistente → 404 |
| `antes === novo` → 200 `mudou:false`, **nenhum UPDATE e nenhum INSERT executados** |
| **grava em vez de 409**, com `convive: {parcial_atual:"2", outras_parciais:["3"], pcs:1}` |
| **`parcial_num` INTACTO** nas 4 PCs, lido dentro da transação |
| `baixada, data_baixa, enviado_ci, parecer_tipo, parecer_ci, valor, ci_situacao, ci_rodada` — **nenhuma tocada** |
| **`juntar:true` ignorado** — nenhum `UPDATE ... parcial_num` chegou ao banco |
| `processo_mae` → `convive: null`, e não altera `processo_pc` |

### ⚠️ 1.2 — A ROTA GRAVA O EXECUTOR NO CAMPO DO DONO

O `INSERT` em `parcela_historico` passa `quem.id` como `analista_id` e **não preenche
`executado_por`** — coluna que existe. Pelo `CLAUDE.md`: `analista_id` = **dono**,
`executado_por` NULL = *"foi o dono mesmo"*.

**Já há 25 de 75 linhas `processo_pc` e 3 de 25 `processo_mae` com `analista_id` diferente do
dono da TR.** Um coordenador corrige o processo de uma PC da Aline e a trilha diz que a dona
do trabalho era o coordenador — **sem marca de que alguém agiu por outro**. É exatamente o
defeito que 14/08 corrigiu nas outras rotas, e esta ficou de fora.

### 1.3 — `quemEdita` lê `papel_ativo` e o ignora
Usa `rows[0].perfil`, não `papel.perfilEfetivo`. Sem efeito hoje (`analista` já pode), mas é a
única rota de escrita fora dos 10 pontos do `perfilEfetivo`.

### 1.1 — Subir o servidor ESCREVE no banco
O boot roda 4 `ALTER TABLE`, 4 `CREATE TABLE`, 1 `CREATE INDEX`, 1 `INSERT` e um `UPDATE` de
`ci_situacao`. Hoje **tudo é no-op** (0 linhas), mas o DDL pega `ACCESS EXCLUSIVE` em
`usuarios` e `prestacoes_contas` — **com a equipe na tela**. Não é defeito; é o que quem for
testar contra produção precisa saber.

## 🔴 O recorte das mistas tira 2 PCs BAIXADAS sem motivo

```
2022TR001707, parcela 6 — o que o script vê:
  2023PC000782  1 -> 6  baixada=true   SCC 00008463/2023   <- sai a toa
  2023PC002991  1 -> 6  baixada=true   SCC 00008463/2023   <- sai a toa
  2023PC003638  9 -> 6  baixada=false  '-1'   <- nunca chega ao 6: excluida pelo recorte do -1
  2023PC004025  9 -> 6  baixada=false  '-1'   <- idem
```
Tirando as duas do `-1`, a parcela 6 fica com **duas PCs, ambas baixadas — não é mista**.

*Na tela:* o lote arruma a `2022TR001707` inteira **menos** essas duas, que ficam na parcial 1
junto com a `2022PC002525`. Três PCs baixadas empilhadas numa parcela que o SIGEF diz ter uma,
no meio de uma TR recém-renumerada — **e nada avisa**. Como são baixadas, é unidade de
produtividade no lugar errado.

⚠️ O check `parcelas mistas criadas = 0` **não pega**: ele só verifica que nenhuma foi criada.
Excluir PCs a mais passa por ele.

## 🟡 As 4 linhas de histórico descartadas em silêncio

| id | TR | atual | evento | destinos possíveis |
|---|---|---|---|---|
| 1 | 2020TR000657 | 1 | `migracao_ci` | **2, 3, 4** |
| 238 | 2020TR000831 | 5 | `parecer` | 8, 9 |
| 37 | 2022TR000848 | 2 | `situacao` | 3, 4 |
| 316 | 2022TR000851 | 6 | `parecer` | 7, 8 |

Descartar é a decisão certa (escolher seria chutar), mas **elas ficam apontando para uma
parcela cujo conteúdo mudou**. A `2020TR000657` é a TR com 8 PCs no ciclo do C.I.
**É regra, não técnica — decisão sua.**

## As perguntas, com número

**1..N — 1.546 → 1.496. CAI 50** (55 deixam de fechar, 5 passam), de 1.554 TRs.
⚠️ A primeira fórmula dele usava `COUNT(*)` (conta PC, não parcela) e deu 867 — errada; a
corrigida bate com o revisor na ordem de grandeza. **A causa medida:** o mapa atribui números
do SIGEF acima do total de parcelas que a base tem — o furo **já existe na realidade** e está
mascarado por uma numeração compactada.

**Pares (tr, processo_pc) com 2+ parciais — 0 → 68.**
⚠️ Hoje o banco tem **exatamente 0**. Depois do `--gravar` ele passa a dizer "sim, em 68
casos". **Não é efeito colateral: é a decisão em disputa sendo tomada pelo `UPDATE`.**

**112 PCs baixadas mudam de número**, em 33 TRs e 22 analistas. Mexe no *rótulo*, não na baixa
(`baixada`/`data_baixa` conferidas intactas). Maiores: Gabriele `2020TR000831` 12 · Aline
`2020TR000818` 11 · Daiana `2020TR000643` 8 · Claudia `2020TR000657` 8 · Geisa `2020TR000722` 6.
**Você aparece:** `2021TR001690`, 1 PC, `1 -> 2`.

**As 20 PCs no C.I. ficam íntegras** — todas `na_fila`, `ci_rodada = 1`, `enviado_ci = true`,
`baixada = true`, conferidas coluna a coluna dentro da transação. `ci_mensagem` casa por
`codigo_pc`, então a conversa acompanha a PC.
⚠️ **Mas o encaminhamento é por PARCELA, e há permutas:** na `2020TR000818` a 15→12 e a 22→21;
na `2020TR000686` a 5→4. Uma parcela que foi ao C.I. como "12" passa a ser "13", e outra
assume o "12".

**⚠️ O lote produz 12 FUSÕES e 69 SPLITS** (5.429 → 5.518 parcelas). O `CLAUDE.md` registra que
*"a fusão de parcelas nunca foi exercitada contra o banco — não há hoje correção que a
dispare"*. **Este lote dispara 12.**

## ⚠️ Dois dados que CONTRADIZEM a documentação

- O ciclo do C.I. tem hoje **585 PCs em 114 TRs** (todas `na_fila`, todas baixadas), **não as
  13** que o `CLAUDE.md` e o `SESSAO.md` registram.
- **`ci_mensagem` está VAZIA** — 0 mensagens.

## O que ele NÃO conseguiu provar

1. **A ordenação numérica do `convive`** — existem **0** pares com 2+ parciais hoje, então
   `outras_parciais` sempre tem 1 elemento e o comparador **nunca é exercido**.
   ⚠️ **É o lote que cria os 68 pares** — ele torna esse caminho alcançável pela primeira vez.
2. **A rota chamada duas vezes** (idempotência) — exigiria gravar.
3. **O efeito das permutas na fila do C.I.** — é tela, não dado.
4. **Se as 55 TRs que perdem o 1..N estão certas** — depende do SIGEF, que ele não consultou.
5. ⚠️ **A trava "parcelas mistas" nunca disparou de verdade** — não há um único grupo misto na
   base. **Trava que nunca disparou não é prova de segurança** (mesma família da trava do C.I.
   de 13/08).

**Efeito colateral sem dado:** a sequence de `parcela_historico.id` avançou (id 858 consumido
por um `INSERT` desfeito). Nenhuma linha existe.

---
---

# RODADA 2 — revisor. Os 3 bloqueios fecharam; 4 novos.

✅ **Confirmado fechado:** a CTE `proj`/`dest` corrige o bloqueio 1 — medido: **0 linhas de
histórico passam a cobrir PC que não estava na parcela original, 0 perdem cobertura, 0
colisões**. Preservar o `criado_em` mantém o sino igual (`job_notificacoes.js` silencia por
`h.criado_em > p.dt_situacao`); com `NOW()` mudaria. Remover o recorte das mistas **não criou
fusão nenhuma** (as 12 existem nos dois cenários) e mistas depois = 0.

## 🔴 1. O recorte do `-1` só guarda UMA direção — 22 PCs pousam em cima de um `-1`

O recorte impede o `-1` de **se mover para** uma parcela real. Não impede o contrário: o `-1`
fica parado no número dele e **as PCs reais são renumeradas para cima dele**.

| | |
|---|---|
| parcelas com 2+ processos | **2 hoje → 12 depois** |
| PCs do lote que aterrissam na parcela de um `-1` | **22**, em **12 TRs** |
| dessas 12 TRs, com analista | **9** — inclusive a **2020TR000820, sua** |

```
2020TR000820|19   2024PC000542 fica p19  -1                 R$ 339.018,24
                  2023PC003705 p17 -> p19 SCC 00008061/2024  R$ 325.722,54
                  2024PC000331 p17 -> p19 SCC 00008061/2024  R$  40.975,15
2020TR000642|27   2024PC000583 fica p27  -1                 R$ 169.361,85 (+3 PCs SCC)
2020TR000800|47   2024PC000627 fica p47  -1                 R$ 213.349,88 (+1 PC SCC)
2020TR000717|5    7 PCs '-1' + 5 PCs SCC 6488/2024
```

**Na tela:** `POST /parcela/parecer` baixa por `WHERE tr AND parcial_num`, sem lista de PC. A
analista registra o parecer da parcela 19 e **baixa junto a PC de R$ 339 mil cujo processo é
`-1`** — que ninguém analisou. É a **mesma família das 3 PCs FINAIS com `parcial_num='1'`**, e
o lote **cria 22 casos novos**.

⚠️ **Nenhum dos 8 checks vê**: as 22 e os `-1` estão todos abertos, então "mistas" continua 0.

## 🔴 2. O comando de reversão impresso NÃO desfaz as 9 cópias

Os dois `UPDATE` restauram números; **nenhum apaga as linhas inseridas**. Quem reverter fica
com 9 linhas fantasma em parcelas que voltaram a não se partir, e não dá erro.
O `INSERT` não usa `RETURNING id`, então os ids nunca são impressos — só a nota na `observacao`
permite reencontrá-las, e reverter por texto é condição derivada (regra 12).

## 🔴 3. As 2 fusões legítimas continuam DENTRO do lote (decisão)

`2022TR000791` e `2022TR000967` **não estão no `FORA_DO_LOTE`** — são as duas do bloqueio 5 do
`SESSAO.md`, o mesmo SGPe em duas grafias. **São as únicas 2 parcelas com 2+ processos que
existem hoje, e o lote desfaz as duas**, movendo 4 PCs baixadas.
Pode ser consequência aceita da decisão do split — mas está tomada **em silêncio**, e o
comentário do `FORA_DO_LOTE` afirma o contrário do que o código faz.

## 🔴 4. O `dono ?? quem.id` devolve à coluna os DOIS significados — defeito que EU introduzi

**6.168 das 14.652 PCs não têm dono (42%).** Nessas grava-se `analista_id = quem clicou` com
`executado_por = NULL` — e NULL quer dizer *"foi o dono mesmo"*. A linha mente como antes.

⚠️ **E o agravante é o que a correção introduziu:** antes, `evento='processo_pc'` tinha um
significado só. Agora, **dentro do mesmo evento**, a coluna é o DONO quando a PC tem dono e o
EXECUTOR quando não tem, sem nada que distinga. É textualmente o defeito que o `CLAUDE.md`
registra para 13/08 (*"significava o DONO em parecer/situacao/ci e o EXECUTOR em
devolucao_tr/estorno"*), reintroduzido em escala menor.

**O que fazer com PC sem dono é regra:** `analista_id = NULL` + `executado_por = quem.id`, ou
manter?

## 🟡 Pode esperar

| # | o quê |
|---|---|
| 5 | as duas rotas **não chamam `autoria.resolver`** nem conferem titularidade — qualquer analista autenticado produz linha no `analista_id` de outro. Hoje o lápis é escondido no "ver como" **pela TELA**, não pela rota. |
| 6 | o check das mistas é **absoluto**, não delta — armadilha 21 pela metade, no mesmo arquivo que a aplica certo 3 blocos acima. |
| 7 | `ARRAY_AGG(DISTINCT destino)` ordena por **texto**: entre `'9'` e `'11'`, `destinos[0]` é `'11'`. Não corrompe; falta o `ORDER BY` explícito. |
| 8 | o log do `FORA_PCS` diz `0 PCs []` e logo abaixo `BATE (3 códigos)` — quem lê entende que foram excluídas, **e elas entram**. |

---

# RODADA 2 — qa-banco. 27 OK · 4 falhas · dupla verificação completa.

**Janela OCUPADA — ele NÃO subiu o Express** (o boot roda DDL com `ACCESS EXCLUSIVE`). Tudo
saiu de `SELECT` e `BEGIN…ROLLBACK`. Nada gravado.

## ✅ Os 9 números do dry-run, medidos por SQL próprio e cego

PCs 2.106 · parciais 1.211 · TRs 172 · baixadas 114 · parecer 106 · C.I. 20 ·
histórico 85 = 79+6 · cópias +9 → 15 · 1..N 8→56. **Nenhuma divergência.**

**As 9 cópias:** 0 órfãs · 0 duplicam evento existente · 743+9 = 752 ✓ · **`criado_em` é o do
original, não `NOW()`** (a mais recente é de 15/08; `NOW()` era 16/08 18:54).
**Depois do dry-run nada sobrou:** os dois backups `b` não existem, o de 11 colunas intacto,
`parcela_historico` de volta a 743.

## 🔴 CONFIRMA o bloqueio 1 do revisor, medido pelo outro lado

| | revisor | qa-banco |
|---|---|---|
| parcelas com 2+ processos | 2 → **12** | 2 → **12** |
| o que contou | **22 PCs do lote** que aterrissam num `-1` | **45 PCs · R$ 2.251.784,68** nas parcelas fundidas |

**As 12 TRs:** `2020TR000642` Cris · `2020TR000647` Gislainy · `2020TR000686` Miriam ·
`2020TR000717` **Sandra Paul (12 PCs)** · `2020TR000800` Grace · `2020TR000820` **Richard** ·
`2020TR000831` Gabriele · `2022TR000851` e `2022TR001707` Elisandra · `2024TR000446`,
`2024TR000744`, `2024TR000801` sem dono.

**Está impresso na saída do próprio dry-run, sem nada apontando:**
```
── 2020TR000800 · Grace Oliveira ──
     45 -> 47   SCC8970/2024     1 PC     122053.21
     47    47   -1               1 PC     213349.88     ← as duas terminam na 47
```
Na tela da Grace: onde há uma parcial 45 e uma 47, passaria a haver **uma parcial 47 com
R$ 335.403,09 e dois processos SGPe**. É a **armadilha 22 na direção que ninguém mediu**, e o
`CLAUDE.md` registra que a fusão de parcela *"nunca foi exercitada contra o banco"*.

## 🔴 CONFIRMA o bloqueio 4 — e mede o tamanho

| caso | `analista_id` | `executado_por` | |
|---|---|---|---|
| dono ≠ executor | 18 (o DONO) | 4 | OK |
| dono = executor | 4 | NULL | OK |
| **PC sem dono** | **4 — o EXECUTOR** | NULL | **FALHA** |

**6.168 PCs em 792 das 1.559 TRs estão sem dono — 42% do acervo, o estoque inteiro.**
Os dois sinais somem juntos: a observação também omite o `· executado por …`, porque é
condicionada ao mesmo `executor`.

## ⚠️ CORREÇÃO — as "25 linhas já erradas" não são o que eu disse

A contagem bate (**28**), a causa não. Nas 28, `analista_id` é **NULL** — campo vazio, não
executor trocado. E a observação delas diz *"correção em lote de 13/08"*: **vieram dos
scripts**, não do lápis.

As **19 linhas que saíram da rota** têm `analista_id` = 17, 7, 23, 21, 33, 35 — e **todas
batem com o dono**, porque até hoje quem usou o lápis foi sempre o próprio dono.

**O defeito de código é real e a correção é necessária — mas ele nunca se materializou no
banco.** O comentário que escrevi no `server.js` descreve um caso que não existe, e um
`UPDATE ... WHERE analista_id = executado_por` não acharia nada.

✅ **As 28 são 100% determináveis:** as 14 TRs têm exatamente 1 dono hoje, `conflito = 0`,
nenhuma aparece nos 13 eventos de troca de mão, `dt_assumida IS NULL` nas 14.

## 🟡 FALHA D — a coluna "analista" da lista do 1..N é sempre NULL

`p2` é a parcela **que falta**, e o `WHERE p2.codigo_pc IS NULL` força o lado nulo do
`LEFT JOIN` — `MAX(p2.analista_nome)` não pode mostrar nada, com dado nenhum.
**6 das 56 TRs têm dono:** Claudia, Daniela, Goreti, **Grace Oliveira**, **Richard**, Rita.
A contradição está na mesma tela: `2020TR000800 (sem analista)` na lista, e
`── 2020TR000800 · Grace Oliveira ──` vinte linhas abaixo.

## OBS
- a sequence `parcela_historico_id_seq` foi de 870 → 901: **cada dry-run queima 9 ids para
  sempre** (sequence não é transacional). Sem dano.
- `POST /sgpe/link_manual` **nunca rodou** — 0 de 743 linhas. Sem `codigo_pc` no corpo ela
  grava `tr = NULL` e `parcial_num = NULL`: a linha nasce órfã de TR.

## Não provado
Nada por HTTP (janela ocupada + DDL no boot): os 403 por perfil, corpo sem campo, TR
inexistente, rota chamada duas vezes. E as duas rotas comitam sozinhas — armadilha 11.
