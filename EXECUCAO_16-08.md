# Execução de 16/08/2026 — o que mudou depois de medir

**Nada gravado ainda.** Este arquivo registra as decisões que tomei sozinho pela sua regra
*"escolhe o que NÃO desfaz trabalho feito, registra e SEGUE"*, nos pontos em que a medição
contradisse o pedido.

---

## ⚠️ Item 4 — as duas TRs "no nome errado". As duas mediram diferente do relato.

### `2022TR000720` — o Rafael está certo, e mesmo assim NÃO devolvo

| | |
|---|---|
| está com | **Marlene Teodoro Ramos da Silva (id 46)** |
| Rafael é | id 47 |
| PCs | 2 — **as duas baixadas** |

**O relato procede: não está com o Rafael.** Mas devolver ao estoque **desfaria duas baixas**,
e você escreveu duas regras que proíbem isso: *"não toca em baixada"* e *"escolhe o que não
desfaz trabalho feito"*. **Não devolvi.** Fica registrado para você decidir com a Marlene —
pode ser que ela tenha analisado mesmo.

### `2022TR001687` — não é TR no nome errado. É `analista_nome` mentindo.

| PC | `analista_id` | quem é de verdade | `analista_nome` grava | baixada |
|---|---|---|---|---|
| 1 | **35** | Tanimeri Schveitzer (grupo 2) | `Tanimeri` | não |
| 2 | **45** | **Juliana de Souza (grupo 3)** | **`Tanimeri`** ← errado | **sim** |

⚠️ **É a armadilha 1 acontecendo com dado real.** A PC baixada está no `analista_id` da
Juliana, mas o `analista_nome` diz "Tanimeri". O sistema filtra por `analista_id` — então a
**produtividade conta essa baixa para a Juliana**, que diz não ter analisado, enquanto a tela
mostra o nome da Tanimeri.

**Não é "TR no analista errado": é uma linha com dois donos diferentes gravados em dois
campos.** Corrigir exige saber qual dos dois é o certo, e nenhum dos dois campos é mais
confiável que o outro *a priori*. **Não toquei.**

---

## ⚠️ Item 5 — os três processos. Dois não existem, e um já está certo.

| relatado | o que o banco tem | avaliação |
|---|---|---|
| `2021TR000370` p1 e p2 — `SCC 6350/2022` | **só existe a parcial 1**, com `SCC4112/2022` | não há p2; e o processo é outro |
| `2020TR000930` p1 — `SCC 12006/2020` | `SCC12012/2020` | **difere em 1 dígito** |
| `2022TR001706` p4 — `SCC 7872/2024` | `SCC 00007872/2024` | **já está correto** — nada a fazer |

⚠️ **Nenhum dos dois processos relatados existe em lugar nenhum da base** (conferido
normalizado, nas 14.652 linhas).

**O pedido era "inclui", mas não há o que incluir: as PCs existem e já têm processo.** O que
se faria é **sobrescrever** o processo atual por um número relatado à mão — e isso é
exatamente a **armadilha 19**: `12012` contra `12006` é um dígito, e não há como saber de que
lado está o erro de digitação sem consultar o SGPe. **Link para o processo errado não dá erro
na tela, e ninguém percebe.**

**Não sobrescrevi.** Os três casos resolvem pelo **lápis**, com o SGPe aberto do lado — que é
o caminho que já existe para isso.

---

## ⚠️ Item 6 — "parcial que não exibe status" é grande demais para ser isso

A leitura literal — parcial não baixada, sem `situacao_atual` e sem `status` útil — devolve
**6.013 PCs em 1.466 parciais**. Isso não é defeito: é o estado normal de quem ainda não
começou a analisar. Não existe uma "parcial que não exibe status" isolada para corrigir.

**O que eu vou fazer:** a etiqueta do item 7 cobre o caso visível (PC sem processo), e o
cartão passa a mostrar **"não iniciada"** em vez de célula vazia quando não há situação. Se
não era isso, me aponte a parcial e eu corrijo a de verdade.

