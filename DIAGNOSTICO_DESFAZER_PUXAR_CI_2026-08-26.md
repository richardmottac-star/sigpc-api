# DESFAZER O `puxar_ci` — o que o histórico guarda, e o que ele NÃO guarda

**26/08/2026 · só leitura · medido contra o banco de produção · nenhuma escrita.**

---

## ▶ RESPOSTA DIRETA: **NÃO DÁ PARA RESTAURAR AO ESTADO EXATO DE ANTES.**

Dos sete campos que você nomeou, **três** se recuperam do que está gravado hoje e
**quatro NÃO** — o `puxar_ci` os apaga e não os copia para lugar nenhum.

| campo | recupera? | de onde |
|---|---|---|
| `data_baixa` | ✅ **sim** | **nunca é tocada** — o `SQL_PUXAR_CI` não a menciona. Está lá, intacta. |
| `enviado_ci` | ✅ **sim** | `= true`, implícito no `WHERE enviado_ci = true` da própria escrita |
| `ci_situacao` | ✅ **sim** | `parcela_historico.valor_anterior` (nas 6 puxadas reais: `'na_fila'`) |
| `dt_envio_ci` | ❌ **NÃO** | vira `NULL`; **o valor nunca foi gravado em lugar nenhum** |
| `parecer_tipo` | ❌ **NÃO** | vira `NULL`; nunca gravado na linha da puxada |
| `estornada` | ❌ **NÃO** | vira `true`; **o valor anterior nunca foi gravado** |
| `baixada` | ❌ **NÃO** | vira `false`; **o valor anterior nunca foi gravado** — e o `WHERE` **não exige** que fosse `true` |

**Não inventei valor para nenhum dos quatro. Eles não existem no banco.**

---

## 1. O que o `parcela_historico` guarda de uma puxada — as nove colunas, todas

A tabela inteira (medida): `id · tr · parcial_num · setorial_id · evento · valor_anterior ·
valor_novo · analista_id · observacao · criado_em · executado_por`.

**Não há coluna de estado.** Nenhum `jsonb`, nenhum "antes/depois" além de dois campos `text`.

O que a rota `POST /parcela/puxar_ci` escreve nessas colunas (`server.js:4818-4830`):

```
evento         = 'puxar_ci'
valor_anterior = pc.ci_situacao  ||  'enviado_ci = true'   <- a UNICA coluna de estado
valor_novo     = 'fora do C.I.'                            <- literal fixo
analista_id    = o DONO
observacao     = <motivo> + ' · DESFEZ A BAIXA — sai da produtividade · N PC'
executado_por  = quem clicou, ou NULO se foi o dono
criado_em      = now()
```

**As 6 puxadas que já aconteceram em produção** (20/08 a 24/08) — é literalmente isto:

| id | TR / parcial | valor_anterior | valor_novo | motivo |
|---|---|---|---|---|
| 1377 | 2023TR000805 / 1 | `na_fila` | `fora do C.I.` | "É necessário puxar o processo … para encaminhar a diligência para APAE." |
| 1428 | 2020TR000666 / 3 | `na_fila` | `fora do C.I.` | "Erro de transferencia" |
| 1429 | 2020TR000666 / 4 | `na_fila` | `fora do C.I.` | "Erro deTransferência" |
| 1430 | 2020TR000666 / 5 | `na_fila` | `fora do C.I.` | "Erro deTransferência" |
| 1431 | 2020TR000666 / 6 | `na_fila` | `fora do C.I.` | "Erro deTransferência" |
| 1578 | 2020TR000691 / 4 | `na_fila` | `fora do C.I.` | "está em reanálise" |

Uma string de estado por puxada. É tudo.

---

## 2. Coluna a coluna: o que a puxada escreve, e o que sobra para desfazer

`SQL_PUXAR_CI` (`lib/correcao.js`) mexe em **19 colunas**. O que se recupera:

### ✅ Recuperável com valor GRAVADO (5)

| coluna | volta para | prova |
|---|---|---|
| `enviado_ci` | `true` | o `WHERE enviado_ci = true` só alcança quem era `true` |
| `ci_situacao` | `valor_anterior` | gravado (`'na_fila'` nas 6) |
| `ci_encerrado_em` | `NULL` | a guarda `ciJaSeManifestou` recusa `encerrado`; já era `NULL` |
| `ci_encerrado_por` | `NULL` | idem |
| `data_baixa` | — | **nunca foi alterada**; nada a desfazer |

### ❌ DESTRUÍDO — valor anterior nunca gravado (14)

