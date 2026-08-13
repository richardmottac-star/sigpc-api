# RENUMERAÇÃO DO `parcial_num` — o que medi em 13/08/2026

## ⚠️ ANTES DE MAIS NADA: o caminho do `SESSAO.md` está ERRADO. Não rode.

O `SESSAO.md` diz *"renumerar por TR, na ordem de `parcela_seq`, agrupando por `processo_pc`
→ 1..N"*. Eu implementei, rodei e **medi contra gabarito**. Ele **reprovou**.

**Por quê:** existe um gabarito, e ninguém tinha usado. As **3.281 PCs baixadas** que já
tinham `parcial_num` **antes** do backfill de 05/08 receberam o número **da planilha do
analista** — que é o número do SIGEF. São **1.792 parcelas em 529 TRs** de número conferido.

Renumerar por `parcela_seq` **reescreveria 592 dessas 1.792 parcelas** (1.017 PCs, 67 TRs):

| | |
|---|---|
| parcelas com número do SIGEF | 1.792 |
| que o caminho do SESSAO.md **manteria** | 1.200 |
| que ele **REESCREVERIA** | **592** — em 67 TRs |
| TRs que ele quebraria | 67 de 529 |

E quebra justamente a TR que a analista conferiu: **na 2020TR000704, 44 dos 48 rótulos
conferidos mudariam.**

**A causa:** `parcela_seq` **não** é a ordem do SIGEF. Na 704, a parcial 2 é a `SCC2930/2021`
(`parcela_seq` = 10) e a parcial 3 é a `SCC2931/2021` (`parcela_seq` = 2). O SIGEF ordena
por outra coisa. Ordenar por `parcela_seq` embaralha tudo que já estava certo.

---

## O CAMINHO CERTO — preservar o que veio da planilha e só preencher a lacuna

O `parcial_num` nunca esteve "todo errado". **A numeração da planilha está certa.** O que o
backfill de 05/08 fez de errado foi dar `20, 21, 22…` às parcelas **sem PC baixada**, em vez
do número real — que é justamente **o número que falta** na sequência da TR.

A regra, então:

1. **O rótulo que veio da planilha FICA.** É o número do SIGEF.
2. Para cada TR, `N` = número de parcelas = `COUNT(DISTINCT processo_pc)` entre as não-finais.
3. Os números **livres** de `1..N` (os que nenhuma planilha usou) vão para as parcelas **sem
   rótulo**, na ordem de `parcela_seq`.
4. O grupo `processo_pc = '-1'` vai **por último** na fila. É dado duvidoso (79 PCs); não
   pode empurrar parcela legítima para o número errado.
5. **TR que não fecha `1..N` limpo é deixada INTOCADA.** São 9, e nenhuma é problema de
   numeração — ver adiante.

### 1. As duas TRs conferidas

#### `2020TR000704` — **1..57 contíguo. Bate com o SIGEF. ✓**

E os **48 rótulos da planilha ficam exatamente onde estavam**. Só os 9 sem rótulo mudam:

| novo | `parcela_seq` | processo SGPe | era |
|---|---|---|---|
| **1** | 1 | SCC8216/2020 | 51 |
| **30** | 38 | SCC14533/2022 | 52 |
| **51** | 71 | SCC 18792/2023 | 53 |
| **52** | 76 | SCC 00001847/2024 | 54 |
| **53** | 77 | SCC 00002009/2024 | 55 |
| **54** | 78 | SCC 00004358/2024 | 56 |
| **55** | 80 | SCC 00007992/2024 | 57 |
| **56** | 82 | SCC 00007997/2024 | 58 |
| **57** | 83 | SCC 00008016/2024 | 59 |

Repare como o resultado **se prova sozinho**:
- A `SCC8216/2020` é a de `parcela_seq = 1` — a primeira PC da TR. Vira a **parcial 1**,
  exatamente como o `SESSAO.md` previu.
- A `SCC14533/2022` cai no **30** — e a sua vizinha `SCC14522/2022` é a parcial **29**.
  14522 → 29, 14533 → 30. Encaixou.