---

## O `-1` — de onde vêm, quantas, e o que a planilha tem

| | |
|---|---|
| PCs com `processo_pc = '-1'` | **77**, em **48 TRs** |
| já baixadas | **3** |
| com dono | **55** |
| valor somado | **R$ 2.307.057,83** |

**De onde vêm:** todas têm `processo_mae` preenchido e válido — o que falta é só o processo
**da PC**. São PCs que a CGE entregou sem o número do processo SGPe próprio, não PCs inventadas.
Concentração: `2020TR000717` (Sandra Paul) 7 · `2020TR000761` (Noici) 4 · `2022TR000804`
(Scheila) 4 · `2020TR000831` (Gabriele) 4 · `2020TR000830` (Marisa) 4.

**As maiores em valor**, e por isso as que mais importam recuperar:
`2020TR000820` (você) R$ 339.018,24 · `2020TR000761` (Noici) R$ 333.008,36 ·
`2022TR001103` R$ 213.039,62 · `2020TR000800` (Grace) R$ 213.349,88 ·
`2020TR000642` (Cris) R$ 169.361,85.

---

## ⚠️ O cruzamento do `-1` com as planilhas — 0 recuperáveis com segurança

| | |
|---|---|
| PCs com `-1` | **77** |
| candidato único aparente | 12 |
| **ambíguos (2 a 12 candidatos)** | **15** |
| **sem candidato nenhum** | **50** — 27 "a planilha não tem processo sobrando", 23 "TR sem linha na planilha" |

### Por que os 12 NÃO foram gravados

**A armadilha 19 é literal sobre isto:** *"um candidato só esconde a ambiguidade em vez de
revelá-la"*. Dos 12, **nenhum** tem confirmação independente:

| PCs | TR / analista | candidato | por que não vale |
|---|---|---|---|
| 5 | `2020TR000717` Sandra Paul | `SCC 11291/2022` | casou por **valor 2.500 repetido** em 5 PCs — e o valor da planilha é da **parcela**, não da PC. Granularidade diferente: 5 × 2.500 = 12.500, não 2.500. |
| 4 | `2020TR000761` Noici | `SCC00293/2022` | "único sobrando", e os valores **não batem** (92.485,30 ×3 e 55.552,46) |
| 1 | `2020TR000686` Miriam | `SCC 17943/2025` | processo de **2025** — ano que a base não tem |
| 1 | `2021TR002198` Perla | `SCC 9853/2023 e SCC 7323/2024` | a célula tem **dois processos** dentro |
| 1 | `2022TR000851` Elisandra | `SCC 8336/2024` | "único sobrando", valor 0,44 sem confirmação |

**"Único sobrando" não é confirmação — é ausência de alternativa**, que é exatamente o que a
armadilha 19 manda recusar. E os ambíguos confirmam o risco: a `2020TR000831` tem **12**
candidatos; a `2020TR000642` tem 6, todos de **2026**.

⚠️ **Gravar qualquer um desses criaria um link para o processo errado — que não dá erro na
tela e ninguém percebe.** É o defeito mais caro que este projeto já registrou.

**O que fica:** as **77 PCs entram no lote e recebem o número do SIGEF**, como você decidiu, e
ganham a **etiqueta âmbar com o lápis ativo**. A recuperação do processo é caso a caso, pelo
lápis, com o SGPe aberto — e agora a etiqueta mostra exatamente onde.

O `RECUPERAR_MENOS1.csv` com os 12 candidatos ficou na raiz, **não versionado**, para quem
quiser conferir um a um no SGPe.

---
---

# REVISÃO DO SCRIPT DE GRAVAÇÃO — o revisor NÃO assinou

> *"O dry-run diz 11 de 11 OK e isso é verdade — as onze conferências que existem passam.
> O problema é o que não tem check."*

**Veredicto:** frentes **1, 3 e 4 podem gravar** depois dos achados 1, 6 e 7.
**A frente 2 não** — cinco dos sete bloqueios são só dela.

