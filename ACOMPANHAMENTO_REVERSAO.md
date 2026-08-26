# Os tipos de evento, e o que já tem caminho de reversão

**27/08/2026.** Levantado com a tela Acompanhamento. **Nenhuma escrita no banco.**
Contagens medidas em `parcela_historico` (1.653 linhas) em 26/08/2026.

> ## A leitura de conjunto
>
> **De 14 tipos gravados, 4 têm caminho de reversão pronto, 3 têm caminho parcial e 7 não
> têm nenhum.** E os que não têm são, quase todos, os que menos precisam — assumir uma TR,
> corrigir um número de processo, responder ao C.I.
>
> ⚠️ **O que não tem reversão e DEVERIA ter é um só: `puxar_ci`.** Ele desfaz a baixa, tira
> a PC da produtividade e apaga o `parecer_tipo` — e não existe caminho para desfazer isso.
> Quem puxar por engano precisa refazer o parecer à mão e reencaminhar ao C.I.

---

## A tabela

| # | evento | rótulo na tela | n | reverte? | por onde |
|---|---|---|---|---|---|
| 1 | `ci` | Encaminhada ao C.I. | **898** | **✔ sim** | `POST /parcela/puxar_ci` — mas ⚠️ ver a nota 1 |
| 2 | `parecer` | Parecer da analista (baixa) | **266** | **✔ sim** | `POST /parcela/corrigir_situacao` (desfaz a baixa) · `PATCH /prestacoes_contas/estornar` (lote, só superadmin) |
| 3 | `situacao` | Situação alterada | **257** | **◐ parcial** | `POST /parcela/corrigir_situacao` põe outra situação — não restaura a anterior automaticamente |
| 4 | `processo_pc` | Processo SGPe da PC corrigido | **93** | **◐ parcial** | o lápis (`PATCH /prestacoes_contas/:codigo_pc/processo`) grava por cima; o valor antigo está em `valor_anterior` |
| 5 | `correcao_situacao` | Correção de situação | **32** | **◐ parcial** | idem — outra correção por cima |
| 6 | `processo_mae` | Processo SGPe da TR corrigido | **25** | **◐ parcial** | idem, pelo lápis com `--mae` |
| 7 | `ci_reabriu` | Reaberta no C.I. | **23** | **✔ sim** | a analista responde (`POST /ci/responder`) → volta para a fila do C.I. |
| 8 | `assumir_tr` | TR assumida | **21** | **✔ sim** | `POST /tr/devolver` (superadmin) ou o pedido do analista (`POST /solicitacao_devolucao`) |
| 9 | `resposta_diligencia` | Resposta da analista ao C.I. | **16** | **✘ não** | a resposta é um fato dito; não há desfazer |
| 10 | `migracao_ci` | Migração do C.I. (script) | **9** | **✘ não** | script antigo; a reversão seria por JSON, e não há |
| 11 | **`puxar_ci`** | **Puxada de volta do C.I.** | **6** | **✘ NÃO** | ⚠️ **nenhum** — ver a nota 2 |
| 12 | `devolucao_tr` | TR devolvida ao estoque | **3** | **✔ sim** | `POST /tr/assumir` — outro analista (ou o mesmo) assume de novo |
| 13 | `estorno` | Estorno da baixa | **3** | **✘ não** | refazer o parecer é o caminho, e não é reversão |
| 14 | `ci_abriu` | Aberta no C.I. (rota removida) | **1** | — | a rota que gravava isto **não existe mais** (removida em 25/08) |

**Ainda não apareceram no banco, mas as rotas os gravam a partir de agora:**
`ci_decidiu` (decisão do C.I. — reverte por `POST /ci/reabrir`), `correcao_negada`,
`solicitacao_correcao`, `pc_nova`.

---

## As quatro notas que mudam a leitura

**1. `puxar_ci` reverte o `ci`, mas cobra caro.** Ele não devolve a parcela ao estado anterior
ao encaminhamento: **derruba a baixa junto**, marca `estornada`, apaga o `parecer_tipo` e tira
a PC da produtividade. É reversão do encaminhamento *e* do parecer, num ato só. E desde 26/08
ele **recusa** parcela que o C.I. já tocou (`ciJaSeManifestou`) — então só serve enquanto a
parcela está `na_fila`.

**2. ⚠️ `puxar_ci` não tem reversão, e é o que mais mexe em produtividade.** Depois dele a
parcela volta a `analise`, sem baixa e sem parecer. Para voltar ao que era: refazer o parecer
(`POST /parcela/parecer`) e reencaminhar (`POST /parcela/ci`) — o que gera **nova `data_baixa`**
e move a produtividade de mês. **O passado não se recompõe.** Se o desfazer por tipo for
implementado, este é o primeiro da fila.

**3. `ci_decidiu` já tem reversão, e ela é nova.** `POST /ci/reabrir` (26/08) devolve a parcela
encerrada ao analista **sem tocar na baixa** — é o único caminho do C.I. que desfaz uma decisão
sem custo de produtividade. Foi por ele que as 23 PCs voltaram em 26/08.

**4. Os "parciais" não restauram — sobrescrevem.** Nos quatro casos marcados `◐`, o caminho
existente grava um valor NOVO por cima. O valor anterior está em `parcela_historico.valor_anterior`,
então a informação para restaurar **existe** — o que não existe é o botão que a lê. É
exatamente o desfazer que esta rodada deixou para depois.

---

## O que a trilha NÃO registra — e por isso a tela não mostra

| pedido | por que não dá |
|---|---|
| **erro devolvido pela rota** (403/409/500) | não existe tabela de log no SIGPC. As `AuditoriaSistema`, `LoginEvento` e `SincronizacaoCritica` no mesmo Postgres são do **SEGOV**, outro sistema |
| **puxada de volta RECUSADA** | a recusa acontece **antes** da escrita — `podePuxarCi` devolve 403 e nada é gravado |
| **quem apenas OLHOU** | abrir deixou de gravar em 25/08, de propósito: *"fechar sem decidir não deixa rastro"* |
| **o estado da parcela NA ÉPOCA** | `parcela_historico` guarda `(tr, parcial_num)`. Entidade, analista e contagem de PCs são lidos **agora** — servem para achar a parcela, não para reconstruir o passado |

Dos quatro alertas pedidos, **dois são computáveis** e estão implementados
(*reaberta mais de uma vez*, *decisão do C.I. revertida*); os outros dois — *puxada recusada* e
*erro da rota* — dependem de registro que não existe. No lugar deles a tela marca
**"desfez a baixa"** (`puxar_ci` e `estorno`), que é o evento que alguém vai querer conferir
primeiro.

---

## Dois defeitos que rodar contra o banco pegou

⚠️ **O alerta "reaberta mais de uma vez" contava LINHAS, não atos.** O
`reabrir_ci_encerradas.js` entra por lista de PCs e grava **uma linha por PC**: a
2020TR000762 p1 tem 2 PCs, logo 2 linhas `ci_reabriu` — e a parcela acendia o alerta numa
reabertura **única**. Cinco parcelas acusavam por engano. Corrigido para
`COUNT(DISTINCT criado_em)`, que separa atos porque `NOW()` é o instante da transação. Depois
da correção: **0 falsos positivos**.

⚠️ **`executado_por` é NULO nas 1.653 linhas.** Ninguém agiu pela conta de outro até hoje.
A tela já mostra "pela conta de …" quando os dois diferirem — o caminho existe e nunca foi
exercitado. Vale saber antes de confiar nessa coluna para auditoria.