- As de 2023 fecham monotônicas no SGPe: 18668→47, 18699→48, 18715→49, 18788→50,
  **18792→51**.
- As de 2024 idem: 1847→52, 2009→53, 4358→54, 7992→55, 7997→56, 8016→57.

Nenhum desses encaixes foi imposto — saíram do "preencher a lacuna".

#### `2020TR000637` — **1..20. O SIGEF tem 19.**

| novo | `parcela_seq` | processo SGPe | planilha | era |
|---|---|---|---|---|
| 1..5 | 1,3,4,5,6 | SCC9460, 9462, 9469, 9470, 9472 | 1,2,3,4,5 | igual |
| **6** | 7 | SCC9473/2021 | (sem) | 20 |
| **7** | 8 | SCC9476/2021 | (sem) | 21 |
| **8** | 15 | SCC9474/2021 | (sem) | 22 |
| 9 | 9 | SCC9477/2021 | 9 | igual |
| 10..15 | | SCC19835, 19836, 7131/23, 7745, 7747, 7748 | 10..15 | igual |
| **16** | 36 | SCC 00010835/2023 | (sem) | 24 |
| 17 | 37 | SCC 00011622/2023 | 17 | igual |
| **18** | 41 | SCC 00011142/2024 | (sem) | 25 |
| 19 | 39 | SCC 00011126/2024 | 19 | igual |
| **20** | 23 | **`-1`** | (sem) | 23 |

Os 5 buracos do SIGEF (6, 7, 8, 16, 18) são preenchidos, e **a 16 cai na
`SCC 00010835/2023`** — entre a 15 (`SCC 00007748/2023`) e a 17 (`SCC 00011622/2023`),
que é onde o número do SGPe manda. Foi a regra do `-1`-por-último que garantiu isso.

**A sobra é a PC de `processo_pc = '-1'`, que fica isolada no 20.** É o problema de DADO que
o `SESSAO.md` já registrou — nenhuma numeração resolve, só a conferência do analista contra
o SIGEF (`pcs_sgpe_-1.csv`).

### 2. Quanto muda

| | caminho do SESSAO.md | **caminho proposto** |
|---|---|---|
| PCs alteradas | 2.165 | **1.189** |
| TRs alteradas | 101 | **70** |
| **rótulos do SIGEF destruídos** | **592 parcelas / 1.017 PCs** | **0** |
| TRs que ficam `1..N` contíguo | 1.554 | **1.545** |
| baixadas com `parcial_num` alterado | 1.027 | 8 *(as 8 não têm rótulo de planilha)* |
| `enviado_ci` / ciclo do C.I. afetados | 0 | **0** |

### 3. Backup — FEITO

```
_backup_parcial_num_20260813   ·  14.652 linhas  ·  1.559 TRs
   id, codigo_pc, tr, processo_pc, parcela_seq, tipo, baixada, parcial_num
   PCs não copiadas: 0    divergentes do vivo: 0
```

O `codigo_pc` está junto **de propósito**: a reversão tem de ser por lista explícita de
chaves (regra 12), não por condição derivada.

Reverter:
```sql
UPDATE prestacoes_contas p SET parcial_num = b.parcial_num
  FROM _backup_parcial_num_20260813 b
 WHERE b.id = p.id AND p.codigo_pc = ANY($1);   -- $1 = a lista que o script imprime
```

O `_backup_parcial_num_20260805` continua lá, e agora tem função nova: **é o gabarito**.
É dele que sai o "rótulo veio da planilha". Não apagar.

### 4. O comando — **aguardando sua autorização**

```bash
cd C:\Users\Richard\sigpc-api
node renumerar_parcial_num.js            # DRY-RUN — já rodei, resultado abaixo
node renumerar_parcial_num.js --gravar   # ⬅ ESTE precisa da sua ordem
```

Dry-run que rodei agora (nada gravado, `ROLLBACK`):

