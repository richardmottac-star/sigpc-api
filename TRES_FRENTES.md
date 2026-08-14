# As três frentes — diagnóstico, 13/08/2026

> **O que precisa de você, em uma linha cada:**
> **1.** O botão do CI **nunca funcionou** — nem uma vez, em produção. A trava é regra, mas
> depois do parecer o botão **some da tela**. Qual das duas leituras vale é decisão sua.
> **2.** Dá para reaproveitar a tela do pedido de vaga, **mas não a tabela** — sete consultas
> a leriam ao contrário e dariam TR extra a quem pediu para devolver.
> **3.** Feito e testado. Espera o print para o ajuste fino.

---

# 1. ENCAMINHAR AO CI — a causa

## Que condição desabilita

`index.html`, dentro de `renderPlan` (o cartão da TR na **Minha Planilha**):

```js
const podeCI = !!pa.parecer_tipo          // ← linha 8273
```

Sem parecer na parcial, o botão fica cinza, com o motivo no `title`
(*"Registre o parecer antes de encaminhar ao Controle Interno"*).

## É regra ou defeito? — As duas coisas, e é aí que trava

**A trava é REGRA, e está certa.** O servidor faz a mesma conferência, em
`server.js:3040`:

```js
if (!pcs.some(p => p.parecer_tipo))
  return res.status(409).json({ ... 'CI exige parecer prévio' });
```

Front e servidor concordam. Nada a corrigir aqui.

**O DEFEITO está no que acontece depois.** Registrar o parecer grava
`baixada = true` na parcela inteira (`server.js:2831`). E o cartão tem **dois ramos**: a
parcial baixada cai no ramo verde de leitura (linha 8256), que **não desenha o botão do CI**.

Ou seja:

| estado da parcial | o botão |
|---|---|
| sem parecer | **cinza**, com o motivo |
| com parecer | **não existe** — a parcial virou verde |

**Não há terceiro estado.** O botão nunca está clicável.

## A medição — 6.451 parciais

| estado | parciais | o botão |
|---|---|---|
| sem parecer, não baixada | **4.259** | cinza |
| com parecer, toda baixada | **2.181** | **sumiu** |
| baixada sem parecer, já no CI | 6 | — |
| com parecer e **não** toda baixada | **5** | **aceso** |

As 5 que acendem não são caso normal: **2** são estornos que deixaram o `parecer_tipo` para
trás (Rita e Valderi) e **3** são TRs com a PC FINAL agrupada junto da parcial 1 — ver a
descoberta no fim desta seção.

**A prova definitiva:** as **13 PCs que estão no C.I. hoje não passaram pelo botão.** Todas
entraram por `migracao_ci`, em 05/08/2026 às 14:59, junto com a recarga
(`origem_baixa = 'recarga_parcial_20260805'`), e **nenhuma tem parecer**. O histórico registra
um único evento para as seis parcelas, no mesmo segundo. Não existe nenhum registro de envio
ao CI feito por analista.

## ⚠️ A decisão é sua — e as duas leituras se contradizem no próprio sistema

O manual dentro do sistema (item 4, "Encaminhar ao Controle Interno") diz:

> *"O envio ao CI **conta como baixa**, conforme orientação da CGE de 30/04/2026."*

Se o envio ao CI **é** a baixa, exigir parecer antes é contraditório: quem manda ao CI ainda
não concluiu com parecer. Mas o código — front **e** servidor — exige o parecer primeiro.

**Qual das duas vale?**

**(A) O CI vem DEPOIS do parecer.** A trava está certa e o manual é que está mal escrito.
→ Correção: o botão passa a aparecer **também no ramo verde** (parcial baixada), ao lado de
"Ver parecer". Some quando `enviado_ci` já for verdadeiro.
→ Libera **2.181** parciais.

**(B) O CI é um CAMINHO ALTERNATIVO ao parecer.** O analista manda ao CI *em vez de* dar o
parecer, e o envio é que baixa.
→ Correção maior: cai a trava do servidor (`CI exige parecer prévio`), o botão acende sem
parecer, e o `POST /parcela/ci` passa a gravar a baixa.
→ Libera as **4.259**, e mexe em `baixada`/`data_baixa` — **escrita nova em rota que hoje não
toca na baixa**, contra a regra que está no `CLAUDE.md`.

**Não escolhi.** (A) é uma tela; (B) muda a contagem de produtividade de todo mundo.

## ⚠️ Achado de tabela — 3 PCs FINAIS agrupadas como parcial 1

Apareceu na conferência, e **não é do escopo desta frente**:

| TR | analista | o que tem na "parcial 1" |
|---|---|---|
| 2021TR001689 | Grazielly | `2021PC002220` (parcial, em análise) **+** `2021TR001689-PFINAL` (baixada) |
| 2021TR002133 | Richard | `2021PC002319` (diligência) **+** `2021TR002133-PFINAL` (baixada) |
| 2023TR000048 | Elisandra | duas PCs livres **+** `2023TR000048-PFINAL` (baixada) |

A FINAL ficou com `parcial_num = '1'` em vez de `'FINAL'`. Como todas as rotas de parcela
gravam por `WHERE tr = ... AND parcial_num = ...`, **um parecer na parcial 1 dessas três TRs
baixaria a FINAL junto** — e o contrário também. São 3 TRs, e é correção de DADO, não de
código. Deixei anotado e não toquei.

---

# 2. SOLICITAR DEVOLUÇÃO PELO ANALISTA — o que medi antes de propor

## Onde entra o botão