## 🔴 1. A trava da janela NÃO EXISTE

`ocupado` é calculado, impresso como `>> OCUPADO`, e **nunca usado**. `FORCAR` é declarado e
nunca lido. E o `catch (e) { n = 0 }` faz um `SELECT` que falhe virar "sinal limpo".

⚠️ **É o defeito nº 2 do `renumerar_sigef.js` de volta com outra roupa** — *"a trava é lint,
não guarda: não pode disparar com dado nenhum, e imprime ✓"*.

## 🔴 2. A frente 2 desarma a guarda "Parcial já baixada" em 83 parcelas

**O pior.** `server.js:3292` recusa o parecer com `if (jaBaixadas.length === pcs.length)`.
Inserindo uma PC **não baixada** dentro de uma parcela **100% baixada**, a condição para de
ser verdadeira e **o 409 nunca dispara**.

Medido: **208 das 324 caem em parcela que já existe; 83 estão 100% baixadas, 84 já têm
parecer.** O UPDATE do parecer é `WHERE tr AND parcial_num` — condição derivada, sem lista —
e reescreve a parcela inteira:

```sql
SET baixada=true, data_baixa=NOW(), origem_baixa='sistema', parecer_tipo=$1
```

As PCs antigas têm `data_baixa = 30/06/2026` e `origem_baixa = 'carga_historica'`. **Um
parecer futuro move a baixa delas para agosto e sobrescreve o parecer que já estava lá.**
A produtividade salta, o Quadro 2 conta em agosto o que foi baixado em junho, e ninguém
reclama de uma baixa que ficou mais recente.

## 🔴 3. 61 PCs entrariam com `parcial_num = ''` — trabalho que ninguém consegue fechar

61 linhas do CSV têm a coluna `parcial` vazia. `faltaChave` (`server.js:3240`) recusa `''`:
**parecer, situação, C.I., resposta de diligência e estorno devolvem 400**. Na tela, `semNum`
dispara, o card diz *"sem nº de parcial"* e **os três botões somem**.

Elas apareceriam na Minha Planilha, contariam no estoque e no Board, derrubariam o `pct` do
analista — e não teriam saída.

## 🔴 4. 5 PCs FINAIS entrariam como `tipo='parcial'`, na chave da PFINAL

O CSV traz 7 linhas com `parcial = FINAL`; 5 sobrevivem. `2020TR000811` · `2021TR002233` ·
`2022TR000927` · `2022TR001421` · `2024TR000204` — todas já têm uma `-PFINAL` com
`parcial_num = 'FINAL'`. `carregarParcela` não filtra `tipo`, então **um parecer na FINAL
baixa a nova junto**.

⚠️ É a pendência aberta do `CLAUDE.md` sendo **criada de novo, cinco vezes, no mesmo dia em
que ela está na lista para corrigir**.

E `2022TR000927` está em `FORA_DO_LOTE` — **o recorte da frente 1 não recorta a frente 2**.

## 🔴 5. 184 das 324 receberiam texto de PARECER em `situacao_atual`

| valor no CSV | linhas | é situação válida? |
|---|---|---|
| Parecer Regular com Ressalvas | 82 | **não — é parecer** |
| Parecer Regular com Ressalva | 60 | **não** |
| Parecer Regular | 31 | **não** |
| Analisar | 11 | **não** |
| Análise | 65 | não (a válida é `Em análise`) |
| Reanalise | 5 | não (a válida é `Reanálise`) |

O INSERT passa **por baixo** da trava `SITUACOES_VALIDAS`, que existe e está certa. A tela
mostraria *"Parecer Regular com Ressalvas"* numa PC com `baixada=false` e `parecer_tipo=NULL`
— o analista lê que já tem parecer e não volta. E os 70 de `Análise`/`Reanalise` não casam
com filtro nenhum: **ligar o filtro faz a TR sumir da tela**.