| coluna | vira | por que não dá |
|---|---|---|
| `dt_envio_ci` | `NULL` | o timestamp exato do encaminhamento se perde |
| `enviado_ci_por` | `NULL` | quem encaminhou se perde |
| `parecer_ci` | `NULL` | o texto do parecer do C.I. se perde |
| `ci_rodada` | `0` | a rodada anterior se perde |
| `parecer_tipo` | `NULL` | **o tipo do parecer da analista se perde** |
| `baixada` | `false` | o valor anterior se perde (e o `WHERE` não exige `true`) |
| `status` | `'analise'` | o status anterior se perde |
| `situacao_atual` | `'Em análise'` | idem |
| `baixado_por` | `NULL` | quem baixou se perde |
| `estornada` | `true` | o valor anterior se perde |
| `data_estorno` | `NOW()` | sobrescreve estorno anterior, se houvesse |
| `motivo_estorno` | motivo novo | idem |
| `estornado_por` | nome novo | idem |
| `obs_situacao` | motivo novo | a obs anterior se perde |

---

## 3. Por que a INFERÊNCIA não substitui o dado gravado

Existe a tentação de deduzir os quatro campos perdidos do evento `ci` anterior da mesma
parcela — ele guarda `valor_anterior = parecer_tipo` e um `criado_em`. **Medi o quanto isso
funcionaria, e não funciona:**

| medição | resultado |
|---|---|
| PCs hoje puxáveis (`enviado_ci=true` e `ci_situacao IS NULL OR 'na_fila'`) | **1.421 PCs em 268 TRs** |
| dessas, com evento `ci` no histórico da parcela | **1.409** — **12 PCs não têm nenhum** |
| `criado_em` do evento `ci` == `dt_envio_ci` | **1.403 de 1.409.** **6 divergem**, até **21 segundos** |
| parcelas em que `dt_envio_ci` varia entre as PCs irmãs | **2** — e o histórico é **por parcela**, não por PC |
| PCs sem `parecer_tipo` hoje | **13** — em que a inferência inventaria um |
| PCs sem `enviado_ci_por` | **31** |
| PCs sem `baixado_por` | **1.155 de 1.421** |
| PCs hoje puxáveis que **não** estão `baixada` | **1** — a inferência "era baixada" já erraria nela |
| PCs hoje puxáveis que **já** estão `estornada` | **1** |
| `parecer_ci` preenchido nas 1.421 | **0** |
| `ci_rodada` nas 1.421 | **todas em 1** |

⚠️ **E o pior: depois da puxada não há como saber em qual caso você está.** Os 6 desvios de
21 s, as 12 sem evento `ci`, a 1 que não era baixada — todos ficam indistinguíveis do resto,
porque o dado que os separava foi o dado apagado. Uma reversão por inferência **acertaria a
maioria e mentiria em silêncio numa minoria que ninguém consegue identificar.** É exatamente
a armadilha 19 do `CLAUDE.md`: um candidato só esconde a ambiguidade.

⚠️ **A `observacao` também não ajuda:** o `· DESFEZ A BAIXA — sai da produtividade ·` é
**literal fixo** no código — a rota o escreve sempre, mesmo quando a PC não estava baixada.
Ele não é um sinal, é um texto.

---

## 4. A prova do dano que você descreveu — ela está no banco

**2023PC002107** (hist id 1377) foi puxada em **20/08 23:42:45** e **refeita à mão** logo
depois:

| | |
|---|---|
| baixa ORIGINAL (evento `parecer`) | **17/08 21:36:21** |
| encaminhamento ORIGINAL (evento `ci`) | **17/08 21:37:33** |
| puxada | **20/08 23:42:45** |
| `data_baixa` de hoje | **20/08 23:45:25** ← **três dias depois da baixa real** |
| `dt_envio_ci` de hoje | **20/08 23:45:41** |

**A baixa de 17/08 virou uma baixa de 20/08.** O relatório de produtividade lê `data_baixa`;
o passado foi reescrito e não há caminho de volta pela tela. É o seu ponto, medido.

⚠️ **E ela ficou com resíduo:** `estornada = false` (o novo parecer limpou), mas
`motivo_estorno = "É necessário puxar o processo do Controle Interno…"` e
`estornado_por = "Rafael"` **continuam lá** — o `POST /parcela/parecer` zera `estornada` e
`data_estorno`, mas **não** zera `motivo_estorno` nem `estornado_por`. Uma PC baixada
carregando o motivo do estorno que já foi desfeito.

**As outras 5 puxadas continuam desfeitas até hoje** — `baixada = false`, `estornada = true`,
`parecer_tipo = NULL`, fora da produtividade.

---

## 5. ⛔ PAREI AQUI. O que falta para o desfazer ser possível — e a decisão é sua

