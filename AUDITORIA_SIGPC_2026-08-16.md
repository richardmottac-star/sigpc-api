# Auditoria — planilhas dos grupos × estoque oficial da CGE × relatos dos analistas

**16/08/2026** · SIGPC-GT
**Fontes cruzadas:** 3 planilhas de grupo (5.072 linhas, 738 TRs, 46 analistas) · estoque oficial da CGE (13.626 parciais + 1.026 finais = **14.652 PCs**, que bate exatamente com o sistema) · relatório de 15 analistas

> ⚠️ **Limite desta auditoria.** Foi cruzada a planilha contra o **estoque oficial da CGE**, que é a base migrada para o sistema. Não houve acesso ao Postgres. Correções já aplicadas ao banco (a renumeração de 13/08, que tocou 1.189 PCs em 70 TRs) **não estão refletidas aqui**. Toda conclusão precisa ser confirmada contra o banco antes de qualquer correção.
>
> **Nada foi executado. Nada foi alterado.**

---

## 1. A causa raiz — identificada e provada

### O sistema numerou as parciais pelo critério errado

O estoque da CGE traz **duas** numerações por PC:

| Coluna | O que é |
|---|---|
| `Parcial` | O número da parcial **no SIGEF** — é o que o analista vê, usa e escreve no parecer |
| `PARCELA N°` | A sequência do pagamento/NL dentro da TR — número interno, sem significado para o analista |

**A migração numerou as parciais pela ordem de `PARCELA N°`.** A coluna `Parcial`, que carrega o número correto, estava disponível na mesma linha e não foi usada.

### A prova — 2020TR000644 (relato da Marisa)

Ordenando as parciais dessa TR por `PARCELA N°` e renumerando de 19 a 28, o resultado reproduz **exatamente**, 10 de 10, o embaralhamento que a analista descreveu:

| Sistema mostra | Processo exibido | Parcial verdadeira (SIGEF) | Valor exibido | Valor real dessa parcial no SIGEF |
|---|---|---|---|---|
| Parcial 19 | SCC 15599/2023 | **22** | R$ 96.443,85 | R$ 96.443,85 ✅ |
| Parcial 20 | SCC 6313/2024 | **24** | R$ 96.312,36 | R$ 96.312,36 ✅ |
| Parcial 21 | SCC 13092/2023 | **19** | R$ 97.545,04 | R$ 97.545,04 ✅ |
| Parcial 22 | SCC 13833/2023 | **20** | R$ 92.956,84 | R$ 92.956,84 ✅ |
| Parcial 23 | SCC 11176/2024 | **27** | R$ 177.828,36 | R$ 177.828,36 ✅ |
| Parcial 24 | SCC 15167/2023 | **21** | R$ 92.956,84 | R$ 92.956,84 ✅ |
| Parcial 25 | SCC 11263/2024 | **28** | R$ 376.473,68 | R$ 376.473,68 ✅ |
| Parcial 26 | SCC 3738/2024 | **23** | R$ 235.950,10 | R$ 235.950,10 ✅ |
| Parcial 27 | SCC 8483/2024 | **25** | R$ 56.766,56 | R$ 56.766,56 ✅ |
| Parcial 28 | SCC 8816/2024 | **26** | R$ 111.131,83 | R$ 111.131,83 ✅ |

Outros critérios testados na mesma TR — ordem alfabética do processo, ordem da NL, data de pagamento — acertam **1 ou 0 de 10**. Só `PARCELA N°` acerta tudo.

### ⚠️ O que isso muda

**Não há erro de valor. Não há erro de processo. Não há PC trocada de TR.**

O processo e o valor andam **juntos e corretos** — a PC está íntegra. O único campo errado é o **número da parcial** colado nela.

O que o analista lê como "o valor da parcial 19 está errado" é, na verdade, "o bloco que o sistema chamou de parcial 19 é a parcial 22, e o valor dela está certo".

**Consequência prática:** a correção é uma renumeração determinística, casando `NR. PC` → coluna `Parcial` do estoque da CGE. Não se toca em valor, em processo, em vínculo com a TR, nem em baixa.

---

## 2. Escopo medido