## 🔴 6. O modo manutenção escreve na coluna errada, e apaga a mensagem da preparação

Escrevo em `mensagem`; `lib/manutencao.js` lê **`mensagem_manutencao`**. E o `finally` faz
`mensagem = NULL`, **apagando o texto de boas-vindas da preparação** que está no banco desde
13/08. Não está em backup nenhum — os dois cobrem `prestacoes_contas` e `parcela_historico`.

## 🔴 7. Ctrl+C tranca 53 pessoas fora

Não há `SIGINT`/`SIGTERM`. Se o processo morrer entre o commit da manutenção e o `finally`, o
dado fica íntegro mas `modo_manutencao = true` fica commitado. **É a armadilha 23**, e o
custo de tratar são três linhas.

## 🟡 Dez achados menores, os que mais importam

- **`2924PC900000`** — o CSV tem `SCC 8486/2924` (typo) e eu extraio o ano do processo sem teste.
- **`codigo_nl` NULL em 324** — hoje são **0**. Na tela de Estorno, `estToggleNL('—')`
  **selecionaria as 324 de uma vez**.
- **6 PCs para analista diferente do dono da TR**, em 4 TRs → 403 para os dois analistas
  sem `override`, e a TR gasta vaga de cada um.
- **Frente 3:** a aba "Na fila" do C.I. vai de **585 para 2.284**, e as 1.671 com
  `dt_envio_ci = 30/06` sobem **acima** das 572 reais de 14–16/08. A fila dos três técnicos some.
- ⚠️ **Reverter a frente 3 só pela `ci_situacao` não reverte** — `server.js:4093` roda no boot
  e recoloca `na_fila`. `enviado_ci` tem de vir primeiro.
- **`movidas`, `corrigidas` e `marcadas` não são conferidos** contra o previsto — só impressos.
- **A frente 2 não é idempotente.** O que segura é o `CREATE TABLE` sem `IF NOT EXISTS`.

## ✅ O que ele confirmou certo

Regra 12 em todos os cinco UPDATE · armadilha 21 (backup dentro da transação) · armadilha 2 ·
armadilha 11 · armadilha 17 (os 4 sinais batem com o `janela_livre.js`) · `clock_timestamp()` ·
o mapa 8.998/8.998 · a faixa 900000+ **está livre** (0 usados, maior real 4.137) ·
**frente 3: os 2.144 existem, 0 sem parecer prévio, e o `AND enviado_ci = false` torna a
rodada idempotente de verdade** · escopo da frente 1 confirmado: 2.151 PCs · 196 TRs.

---

# qa-banco — 9 FALHAS · 14 OK. Confirma o revisor e acha o pior.

**Os 9 números do script conferem** por SQL independente. O defeito está no **conteúdo** do
que a frente 2 insere.

## 🔴 O ACHADO PRINCIPAL — 107 das 324 entrariam com o valor 100× MAIOR

**R$ 890.163.228,24 a mais.**

O CSV **mistura dois formatos**: brasileiro entre aspas (`"R$ 14.210,32"`) e **americano sem
aspas** (`68549.21`). A minha função `moeda()` trata o ponto como separador de milhar e o
**apaga** — todo valor americano vira 100×.

A maior PC do acervo hoje vale R$ 23,9 mi. A rodada criaria uma de **R$ 231.414.433** (o certo
é R$ 2.314.144,33).

⚠️ **E por que as 11 conferências passam:** `valor` ESTÁ na lista de protegidas, mas o check é
`JOIN ... ON p.codigo_pc = b.codigo_pc` contra o backup. **As 324 linhas novas não estão no
backup** — a proteção é cega exatamente no único lugar em que a rodada grava valor.

## 🔴 As outras quatro

- **61 PCs com `parcial_num = ''`** (hoje o banco tem zero). Na `2020TR000704` são **7 numa
  parcela só** — um parecer baixaria as sete. E o número **está na coluna errada**:
  `SCC 18792/2023 51`, `...52`, até `57`. **É deslocamento de coluna no CSV.**