No **cartão da TR**, no mesmo lugar onde hoje só o superadmin tem o "↩ Devolver ao estoque"
(`abrirDevM`). Para o analista o rótulo muda — *"Solicitar devolução"* — porque ele **pede**,
não devolve.

Já existe o esqueleto pronto e morto: o modal **`moDev`** e a função **`confDev`**
(`index.html:955` e `5550`), a "Solicitar Devolução" que **nunca teve rota no servidor**.
Está listada como código morto no `CLAUDE.md`. **É este esqueleto que a frente ressuscita.**
⚠️ Não confundir com `moDevM`/`confDevM`, que é a devolução do superadmin e está viva.

## Dá para reaproveitar o fluxo de "solicitar mais uma TR"? — Em parte, e a parte que não dá é perigosa

**A tela e o fluxo de aprovação: sim.** `moPrompt` com justificativa obrigatória → `POST` →
notificação para a coordenação → aba de Aprovações → o sino avisa a resposta. É o mesmo
caminho, já construído e já testado.

**A tabela `solicitacao_vaga`: NÃO, do jeito que está.** Ela não tem coluna `tipo`, e
**sete consultas de `lib/limite-tr.js` leem essa tabela sem filtro nenhum.** Um pedido de
devolução gravado ali seria lido como pedido de vaga:

| consulta | o que faria com um pedido de DEVOLUÇÃO |
|---|---|
| `contarVagasExtras` | aprovado → **+1 no limite de TRs** de quem pediu para devolver |
| `reservaPendente` / `reservasPendentes` | pendente → **reserva a TR no Estoque**, com a tag *"Fulano pediu esta TR"* — a TR que ele quer largar |
| `expirarPendentes` | em 3 dias vira `expirada` e notifica *"a TR voltou ao estoque"* |
| `autorizacaoAprovada` / `consumirVagaExtra` | o próximo "Assumir" **consome** a devolução aprovada como autorização para furar o limite |

É a família de defeito que mais aparece aqui: **não dá erro em lugar nenhum.** O coordenador
aprova uma devolução e o analista ganha uma TR a mais, em silêncio.

**Dois caminhos, e a escolha é sua:**

- **(I) Tabela nova `solicitacao_devolucao`** — `ALTER`/`CREATE` novo, mas nenhuma consulta
  existente muda de significado. Mais linhas de código, risco zero para o limite.
- **(II) Coluna `tipo` em `solicitacao_vaga`** — uma coluna só, **mas obriga a acrescentar
  `AND tipo = 'vaga'` nas sete consultas**. Esquecer uma é o defeito acima.

**Recomendo a (I).** As duas exigem sua autorização de escrita — o comando vai na tela antes.

## O que acontece com PC já baixada ou no CI

A regra já existe e está provada, em `lib/devolucao.js` — o pedido do analista deve usar
**exatamente a mesma função**, senão a prévia dele e a do superadmin divergem:

- **PC baixada NÃO volta ao estoque.** `baixada`, `data_baixa`, `enviado_ci`, `parecer_tipo` e
  as colunas `ci_*` não são tocadas em nenhum caminho. A produtividade de quem analisou fica.
- **PC com `ci_situacao` em `na_fila` ou `com_analista` BLOQUEIA a devolução inteira** — a
  conta é feita sobre a TR toda, não só sobre as não baixadas (foi o defeito de 13/08: as 13
  PCs do C.I. são todas baixadas, e a trava nunca disparava).
- Se **todas** as PCs da TR já estiverem baixadas: *"Nada a devolver."*

⚠️ **Uma pergunta de regra que só você responde:** enquanto o pedido de devolução está
pendente, o analista **continua com a TR**? Se continuar, ela conta no limite dele — e ele
pode estar pedindo devolução justamente para liberar vaga. Se não continuar, a TR fica em
limbo antes de alguém decidir.

---

# 3. MODAL DO LIMITE ATINGIDO — feito

Implementado conforme o pedido, `node --check` OK e **as 15 suítes do front verdes**
(87 no `vercomo`, 40 no `pedidos`, com 15 asserções novas).

- Faixa **#C62828** com o título **"Limite atingido"**.
- O **"Assumir" cinza sai da tela** quando o bloqueio é limite — e **só** nesse caso.
- Botão de **largura total**, fundo `#C62828`, texto branco em negrito, com ícone:
  **➕ Pedir vaga extra para esta TR**.
- Abaixo, em cinza: *"O pedido vai para sua coordenação — você é avisado pelo sino quando
  houver resposta."*
- O modal **sem** limite atingido não mudou.

**Três decisões técnicas que tomei** (não são regra — não mudam o que o sistema faz):

1. **A reserva continua com o botão cinza.** Quando o bloqueio é *"outro analista pediu esta
   TR antes"*, esconder o Assumir e oferecer "pedir vaga extra" mandaria pedir uma TR que já é
   de outro. São dois bloqueios diferentes e duas conversas diferentes.
2. **Quem esconde é o `assBotao`**, com um terceiro argumento que nasce falso — as chamadas
   antigas repõem o botão sozinhas.
3. **No erro de rede o botão não volta.** `confirmarAssumirTR` repassa a decisão de esconder;
   sem isso, um erro faria o "Assumir" reaparecer cinza no modal de onde ele tinha saído.

**Falta o print** para o ajuste fino de espaçamento e do ícone. Nada mais.

---

## Estado

Nada publicado — as duas árvores estão sujas, esperando sua ordem. Nenhuma escrita no banco:
tudo aqui saiu de `SELECT`.
