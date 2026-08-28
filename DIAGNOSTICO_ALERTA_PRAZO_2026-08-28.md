# O botão "Ver as 214" do alerta de prazo — 28/08/2026

*Diagnóstico. Nenhuma escrita. Nenhuma correção aplicada.*

## 1. O que o botão faz — e todas as funções existem

```
[Ver as 214]  →  planIrParaVencidas()  →  planFiltrarPrazo('venc365')
```

As três existem no `index.html`. **Não é o caso do `ciBolha`.** O caminho:

1. põe `venc365` no `<select id="plPrazo">` — o **mesmo** select que a pessoa usaria à mão;
2. zera `window._planPag` (sem isso, quem estava na página 3 caía no meio do resultado novo);
3. chama `buscarPlan()` **com `await`** (sem esperar, o `scrollIntoView` mirava a lista antiga);
4. rola até `#planConteudo` — e não até a barra, que fica acima e não moveria a tela.

A opção `venc365` existe no select desde 19/08 e aplica `pa.maxDias > 365`, **a mesma conta do
servidor**. O comentário no código registra que antes ele aplicava `venc` ("todas as
vencidas"), um conjunto maior — ele filtrava de verdade, mas nunca no recorte prometido.

### ⚠️ O que confunde: a UNIDADE troca no meio do caminho

| onde | unidade |
|---|---|
| o número no botão (`contagem.vencida365`) | **PCs** |
| o filtro (`pa.maxDias > 365`) | **parcelas** |
| a lista que aparece depois | **TRs** |

Depois do clique o **214 não reaparece em lugar nenhum**. A etiqueta de recorte diz
*"Mostrando só Vencidas há mais de 1 ano — N TRs de 41"*. Clicar em "Ver as 214" e receber
"9 TRs" parece que o filtro errou — e ele não errou.

⚠️ **Isto é descrição do que existe, não proposta.** A Minha Planilha SEMPRE listou TRs; o
alerta é que conta PCs. Não há nada aqui propondo trocar uma coisa pela outra — a escolha de
qual unidade o botão deve prometer é decisão do Richard, e não foi tomada.

### ⚠️ E há uma divergência REAL de conjunto

A rota exige `status <> 'baixada'`. O `maxDias` da parcela é calculado sobre **todas** as PCs
dela, **inclusive as baixadas**:

```js
const dias = pa.pcs.map(x => prazoDias(x.dt_limite_pc)).filter(x => x !== null)
```

Numa parcela mista, a PC baixada pode puxar o `maxDias` acima de 365 e trazer a parcela para o
recorte. O botão promete um conjunto e o filtro entrega outro, ligeiramente diferente.

---

## 2. O que são as 214

São do **Richard (id 4)**, em **41 TRs**.

| | |
|---|---|
| baixadas | **0** — a rota já exclui `status = 'baixada'` |
| de dispensado | **0** — são dele |
| **vindas do Samoel hoje** | **32** — a transferência de 28/08 trouxe 32 já vencidas |
| faixa de `dt_limite_pc` | 30/03/2020 a 28/09/2024 |

**O campo usado como prazo é `dt_limite_pc`** — não `dt_inicio_analise`, não `dt_assumida`,
não `data_baixa`.

### No sistema inteiro: 9.655 PCs, 44 analistas, 1.022 TRs

| analista | vencidas +1 ano |
|---|---|
| Gabriele (13) | 281 |
| Sandra Paul (18) | 272 |
| Marisa (17) | 234 |
| **Richard (4)** | **214** |
| Aline (7) | 211 |
| Marcelo (16) | 202 |
| Andressa (8) | 181 |

⚠️ **250 estão no nome de DISPENSADOS:** Guilherme 149, Willian 50, Higor 27, Goreti 24.
Nenhum deles vai abrir a tela.

⚠️ **E 5.364 estão SEM DONO** (`analista_id` nulo) — não aparecem em alerta nenhum, porque a
rota exige `analista_id`.

---

## 3. "A maior parte veio da carga inicial" — a frase está certa, e por baixo

| origem | PCs |
|---|---|
| `(nula — nunca baixada)`, sem `registrado_por` | **9.452** |
| `(nula)` + `Importacao planilhas 03/08/2026` | 164 |
| `sistema` (baixada aqui e depois estornada) | 29 |
| `recarga_parcial_20260805` | 6 |
| outras | 4 |

**9.616 das 9.655 — 99,6% — nunca nasceram no sistema.** Só **34** têm rastro de trabalho feito
aqui. A frase do alerta poderia ser mais forte do que é.

---

## 4. O cálculo do prazo

```sql
WHERE analista_id = $1
  AND status <> 'baixada'
  AND dt_limite_pc IS NOT NULL
  AND ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - dt_limite_pc) >= -30

dias = (HOJE_BR - dt_limite_pc)
  dias > 365            -> "vencida há mais de um ano"   (a faixa vermelha)
  dias entre 1 e 365    -> vencida
  dias <= 0             -> a vencer em 30 dias
```

`HOJE_BR` e **não** `CURRENT_DATE`: o Postgres do Railway roda em UTC e viraria o dia às 21h de
Brasília. Hoje as duas coincidem, mas coincidem só até as 21h.

### ⚠️ `dt_limite_pc` NÃO É PRAZO — e o `CLAUDE.md` já registrava isso

Decisão do Richard, 10/08/2026: *"`dt_limite_pc` histórico não é prazo — é cálculo em lote"*.
A distribuição das 9.655 prova:

| `dt_limite_pc` | PCs |
|---|---|
| **2021-01-30** | **3.253** |
| 2024-07-29 | 769 |
| 2022-01-30 | 519 |
| 2022-09-28 | 267 |
| 2020-03-30 | 227 |

Três mil duzentas e cinquenta e três prestações não vencem no mesmo dia por coincidência.
São carimbos de lote. **O alerta soma 9.655 "prazos" que ninguém definiu**, e apresenta o total
como passivo do analista.

⚠️ **A consequência já está no sistema:** `job_notificacoes.js` tem `CORTE_PRAZO = '2026-08-01'`
justamente para o sino **não** emitir prazo sobre esse acervo. O alerta da Minha Planilha
**não tem esse corte** — ele mostra tudo.

---

## O que NÃO foi feito

Nada. Sem escrita, sem correção. As três coisas que apareceram e são decisão do Richard:

1. **A unidade do botão** — prometer PCs e listar TRs. Corrigir é mudar o texto do botão, ou
   mudar o que a lista mostra. São escolhas diferentes.
2. **A divergência do `maxDias`** — a parcela entra no recorte por causa de uma PC baixada.
3. **O corte do acervo antigo** — se o alerta deve ter o mesmo `CORTE_PRAZO` do sino, ou se o
   passivo histórico deve continuar visível na Minha Planilha.