- **6 PCs com `parcial_num = 'FINAL'`** inseridas como `tipo='parcial'`, em duas grafias.
  Uma é **duplicata exata da `2021TR002233-PFINAL` — R$ 100.000 em dobro**.
- **6 PCs dão segundo analista a 4 TRs** — TRs com 2+ analistas vai de 5 para 9, com
  `conflito` continuando `false`. Reabre pendência marcada como resolvida.
- **173 PCs com parecer já dado** entram como `status='analise'`, estoque aberto.

## ✅ O que ele liberou

**Frente 1 e frente 3 passam.** As **196 TRs** conferem. As 42 parcelas que ficam com dois
processos **são todas `-1`** — consequência da decisão do Richard, não defeito.
`585 + 1.699 = 2.284` bate. E **o `dt_envio_ci` herdado de 30/06 não é usado como prazo em
lugar nenhum** — o risco que eu tinha levantado não existe.

**Frente 4:** o "24" está certo. Ele contou 28, e a diferença são as 4 da `2020TR000612`, que
perde o dono único por causa da falha do segundo analista. **28 − 4 = 24.**

## O que ele não provou

**Não rodou o dry-run** — `janela_livre.js` deu OCUPADO três vezes (16:58, 17:08, 17:10).
⚠️ E o aviso operacional: o dry-run segura trava em ~4.100 linhas, e o `lock_timeout = 15s`
**protege o script, não o analista** — quem esbarrar espera sem limite até o ROLLBACK.

---
---

# FRENTE 2 v2 — REPROVADA. 14 OK · 12 FALHAS.

> *"As 7 conferências do script todas passam, e passariam de novo, porque **nenhuma delas
> pergunta se a PC está faltando** — perguntam se o INSERT saiu como planejado. O
> `valor gravado == valor do CSV` compara o script consigo mesmo."*

O qa-banco **não rodou o script**: reimplementou a seleção em `SELECT` puro (armadilha 11
evitada por construção, não por confiança no ROLLBACK). O recorte dele bateu com o meu em
tudo. **O problema não está nos números — está no que eles significam.**

## 🔴 A COLUNA `valor` DO CSV É O TOTAL DA PARCELA, NÃO O VALOR DE UMA PC

O cabeçalho da própria planilha diz: `Analista, SIGEF TR, Parcial, **Número de PCs**,
**Valor da Parcial**`. O CSV é cópia da aba 2 — **uma linha por PARCELA**. O script grava
esse número em `prestacoes_contas.valor`, que é **por PC**.

| prova | |
|---|---|
| a planilha se desmente | a coluna "Número de PCs" diz que essas 180 parcelas contêm **389 PCs**, não 180 |
| **59 das 93** | valor **igual ao centavo à SOMA das PCs que a parcela já tem no banco** |
| 68 das 78 rejeitadas | idem — o CSV **inteiro** é nível-parcela, não é recorte azarado |

`2020TR000654 p11`: CSV R$ 96.953,61 = 3.347,23 + 28.606,38 + 32.500 + 32.500 **já gravados**.

**Triangulação independente, e concorda:**

| planilha × banco | das 93 |
|---|---|
| planilha diz N PCs e o banco **já tem N** → **nada falta** | **58** |
| planilha diz N, banco tem menos → falta PC | 24 |
| **banco tem MAIS que a planilha** | 3 |
| planilha diz 0 PCs | 8 |

⚠️ **E as 24 "faltam" não salvam o lote: 22 são do Grupo 2**, com a razão `4 planilha / 2 banco`
repetida onze vezes — a inflação de ~2× do G2 já medida e registrada. E mesmo aceitando a
planilha, ela aponta **47 PCs faltando** onde o script insere **1 por parcela**.

**Na tela:** a parcela 11 da `2020TR000654` da Gabriele passaria de 4 PCs somando R$ 96.953,61
para **5 PCs somando R$ 193.907,22** — a mesma parcela contada duas vezes.
**R$ 6.120.394,20 dos R$ 8.978.780,75 (68%) seriam valor duplicado.**