| Métrica | Valor |
|---|---|
| Parciais (TR × parcial) no estoque | 5.127 |
| Em que a ordem por `PARCELA N°` **não** reproduz o número do SIGEF | **1.621 (31,6%)** |
| TRs afetadas | **176** de 1.192 |
| Dessas, já atribuídas a um analista | **106** |

### As 20 TRs mais afetadas

| TR | Parciais fora de ordem | Grupo | Analista |
|---|---|---|---|
| 2020TR000704 | 46 | G1 | Sandra Rocha |
| 2020TR000697 | 45 | G1 | Aline |
| 2020TR000620 | 40 | — | sem analista |
| 2020TR000722 | 40 | G2 | Geisa |
| 2020TR000800 | 40 | G2 | Grace Oliveira |
| 2020TR000643 | 38 | G1 | Daiana |
| 2020TR000698 | 38 | G1 | Aline |
| 2020TR000632 | 37 | — | sem analista |
| 2020TR000699 | 37 | G1 | Sandra Rocha |
| 2020TR000656 | 36 | G1 | Marcelo |
| 2020TR000623 | 31 | G1 | Andressa |
| 2020TR000646 | 29 | G2 | Simone |
| 2020TR000692 | 27 | G1 | Ivonete |
| 2020TR000595 | 26 | G1 | Sandra Paul |
| 2020TR000617 | 25 | G1 | Aline |
| 2020TR000674 | 25 | G2 | Ana Leticia |
| 2020TR000738 | 25 | G2 | Noici |
| 2020TR000803 | 25 | G2 | Ana Leticia |
| 2022TR000691 | 24 | — | sem analista |
| 2020TR000831 | 24 | G1 | Gabriele |

> ⚠️ Note que **70 TRs afetadas ainda não têm analista**. Elas estão no estoque com a numeração errada e vão gerar o mesmo problema assim que forem assumidas. Corrigir antes evita o próximo lote de reclamações.

---

## 3. Validação contra cada relato

A hipótese explica os relatos de forma quase perfeita:

| Analista | TR | Parciais fora de ordem (medido) | O que o analista relatou |
|---|---|---|---|
| Marisa | 2020TR000644 | 21 | parciais 19 a 28 embaralhadas ✅ |
| Marisa | 2020TR000655 | 5 | 5 parciais com valor errado ✅ **exato** |
| Marisa | 2020TR000624 | 11 | 5 relatadas (parciais 24–28) — há mais |
| Marisa | 2020TR000790 | 20 | 8 relatadas — há mais |
| Gabriele | 2020TR000792 | 14 | 14 parciais ✅ **exato** |
| Gabriele | 2020TR000739 | 14 | 12 relatadas |
| Gabriele | 2020TR000791 | 13 | 9 relatadas |
| Gabriele | 2020TR000831 | 24 | 28 relatadas |
| Everaldo | 2022TR000372 | 10 | 11 marcadas "arrumar" ✅ |
| Valderi | 2020TR000766 | 12 | PCs 07, 11, 24, 25 trocadas ✅ |
| Sandra Rocha | 2020TR000750 | 7 | parcial 2 com processo da 3 ✅ |
| Isabel | 2020TR000681 | 14 | falta a PC 01 — ver §4 |
| Noici | 2020TR000793 | 5 | PC 01 não consta — ver §4 |
| Gabriele | 2020TR000654 | **0** | 17 vs 22 parciais — **outro problema**, ver §4 |
| Noici | 2020TR000761 | **0** | PC 18 não existe — **outro problema**, ver §5 |

**Os analistas relataram menos do que existe.** Em várias TRs o número medido é maior que o reportado — eles pararam de conferir. Corrigir só o que foi relatado deixaria o resto errado.

---

## 4. Segundo problema — PCs que não existem na base

Comparando a contagem de parciais por TR:

| Situação | TRs |
|---|---|
| Planilha tem **mais** parciais que o estoque | **132** |
| Planilha tem menos (analista não registrou tudo) | 512 |
| Iguais | 94 |

**Total de parciais que a planilha tem e o estoque oficial não: 204.**

Essas PCs **nunca existiram na base da CGE** — não é erro de migração, é lacuna da fonte. O sistema não tinha como criá-las.

### Casos extremos

