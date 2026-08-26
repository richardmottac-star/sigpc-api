# A unidade do parecer no C.I. — PC ou parcela?

**26/08/2026 · SÓ LEITURA.** Nenhum `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE`.
Nada gravado, nada proposto. Só as cinco respostas.

> **PARCELA = `(setorial_id, tr, parcial_num)`** — a mesma chave de `carregarParcela` e dos
> cinco chamadores dela. É a chave que o sistema já usa em toda parte, menos no C.I.

> ## ⚠️ TRÊS COISAS ANTES DAS RESPOSTAS
>
> **1. O número que você citou não bate com o banco de agora.** A **2020TR000657** tem hoje
> **9 PCs em 5 parcelas** na fila (parcelas 1, 2, 3, 4 e 6), não 7 em 4. As parcelas **2, 3,
> 4 e 6** têm duas PCs cada; a **1** tem uma só. A leitura de fundo está certa — o C.I.
> decidiria 9 vezes o que a analista decidiu 5 —, mas o número mudou.
>
> **2. E o "7 PCs" está escrito no código, errado.** `lib/ci.js` e `teste_ci.js` dizem, em
> comentário, *"a parcela 1 da 2020TR000657 tem 7 PCs"*. Hoje ela tem **1**. A renumeração de
> 13/08 desmanchou aquele agrupamento e o comentário ficou. É o exemplo vivo do que o
> CLAUDE.md chama de ler o dado de saída de uma migração e chamar aquilo de regra.
>
> **3. A divergência que você teme ainda NÃO existe no banco — e o motivo é que ninguém
> decidiu ainda.** Zero parcelas têm dois estados de ciclo diferentes entre suas PCs. Só **5
> PCs** do acervo inteiro foram decididas pela tela (3 do Atemilson, 2 da Marcia, 21–24/08).
> A janela está **aberta**, não fechada: a primeira parcela com duas PCs a ser decidida por
> partes cria o caso.

---

## 1. A fila do C.I. hoje

| | |
|---|---|
| PCs `na_fila` | **1.392** |
| parcelas | **874** |
| TRs | 266 |
| **decisões a menos, se fosse por parcela** | **518 — 37%** |

### A distribuição

| PCs na parcela | parcelas | PCs |
|---|---|---|
| **1 PC** | 564 (64,5%) | 564 |
| **2 PCs** | 219 | 438 |
| **3 PCs** | 56 | 168 |
| 4 a 6 PCs | 22 | 102 |
| **7 ou mais** | 13 | 120 |
| **2 ou mais** | **310 (35,5%)** | **828 PCs** |

**828 das 1.392 PCs da fila vivem em parcela com irmã.** Em 564 parcelas a pergunta não
muda nada; em 310 ela muda tudo.

### As maiores

| TR | parcela | PCs | analista |
|---|---|---|---|
| 2020TR000806 | 1 | **12** | Gabriele |
| 2020TR000636 | 3 | 11 | Rita |
| 2020TR000761 | 1 | 11 | Noici |
| 2022TR000967 | 19 | 11 | Perla |
| 2020TR000810 | 1 e 4 | 10 cada | Gislainy |
| 2023TR000110 | 1 | 9 | Tanimeri |

⚠️ **Nenhuma PC da fila tem `parcial_num` degenerado** (`-`, vazio ou nulo): zero em 1.392.
O agrupamento por parcela não colapsaria nada indevidamente — que era o risco de agrupar por
uma coluna que está `-` em um terço do acervo.

### A 2020TR000657, medida agora

| parcela | PCs no ciclo | situação | PCs |
|---|---|---|---|
| 1 | 1 | `na_fila` | 2020PC000448 |
| 2 | 2 | `na_fila` (as duas) | 2020PC000520 · 2020PC002138 |
| 3 | 2 | `na_fila` (as duas) | 2020PC000846 · 2020PC003202 |
| 4 | 2 | `na_fila` (as duas) | 2020PC001351 · 2020PC003203 |
| 6 | 2 | `na_fila` (as duas) | 2020PC001823 · 2020PC003245 |

---

## 2. `ci.decidir` grava por PC. Sem meio-termo.

**A unidade real do UPDATE é `codigo_pc`**, nos dois ramos:

```sql
-- o alvo
SELECT ... FROM prestacoes_contas
 WHERE codigo_pc = ANY($1) AND ci_situacao = 'na_fila' FOR UPDATE

-- de_acordo
UPDATE prestacoes_contas SET ci_situacao='encerrado', ... WHERE codigo_pc = ANY($1)
-- ressalva
UPDATE prestacoes_contas SET ci_situacao='com_analista', ci_rodada=..., WHERE codigo_pc = ANY($1)
```

**E a tela manda UMA PC por vez.** `ciConfirmar(codigo_pc)`, em `index.html:13929`:

```js
body: JSON.stringify({ codigos_pc:[codigo_pc], decisao:d.id, texto:obs, autor_id:U.id })
```

A lista do C.I. é **por PC** — `_ciDados.find(x => x.codigo_pc === codigo_pc)`, e o modal
mostra *"{codigo_pc} · {tr} · parcela {parcial_num}"*. A rota **aceita** uma lista, mas nada
no sistema hoje manda mais de um código.

### O que acontece com as irmãs quando o técnico decide uma

**Nada. Elas ficam exatamente onde estavam.** Item por item:

| | a PC decidida | a irmã da mesma parcela |
|---|---|---|
| `ci_situacao` | `encerrado` ou `com_analista` | continua **`na_fila`** |
| `ci_rodada` | sobe na ressalva | **não sobe** |
| `ci_tecnico_id` / `_em` | carimbado | continua **NULO** |
| `ci_encerrado_em` / `_por` | carimbado no de acordo | continua nulo |
| `ci_mensagem` | ganha a mensagem | **não ganha** — a conversa é por PC |
| `parcela_historico` | ganha linha `ci_decidiu` | a linha cai na **mesma chave** `(tr, parcial_num)`, mas nomeia só a PC decidida |

⚠️ **Três consequências que não dão erro:**

1. **A parcela pode terminar com duas decisões diferentes** — uma PC `encerrado` e a irmã
   `com_analista`, com rodadas diferentes. Nada no banco impede.
2. **A notificação já mente hoje.** `agruparPorParcela` monta o aviso por parcela e escreve
   *"Parcela 3 — 1 PC"*. A parcela tem 2. A analista lê que uma PC voltou, e a outra continua
   parada na fila do C.I. sem que ninguém saiba.
3. **O `parcela_historico` fica com duas linhas `ci_decidiu` na mesma parcela**, possivelmente
   contraditórias, e é ele que alguém abre meses depois para entender por que a PC está como
   está.

---

## 3. O analista decide por PARCELA — e propaga. Mas há um segundo caminho.

### O caminho principal: `POST /parcela/parecer` — o cartão

Entra por **`{ tr, parcial_num }`**, não por `codigo_pc`:

```sql
UPDATE prestacoes_contas
   SET baixada=true, status='baixada', data_baixa=NOW(), parecer_tipo=$1, ...
 WHERE setorial_id=$4 AND tr=$5 AND parcial_num=$6
   AND baixada = false
RETURNING codigo_pc
```

O caminho completo:

1. `BEGIN`
2. `resolverAutoria` — dono e executor, contra o perfil lido no **banco**
3. `carregarParcela(cli, tr, parcial_num, setorial_id)` — trava a **parcela inteira**
   (`FOR UPDATE`)
4. 409 se **todas** já estiverem baixadas; 403 se a parcela for de outro analista sem `override`
5. o `UPDATE` acima — **uma escrita, todas as PCs abertas da parcela**
6. **uma** linha em `parcela_historico`, chaveada por `(tr, parcial_num)`
7. `COMMIT`

**Um parecer, uma transação, N PCs baixadas.** É exatamente o que o C.I. não faz.

⚠️ **O `AND baixada = false` é deliberado** (correção de 16/08): numa parcela **mista** o 409
não dispara — ele exige que *todas* estejam baixadas —, e sem esse filtro o parecer novo
reescrevia `data_baixa`, `origem_baixa` e `parecer_tipo` de PC já baixada.

### E `POST /parcela/ci` — o encaminhamento — também é por parcela

Mesma chave, mesmo `carregarParcela`, e `WHERE setorial_id=$2 AND tr=$3 AND parcial_num=$4
AND baixada = true`. O `ci_lote` idem, por `parcial_num = ANY($3)`.

### ⚠️ O segundo caminho, que NÃO é por parcela

`POST /prestacoes_contas/registrar_parecer` — o botão "Registrar parecer" do **detalhe da
TR**. Ele **trava** a parcela (`carregarParcela`) mas **escreve por `codigo_pc`**:

```js
if (b.baixar_nl_completa === true && pc.codigo_nl) { where = `codigo_nl = $3` }
else                                               { where = `codigo_pc = $3` }
```

Então o alcance dele é **uma PC**, ou **uma NL** — e a NL não é a parcela: uma NL pode ser
quitada por até 19 PCs, de parcelas diferentes. **O analista tem hoje um caminho por parcela
e um caminho por PC.** Comparar o C.I. com "o analista" esconde isso: o cartão é por parcela,
o detalhe da TR não é.

---

## 4. Divergência hoje no banco: **zero de decisão, 14 de composição**

### `ci_situacao` divergente dentro da parcela

| valores distintos na parcela | parcelas | PCs |
|---|---|---|
| 1 (todas iguais) | 6.502 | 14.608 |
| **2** | **14** | **50** |

**Mas nenhuma das 14 é uma decisão dividida.** Em todas as 14, os dois valores são
*um estado do ciclo* × **`NULA`** — parte da parcela entrou no ciclo, parte nunca entrou.
**Não há uma única parcela com `na_fila` × `encerrado`, nem `encerrado` × `com_analista`.**

| TR | parcela | PCs | o que há |
|---|---|---|---|
| 2020TR000761 | 17 | 6 | 2 `na_fila` · 4 NULA |
| 2022TR000804 | 6 | 6 | 2 `encerrado` · 4 NULA |
| 2022TR001706 | 4 | 6 | 4 `na_fila` · 2 NULA |
| 2021TR000618 | 1 | 5 | 4 `encerrado` · 1 NULA |
| 2022TR000792 | 12 | 4 | 3 `encerrado` · 1 NULA |
| 2022TR001248 | 7 | 4 | 2 `na_fila` · 2 NULA |
| 2020TR000637 | 10 | 3 | 2 `encerrado` · 1 NULA |
| 2022TR000861 | 5 | 3 | 2 `na_fila` · 1 NULA |
| 2022TR000861 | 7 | 3 | 2 `na_fila` · 1 NULA |
| 2020TR000700 | 3 | 2 | 1 `encerrado` · 1 NULA |
| 2020TR000766 | 9 | 2 | 1 `encerrado` · 1 NULA |
| 2021TR001689 | 1 | 2 | **PFINAL `na_fila` · a parcial 1 NULA** |
| 2021TR002375 | 1 | 2 | 1 `encerrado` · 1 NULA |
| 2022TR000220 | 1 | 2 | 1 `encerrado` · 1 NULA |

⚠️ **A 2021TR001689 é uma das 3 PCs FINAIS com `parcial_num = '1'`** que já estão em
Pendências. Ali a "divergência" é artefato da grafia: a FINAL e a parcial 1 não são a mesma
parcela, e só parecem ser porque dividem o rótulo.

### As outras divergências, medidas

| o que diverge dentro da parcela | parcelas | PCs |
|---|---|---|
| `parecer_tipo` (acervo inteiro) | **13** | 43 |
| `parecer_tipo` **entre PCs no ciclo do C.I.** | **0** | — (1.875 parcelas · 3.131 PCs, todas uniformes) |
| `baixada` — a parcela **mista** | **12** | 40 |
| `enviado_ci` | **14** | 50 |
| PCs `encerrado` com irmã **não** `encerrado` | — | **15** |

**Resposta curta: nenhuma parcela tem hoje dois pareceres do C.I. diferentes, nem dois
estados de ciclo diferentes.** As 13 divergências de `parecer_tipo` são PC com parecer contra
irmã **sem** parecer — e **nenhuma delas está dentro do ciclo do C.I.**

⚠️ **E a razão de estar limpo não é a trava: é o desuso.** O C.I. decidiu **5 PCs** pela tela
desde que ela existe. As 1.737 `encerrado` vieram todas da carga de 16/08, que carimbou o
mesmo valor em bloco. Ninguém decidiu por partes ainda **porque quase ninguém decidiu**.

---

## 5. O que precisaria mudar — e as 23

### O `ci.decidir` **não** é o único ponto