```
PCs a renumerar: 1189 em 70 TRs
linhas atualizadas: 1189

── VALIDACAO ─────────────────────────────────────────
   OK     rotulo da planilha (SIGEF) alterado      0
   OK     baixada alterada                         0
   OK     PC final renumerada                      0
   OK     PC fora da lista alterada                0
   OK     parcela partida em 2 numeros             0
   OK     PC sem parcial_num                       0
   OK     TRs que NAO fecham 1..N (esperado: 9)    9

── AS DUAS TRs CONFERIDAS ────────────────────────────
   2020TR000637: 1..20 · 20 parciais · contiguo=true
   2020TR000704: 1..57 · 57 parciais · contiguo=true

>> DRY-RUN: ROLLBACK. Nada gravado.
```

**O que o `UPDATE` toca:** `parcial_num` e `atualizado_em`. **Só.**
Não menciona `baixada`, `data_baixa`, `enviado_ci`, `parecer_tipo`, `parecer_ci`, `valor`,
`status`, `analista_id` nem nenhuma coluna `ci_*` — e as travas conferem isso depois de
escrever, dentro da transação, com `ROLLBACK` se alguma falhar.

---

## As 9 TRs que ficam de fora — nenhuma é problema de numeração

O script **não toca** nelas. Renumerar sem o dado inventaria rótulo.

**7 têm rótulo de planilha ACIMA do total de parcelas** — o SIGEF tem parcela que a nossa
base **não tem**. É dado faltando:

| TR | parcelas na base | rótulos da planilha vão até | números órfãos |
|---|---|---|---|
| 2020TR000623 | 43 | 45 | 44, 45 |
| 2020TR000638 | 23 | 33 | 27 a 33 — **faltam 7 parcelas** |
| 2020TR000681 | 24 | 25 | 25 |
| 2020TR000718 | 16 | 17 | 17 |
| 2020TR000722 | 46 | 49 | 47, 48, 49 |
| 2020TR000809 | 4 | 12 | 12 |
| 2021TR002385 | 2 | 3 | 3 |

**2 têm o mesmo SGPe escrito de dois jeitos** — falta normalizar, não renumerar:

| TR | mesmo processo, duas grafias |
|---|---|
| 2022TR000791 | `SCC 4813/2024` (7 PCs) **e** `SCC 00004813/2024` (2 PCs) — ambas rotuladas 6 |
| 2022TR000967 | `SCC15029/2022` (2 PCs) **e** `SCC 00015029/2022` (1 PC) — ambas rotuladas 1 |

Nessas duas, o `COUNT(DISTINCT processo_pc)` conta **uma parcela a mais** do que existe.
É a explicação das "2 TRs em que a contagem não bate" registradas no `SESSAO.md` —
não eram erro de contagem, eram **grafia**. Normalizar o `processo_pc` resolve as duas e
elas passam a fechar `1..N` sozinhas.

---

## COMO SABER QUANDO PODE GRAVAR

```bash
node janela_livre.js            # uma foto agora
node janela_livre.js --vigiar   # reconsulta a cada 2 min até dar LIVRE
```

Três sinais, e os três têm de estar limpos — **online**, **PC escrita nos últimos 30 min** e
**evento de parcela nos últimos 30 min**. Quando der `>> LIVRE`, pode gravar.

**E o script se recusa sozinho.** `--gravar` com gente na tela sai com `RECUSADO` **antes do
`BEGIN`** — testado com 10 pessoas online: recusou, exit 3, e a conferência depois mostrou
banco intacto (0 PCs diferentes do backup, 704 ainda indo até 59, histórico ainda em 6 e 19).
Existe `--forcar`, mas ele é para quando você decidir, não para contornar.

### ⚠️ Um defeito meu, corrigido — o fuso

As colunas de data são **`timestamp without time zone` guardando UTC**:
`usuarios.ultimo_acesso`, `usuarios.sessao_fim`, `prestacoes_contas.atualizado_em`,
`parcela_historico.criado_em`, `ci_mensagem.criado_em`.

Escrevi `col AT TIME ZONE 'America/Sao_Paulo'`, copiando a forma do `lib/datas.js`. **Está
errado para estas colunas.** Aquele arquivo converte `NOW()`, que é `timestamptz` — ali um
passo basta. Para um `timestamp` *naive*, `AT TIME ZONE 'zona'` faz o contrário: **interpreta**
o valor como sendo daquela zona. O resultado somava 3 h em vez de subtrair — 21:31 aparecia
como 03:31, e eu cheguei a dizer que a equipe trabalhava de madrugada. **Trabalha às 21h.**