| TR | Grupo | Analista | Planilha | Estoque | Faltam |
|---|---|---|---|---|---|
| 2020TR000612 | G1 | Franciani | 60 | 30 | **30** |
| 2019TR000319 | G2 | Geisa | 10 | 0 | **10** |
| 2022TR000306 | G2 | Simone | 10 | 2 | 8 |
| 2020TR001710 | G2 | Miriam | 8 | 0 | **8** |
| 2021TR001601 | G1 | Valderi | 4 | 1 | 3 |
| 2020TR000051 | G2 | Noici | 3 | 0 | 3 |
| 2020TR000804 | G2 | Ana Claudia | 8 | 5 | 3 |
| 2020TR000684 | G2 | Geisa | 9 | 6 | 3 |
| 2021TR002233 | G2 | Ana Claudia | 4 | 1 | 3 |
| 2020TR000725 | G2 | Ana Claudia | 30 | 27 | 3 |

### 7 TRs da planilha que não existem em lugar nenhum do estoque

`2019TR000319` · `2020TR000051` · `2020TR001710` · `2021TR000719` · `2021TR000804` · `2024TR000129` · `2024TR000204`

### Os casos de "TR sumiu" dos relatos

Rafael, Juliana, Janaina e Gislainy relataram TRs com parciais que não aparecem. O estoque confirma: essas TRs têm **1 única PC parcial** na base, enquanto a planilha registra 2 a 4.

| TR | Analista | PCs no estoque | Parciais na planilha |
|---|---|---|---|
| 2024TR000552 | Rafael | 1 | 2 |
| 2022TR000028 | Rafael | 1 | 3 |
| 2021TR001189 | Rafael | 1 | 3 |
| 2022TR000720 | Rafael | 1 | 4 |
| 2023TR000039 | Juliana | 1 | 2 |
| 2022TR002066 | Juliana | 1 | 2 |
| 2021TR002199 | Janaina | 1 | 4 |
| 2021TR001745 | Gislainy | 1 | 2 |

**Não é bug de exibição — o dado não está na base.** Essas PCs precisam ser incluídas manualmente, com validação contra o SIGEF.

### O caso 2020TR000654 (Gabriele)

O estoque tem **22 parciais** e nenhuma fora de ordem. A analista diz que o sistema mostra 17. Como a base está correta, **a perda aconteceu na migração ou na exibição** — este caso precisa ser conferido diretamente no Postgres.

---

## 5. O caso da Noici — 2020TR000761

O estoque tem **17 parciais** e **zero fora de ordem**. A analista relata:

- PC 18 não existe (correto — a base tem 17)
- Trabalho registrado até 30/07/2026 que, ao voltar, não estava lá
- Aprovações de despesa com complementação documental recebida e baixada, sem registro

**Este é o único relato que não se explica por erro de dado.** A numeração está certa nessa TR. Se o trabalho sumiu, é gravação — natureza inteiramente diferente dos demais.

**Apurar primeiro, separado, lendo `parcela_historico` entre 25/07 e 05/08.**

---

## 6. Terceiro achado — a planilha não é fonte confiável de valor

Comparando valor apenas onde processo **e** número da parcial coincidem nas duas fontes:

| | |
|---|---|
| Linhas comparadas | 2.052 |
| Valor idêntico | **1.619 (78,9%)** |
| Valor diferente | 433 |

Dos 433, boa parte é erro **da planilha**, não do sistema:

- **11 casos de vírgula digitada errado** — ex.: 2020TR000612 parcial 28, planilha R$ 55.534.939,00 contra R$ 555.349,39 no SIGEF. Fator exato de 100.
- **8 TRs com o mesmo valor em todas as parciais** — o analista copiou o *valor do repasse* na coluna do *valor da parcial*.
- 19 casos com diferença abaixo de R$ 1,00 — arredondamento.

**Consequência:** quando planilha e SIGEF divergirem em valor, **o SIGEF é a fonte**. A planilha serve para conferir numeração e situação, não valor.

---

## 7. Quarto item — a cobrança do Controle Interno

Relatado por Marisa, Noici e Gislainy, e não é erro de dado: o sistema só conhece encaminhamento feito **pela tela**, e os históricos foram feitos por fora. A faixa "falta encaminhar ao Controle Interno" está tecnicamente certa e **factualmente errada** em ~2.181 parciais.