## 🔴 A renumeração de HOJE mudou o alvo — e 7 escaparam da guarda por isso

**33 das 93** apontam para uma `(tr, parcial)` cujo conteúdo mudou hoje. E **7 apontavam, na
numeração em que o CSV foi escrito, para uma parcela que era 100% BAIXADA**:

```
2020TR000831 p2  antes 2 PCs, todas baixadas  ->  hoje 1 PC, aberta
2020TR000831 p3  antes 4 PCs, todas baixadas  ->  hoje 1 PC, aberta
2020TR000831 p5  antes 6 PCs, todas baixadas  ->  hoje 1 PC, aberta
2021TR000552 p8  ·  2021TR000555 p7  ·  2023TR000048 p4
2021TR000618 p5  antes 1 PC baixada  ->  hoje 0 PCs  (o script chama de "parcela nova")
```

⚠️ **A guarda teria barrado essas 7 ontem. Hoje passam — não porque melhorou, mas porque o
número se mudou de casa.**

E **25 das 93 têm um `processo_pc` que JÁ EXISTE na mesma TR e na mesma parcial** (`"SCC
8452/23"` do CSV = `"SCC 00008452/2023"` do banco): o detector de "ausentes" errou pela
**grafia do processo**, não pelo número da parcela.

## 🔴 A guarda dos 100% baixados cobre o caso errado

`POST /parcela/parecer` faz `UPDATE ... WHERE tr AND parcial_num` — **sem `baixada = false`**.
O 409 só dispara quando **todas** já estão baixadas. **`2022TR001707 p6` está MISTA (2 de 4
baixadas)** e receberia PC nova: o parecer da Elisandra passaria a `data_baixa` de hoje e
`origem_baixa = 'sistema'` nas duas antigas, mudando o mês de competência no relatório da CGE.

## 🔴 Vocabulário que o sistema não conhece

| `situacao_atual` | n | existe na base? |
|---|---|---|
| **`Análise`** | 13 | **não. zero.** |
| **`Reanalise`** (sem acento) | 5 | **não. zero.** |
| **`Analisar`** | 4 | **não. zero.** |

`index.html:9268` põe esse valor num `<select>` de 4 opções → `selectedIndex = -1`, e **o campo
obrigatório "Situação *" abre EM BRANCO**. Salvar manda `''` e o servidor devolve 400.
**É a armadilha 15 ao contrário: campo que aceita interação e não tem estado válido.**
E `index.html:8312`: a parcela **some do filtro** e não aparece em nenhum outro.

Mais: **10 com `Parecer Regular com Ressalva`** (singular, que a rota recusa com 400) e
**47 com `situacao_atual='Diligência'` mas `status='analise'`** — combinação que não existe
em nenhuma das 7.182 parciais abertas.

## 🔴 `codigo_nl` NULL

**0 das 13.626 parciais têm NL nula hoje.** As 93 seriam as primeiras da história. Não entram
em `COUNT(DISTINCT codigo_nl)`, e a baixa por NL (`server.js:2317`) tem o ramo guardado por
`&& codigo_nl` — **a PC nova não participa**, numa base onde uma NL quita até 19 PCs.

## ✅ O que passou
Valor sem erro de fator (177 de 180 são float puro — o defeito do v1 está morto neste arquivo)
· 178 de 180 batem ao centavo com a origem · as 78 rejeitadas confirmadas, 0 das 93 em parcela
100% baixada · os 93 `codigo_pc` distintos, na máscara, faixa 900000 livre · **nenhuma TR ganha
segundo analista** (5 → 5) · nada sobrou no banco.

⚠️ **Latente:** a `moeda()` **continua errada por 100×** para 34 células da origem
(`R$ 410.581.55` — ponto no lugar da vírgula). Só não chegam porque vieram vazias. **Se alguém
"completar" o CSV colando o texto original, o v1 volta em silêncio.**