| ponto | está por | precisaria mudar? |
|---|---|---|
| `POST /parcela/parecer` (o parecer do analista) | **parcela** | não |
| `POST /parcela/ci` (encaminhamento) | **parcela** | não |
| `POST /parcela/ci_lote` | **parcela** (`parcial_num = ANY`) | não |
| `ci.decidir` — alvo, UPDATE e histórico | **PC** | **sim** |
| `ci.gravarMensagem` | **PC** | **decisão sua** — ver abaixo |
| `GET /ci/fila` / `ci-fila.sqlLista` | **PC** (uma linha por PC) | **sim**, se a tela for listar parcela |
| `index.html` `ciConfirmar` | **1 PC por clique** | **sim** |
| `POST /prestacoes_contas/registrar_parecer` | **PC ou NL** | fora do C.I., mas é o furo do lado do analista |
| `POST /ci/reabrir` (o novo) | **PC** | segue a mesma decisão |

### O encaminhamento **não** está mandando PC solta

`POST /parcela/ci` escreve por `(setorial_id, tr, parcial_num)`. Medido:

- **6 parcelas** no acervo inteiro estão **parcialmente** na fila — 13 PCs dentro, 11 irmãs
  fora.
- **14 parcelas** têm parte no ciclo em qualquer estado — 28 dentro, 22 fora.
- Das 22 irmãs de fora, **10 são `baixada = false`**.

E a causa de cada uma é conhecida:

| causa | quantas | por quê |
|---|---|---|
| **parcela mista** — o `AND baixada = true` deixa a não-baixada fora | 10 das 22 | é a trava de 16/08, e está certa: `enviado_ci` sustenta a baixa, e marcar PC nunca analisada a faria contar como baixada em relatório |
| **a carga de 16/08** (`executar_16_08.js`) — marcou por **lista de `codigo_pc` de CSV**, sem olhar parcela | as demais | é o único caminho do sistema que pôs PC no ciclo sem respeitar a parcela, e é de onde vêm as **15 encerradas com irmã não-encerrada** |
| **PFINAL com `parcial_num='1'`** | 1 (2021TR001689) | grafia, não composição |

> **Ou seja:** a fila está por parcela porque o encaminhamento sempre foi por parcela. O que
> quebra a unidade é **a decisão** (por PC) e **a carga histórica** (por CSV) — não o
> encaminhamento.

### As 23 da reabertura: **11 parcelas inteiras, zero PC de fora**

| TR | parcela | no alvo | na parcela | de fora |
|---|---|---|---|---|
| 2020TR000633 | 1 | 9 | 9 | — |
| 2020TR000633 | 8 | 2 | 2 | — |
| 2020TR000640 | 15 | 1 | 1 | — |
| 2020TR000640 | 16 | 2 | 2 | — |
| 2020TR000680 | 6 | 2 | 2 | — |
| 2020TR000719 | 6 | 1 | 1 | — |
| 2020TR000719 | 8 | 1 | 1 | — |
| 2020TR000762 | 1 | 2 | 2 | — |
| 2021TR001849 | 1 | 1 | 1 | — |
| 2021TR001849 | **FINAL** | 1 | 1 | — |
| 2021TR002189 | 1 | 1 | 1 | — |
| | | **23** | **23** | **0** |

**Não há uma única parcela com PC de fora do alvo.** Reabrir por `codigo_pc` ou por parcela
produziria **exatamente as mesmas 23 linhas**.

⚠️ **A 2021TR001849 aparece duas vezes, e são duas parcelas de verdade:** a parcial `1` e a
`FINAL` (`parcela_seq 999`, sufixo `-PFINAL`). Elas andam separadas, como `alvoDaAcao` já
manda — a FINAL é unidade de produtividade própria.

> **Conclusão para a sua decisão:** a unidade do parecer **não bloqueia a reabertura**. As 23
> fecham parcela em todos os 11 casos. Se o C.I. passar a decidir por parcela, o script grava
> o mesmo conjunto — muda a forma de escrever, não o que é escrito.

### Os dois pontos que ficam como decisão sua, e não medi porque são regra

1. **A conversa (`ci_mensagem`) continua por PC?** O CLAUDE.md registra que *"a conversa é por
   PC, decisão do Richard"*, enquanto o encaminhamento é por parcela — e `gravarMensagem` já
   grava a mesma frase N vezes, uma por PC. Se a decisão virar por parcela, a conversa pode
   seguir por PC (fiel, redundante) ou virar por parcela (uma linha, e a tela deixa de mostrar
   sete cópias). São dois desenhos, e nenhum é errado.
2. **O que fazer com as 6 parcelas parcialmente na fila** quando a decisão for por parcela:
   decidir só as que estão `na_fila` (e a parcela segue partida), ou recusar a decisão até a
   parcela estar inteira. A segunda trava 13 PCs por causa de 11 irmãs, das quais 10 nunca
   foram analisadas.