Precisa de decisão sua sobre como marcar em bloco o que já foi ao CI — não é auditoria de dado, é regra.

---

## 8. Resumo — quatro problemas distintos

| # | Problema | Escopo | Natureza | Correção |
|---|---|---|---|---|
| **1** | Numeração da parcial pelo critério errado | 1.621 parciais · 176 TRs | Determinístico | Renumerar por `NR. PC` → `Parcial` do estoque CGE |
| **2** | PCs que não existem na base | 204 parciais · 132 TRs (7 TRs inteiras) | Lacuna da fonte | Inclusão manual com validação no SIGEF |
| **3** | Cobrança indevida do CI | ~2.181 parciais | Regra, não dado | Decisão sua |
| **4** | Possível perda de gravação | 1 TR (2020TR000761) | Grave, isolado | Ler `parcela_historico` |

E, fora do sistema: **erros de digitação nas planilhas dos grupos** (11 vírgulas, 8 TRs com repasse no lugar do valor da parcial).

---

## 9. O que o Claude Code precisa validar no Postgres — antes de qualquer correção

Só leitura. Nesta ordem:

1. **Confirmar a causa raiz no banco.** Para a 2020TR000644: `SELECT codigo_pc, parcial_num, processo_pc, valor FROM prestacoes_contas WHERE tr='2020TR000644' ORDER BY parcial_num`. O `parcial_num` da parcial 19 deve estar em SCC 15599/2023. Se estiver, confirmado.

2. **Medir quantas das 176 TRs a renumeração de 13/08 já corrigiu.** Ela tocou 70 TRs. Saber a interseção define o trabalho restante.

3. **Conferir se `parcela_seq` no banco corresponde ao `PARCELA N°` do estoque** — é a ligação que fecha a prova.

4. **2020TR000654** — contar parciais no banco. Estoque tem 22, analista vê 17. Onde foram as 5.

5. **2020TR000761** — `parcela_historico` entre 25/07 e 05/08: o que foi gravado, por quem, e se há buraco.

6. **As 8 TRs "sumidas"** — confirmar que têm 1 PC no banco, e verificar se estão atribuídas a analista ou no estoque.

7. **A 2022TR000720 do Rafael** — está no nome de outro analista. Ver `analista_id` e o histórico de quem assumiu.

---

## 10. Sobre usar o time de agentes nesta frente

**Sim, esta é a frente certa para o time** — e por um motivo específico: o trabalho aqui é medir em volume e conferir caso a caso, que é exatamente onde vários agentes rendem mais que um. As 176 TRs precisam ser verificadas uma a uma contra o banco antes de qualquer UPDATE.

**Com três condições:**

1. **O escopo vem deste documento, não do agente.** A causa raiz já está identificada. O time executa a verificação, não redescobre o problema.

2. **As três regras já gravadas valem integralmente** — nenhum agente escreve no banco, nenhum decide regra, nenhum publica. Aqui isso é crítico: um UPDATE errado em `parcial_num` reescreve a numeração de 5.127 parciais.

3. **A ordem de trabalho é sua.** Sugestão: (a) confirmar a causa raiz no banco, (b) medir o que a renumeração de 13/08 já cobriu, (c) gerar o script de correção **para você aprovar**, (d) só então executar, em lote pequeno e reversível.

**O que o time não deve fazer nesta frente:** decidir o que acontece com as 204 PCs ausentes, decidir como marcar o que já foi ao CI, e tocar na 2020TR000761 antes de você ler o histórico.

---

## 11. Pendências de informação

| Item | Quem | O que falta |
|---|---|---|
| Número da TR | Rita Inês Martini | O relato não identifica a TR |
| Número das TRs | Sandra Rocha | APAE Pinhalzinho e APAE Itá |
| Confirmar valor | Gabriele | 2020TR000806 parcial 13 — "413,368,38" com duas vírgulas |
| De qual TR | Marisa | "parciais 2 a 12" sem TR identificada |
| Relato | 31 analistas | Dos ~46, apenas 15 enviaram |

---

**Arquivos de apoio gerados:** `trs_renumerar.csv` (176 TRs com a contagem de parciais fora de ordem) · `contagem.csv` (comparação de contagem planilha × estoque para as 738 TRs)