**Não implementei a rota nem o script.** Você pediu para eu parar se não desse, e não dá:
uma rota de desfazer que inventasse `dt_envio_ci`, `parecer_tipo`, `baixada` e `estornada`
seria pior que não ter rota nenhuma — ela **pareceria** restaurar.

Para o desfazer existir, **o `puxar_ci` precisa passar a gravar a foto do estado ANTES de
apagá-lo, por `codigo_pc`.** Isso é escrita de esquema (`ALTER`/`CREATE`) e depende da sua
ordem. Duas formas, e eu recomendo a primeira:

### Opção A — coluna `estado_anterior jsonb` em `parcela_historico` *(recomendada)*

```sql
ALTER TABLE parcela_historico ADD COLUMN IF NOT EXISTS estado_anterior jsonb;
```

- **Uma linha, uma tabela, nenhuma fonte nova.** É o argumento que o próprio
  `lib/acompanhamento.js` faz: "uma tabela de auditoria paralela teria de ser alimentada por
  todas as rotas, e no primeiro esquecimento passaria a mentir por omissão".
- A foto é **por PC**, chaveada por `codigo_pc`, porque `parcela_historico` é chaveado por
  parcela e uma parcela tem até 7 PCs com valores diferentes (2 parcelas já divergem em
  `dt_envio_ci` hoje):

```json
{ "2020PC000922": { "baixada": true, "data_baixa": "…", "enviado_ci": true,
  "dt_envio_ci": "…", "enviado_ci_por": 33, "parecer_tipo": "…", "parecer_ci": null,
  "ci_situacao": "na_fila", "ci_rodada": 1, "ci_encerrado_em": null, "ci_encerrado_por": null,
  "status": "baixada", "situacao_atual": null, "baixado_por": 33, "estornada": false,
  "data_estorno": null, "motivo_estorno": null, "estornado_por": null, "obs_situacao": null } }
```

- Serve para `estorno` e `correcao_situacao` depois, pelo mesmo caminho.
- Custo: nenhum índice, nenhuma FK, `NULL` nas 1.653 linhas antigas.

### Opção B — tabela nova `parcela_estado_anterior`

Mais "limpa" no papel, e é a que o `acompanhamento.js` argumenta contra. Só faria sentido se
você quiser guardar foto de **muita** coisa; hoje é de uma ação só.

### ⚠️ E, decidido isso, sobra uma segunda decisão que também é sua

**As 5 PCs já puxadas e não refeitas** (2020PC000922, 2020PC001426, 2020PC001535,
2020PC001900, 2020PC002963) **não têm foto** — nasceram antes de qualquer foto existir. Para
elas, "desfazer exato" continua impossível. O que **é** possível, e é decisão de regra:

- **B1** — deixá-las como estão, e o desfazer só valer daqui pra frente.
- **B2** — reconstruí-las **uma a uma, com o comando na tela**, usando o evento `parecer` e o
  evento `ci` de cada uma como origem declarada (as 5 têm os dois; a `data_baixa` das 5 está
  **intacta** e bate com o `criado_em` do `parecer`). Não seria "desfazer" — seria uma
  correção de dado assumida, com o número na frente e o motivo no histórico.

Não escolhi entre B1 e B2, e não escolhi entre A e B. **Me diga, e eu implemento na mesma
sessão** — rota `POST /parcela/desfazer_puxar_ci` (só superadmin, motivo obrigatório,
restaurando **valor por valor gravado**, sem `NOW()` em campo nenhum de data original) e o
script `desfazer_puxar_ci.js` (dry-run por padrão, `BEGIN` → foto → conferências contra a
foto → `COMMIT`, `ROLLBACK` em falha, idempotente, JSON de reversão que o dry-run não
sobrescreve).

---

## Como refazer estas medições

Tudo saiu de `SELECT` contra o `DATABASE_URL` de produção. As consultas centrais:

```sql
-- as puxadas e o que o histórico guarda delas
SELECT * FROM parcela_historico WHERE evento = 'puxar_ci' ORDER BY criado_em;

-- o universo em risco
SELECT COUNT(*) pcs, COUNT(DISTINCT tr) trs FROM prestacoes_contas
 WHERE enviado_ci = true AND (ci_situacao IS NULL OR ci_situacao = 'na_fila');

-- o que a inferência erraria
SELECT COUNT(*) total, COUNT(dt_envio_ci) com_dt, COUNT(parecer_tipo) com_parecer,
       COUNT(enviado_ci_por) com_autor, COUNT(baixado_por) com_baixado_por,
       SUM(CASE WHEN baixada THEN 1 ELSE 0 END) baixadas,
       SUM(CASE WHEN estornada THEN 1 ELSE 0 END) estornadas
  FROM prestacoes_contas
 WHERE enviado_ci = true AND (ci_situacao IS NULL OR ci_situacao = 'na_fila');
```