O certo, para coluna naive em UTC, são dois passos:

```sql
(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'
--     ^ isto é UTC          ^ mostre em Brasília
```

Conferido contra o relógio: `to_char` devolve 21:30 quando o relógio marca 21:30.

**Isto não afeta a renumeração** — nenhuma decisão do plano usa data. Afetou só o que a tela
mostra, e a trava de janela, que compara `NOW() - INTERVAL '30 minutes'` direto no banco e
sempre esteve certa: os dois lados eram UTC.

## Efeito colateral que você precisa saber: `parcela_historico`

A tabela guarda `(tr, parcial_num)` em texto, não `codigo_pc`. **São 9 as linhas que
desalinham, não 1** — o número 1 que passei antes saiu do cálculo do caminho B; recalculei
sobre o plano final. **Autorizado por você: o script corrige as nove no mesmo `UPDATE`.**

Horários em **Brasília** — a primeira versão desta tabela saiu em UTC e mostrava 3 h a mais
(ver "Um defeito meu", no fim).

```
id | TR           | hoje | depois | evento   | quando      | quem     | PC
26 | 2022TR000929 |    6 |      3 | parecer  | 12/08 18:41 | Perla    | 2022PC003872
31 | 2020TR000831 |    5 |      1 | parecer  | 12/08 18:50 | Gabriele | 2020PC000829
33 | 2020TR000705 |   25 |      6 | parecer  | 12/08 20:32 | Valderi  | 2020PC003419 2020PC001540
38 | 2020TR000766 |   25 |     11 | situacao | 12/08 20:59 | Valderi  | 2023PC002911
39 | 2020TR000766 |   24 |      7 | situacao | 12/08 20:59 | Valderi  | 2023PC002291
41 | 2020TR000624 |   19 |      1 | situacao | 12/08 21:01 | Marisa   | 2020PC000228
42 | 2020TR000624 |   20 |     19 | situacao | 12/08 21:01 | Marisa   | 2022PC001330
44 | 2020TR000624 |   21 |     20 | situacao | 12/08 21:02 | Marisa   | 2022PC002411
45 | 2020TR000624 |   22 |     21 | situacao | 12/08 21:02 | Marisa   | 2022PC002456
```

Como o script faz, e por que nessa ordem:

1. **Lê o mapa ANTES de renumerar as PCs.** Depois do `UPDATE`, `h.parcial_num` não casa
   mais com nada — o mapa teria de ser adivinhado. Ele é capturado primeiro, como lista de
   `id`, e é por `id = ANY(...)` que o `UPDATE` roda (regra 12).
2. **Só entra linha cujo `(tr, parcial_num)` resolve para UM único número novo.** Nas TRs de
   SGPe ambíguo daria dois; ali a linha fica como está.
3. **Backup próprio**: `_backup_parcela_historico_20260813`, criado dentro da transação — no
   dry-run o `ROLLBACK` o descarta junto.
4. Três travas novas conferem, depois de escrever: nenhuma linha apontando para parcela
   inexistente, nenhuma linha fora do mapa tocada, e **nenhum campo além de `parcial_num`
   alterado** — `evento`, `valor_anterior`, `valor_novo`, `analista_id` e `criado_em` são
   comparados um a um contra o backup.

⚠️ A id 41 mostra o tamanho do salto: **parcela 19 → 1**. A `2020PC000228` é a primeira PC da
TR e estava rotulada 19 — o mesmo caso da 704.

---

## O que muda para o analista

Depois de gravar, o `parcial_num` volta a ser o número do SIGEF em **1.545 das 1.554 TRs** —
e aí a armadilha 14 do `CLAUDE.md` (*"não use `parcial_num` para conversar com o analista"*)
pode ser reescrita. Nas 9 restantes a referência continua sendo o processo SGPe.

**Não vou alterar `CLAUDE.md` nem `SESSAO.md` antes de você autorizar a gravação** — hoje o
que está escrito lá ainda é verdade.
