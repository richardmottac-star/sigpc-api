# Parecer — a fonte do número da parcial

**16/08/2026** · dupla verificação: dois agentes mediram o mesmo, cegos um ao outro.
**Nada foi gravado. Nada foi alterado.** Só `SELECT`.

---

## 1. Bateram ou divergiram

**BATERAM.** Em tudo que os dois mediram, o número é o mesmo:

| medida | agente 1 | agente 2 |
|---|---|---|
| escopo (`hoje ≠ mapa`) | 2.432 PCs · 211 TRs | 2.432 · 211 |
| **A ≠ B** | **73 PCs · 30 TRs · 38 processos** | **73 · 30 · 38** |
| B == A | 0 | 0 |
| rótulos numéricos em B | 3.286 | 3.286 |
| teste não-circular (695 PCs) | 609 == A (87,6%) · 42 == hoje · 33 nenhum | idêntico |
| projeção inversa (1.228 linhas) | só A 27,7% · só hoje 0,8% | 340 (27,7%) · 10 (0,8%) |
| split do mapa | 105 processos · 73 TRs | 105 · 73 |
| split de B e do banco de hoje | **0** | **0** |
| fusão do mapa | 80 · 54 TRs | 80 · 54 |
| diferença A−B | +1:28 · −1:13 · +2:13 · +3:6 · −2:4 | idêntico |
| grupo | G1 32 · G2 31 · G3 10 | idêntico |
| `tr_afetada` não marca 51 TRs do escopo | sim | sim |

**Nenhuma divergência.** O que variou foi a **cobertura** — cada um mediu algo que o outro
não olhou, e é daí que vêm os dois achados principais.

⚠️ **O "60" e o "73" reconciliam:** 13 das 73 já caem nas 15 TRs `FORA_DO_LOTE`;
**restam 60** dentro do lote — que é o número que o revisor tinha dado. Os dois estavam certos,
medindo universos diferentes.

---

## 2. A origem das fontes, e os padrões

### FONTE B — `_backup_parcial_num_20260805`

**Não é fonte independente: é uma cópia das planilhas dos analistas.** Medido: dos 3.286
rótulos, **3.235 de 3.235 (100,0%)** que têm chave na planilha carregam exatamente o rótulo
dela. Zero exceções.

A cadeia, com arquivo:linha:

| passo | onde | o que faz |
|---|---|---|
| 1 | `recarga_exec.js:263` | `SET baixada=false, parecer_tipo=NULL, parcial_num=NULL` — **zera os 14.652** |
| 2 | `recarga_exec.js:64` | lê a coluna **`Parcial`** da aba `backup` das 3 planilhas |
| 3 | `recarga_exec.js:50-55,72` | `ehBaixada()` — descarta o que não é parecer/C.I. Por isso **B só cobre baixadas** |
| 4 | `recarga_exec.js:84-95` | pega o SGPe na aba `Planilha1` |
| 5 | `recarga_exec.js:214-215` | `c.parcialNum = String(nums[0])` — **grava o MENOR rótulo** quando há vários |
| 6 | `recarga_exec.js:289-302` | o `UPDATE`, com `origem_baixa = 'recarga_parcial_20260805'` |
| 7 | `backfill_parcial_num.js:19-22` | `CREATE TABLE ... AS SELECT id, parcial_num` — a foto do passo 6 |

Confirmado: **todas as 3.286 PCs com rótulo em B têm `origem_baixa='recarga_parcial_20260805'`**.

### FONTE A — `MAPA_PARCIAL_SIGEF.csv`

Gerado em **16/08/2026** a partir de `ESTOQUE_FCEE_OFICIAL_DA_CGE.xlsx`, aba `Parcial`, chave
`NR. PC` → valor `Parcial`. **Nunca passou pelo banco** (origem informada pelo Richard).

Casa **8.998 de 8.998 por `codigo_pc`**, com **0 TRs divergentes**.

⚠️ **E é IDÊNTICO, linha por linha, ao `_backup_baixada_20260805`** — a foto do `parcial_num`
**anterior** à recarga de 05/08. 8.998 de 8.998, zero diferenças. Como o CSV veio da CGE e
nunca tocou o banco, **a conclusão é que o estado pré-recarga ERA a numeração da CGE**.

### O padrão principal: as duas fontes discordam sobre o que é uma parcial

| fonte | pares (tr, processo) | processo com **mais de um** número | número com mais de um processo |
|---|---|---|---|
| **A (CGE)** | 5.069 | **105** (73 TRs) | 80 (54 TRs) |
| **B (0805)** | 1.792 | **0** | 2 |
| **HOJE** | 5.431 | **0** | 2 |

⚠️ **A regra "uma parcial = (tr, processo_pc)" da armadilha 16 pode ser herdada da planilha,
não do SIGEF** — B a satisfaz porque foi construída assim. **61 das 73 (83,6%)** estão num
processo que A parte em vários números.

### O mecanismo do estrago, medido

**207 de 3.071 linhas de planilha (6,7%) têm SGPe que não existe naquela TR no banco** —
inclusive **100% das de 2025 e 2026**, anos que o banco não tem. Essas linhas não casam, e o
`MIN` do passo 5 **colapsa a parcela inteira no menor rótulo sobrevivente**.

### Sub-padrões medidos

- diferença A−B: **|dif| = 1 em 41 de 73 (56%)** — acúmulo, não deslocamento fixo;
- **75% das divergências abaixo do número 10** — o desvio nasce cedo na TR e se propaga;
- ano da TR: 2020 → 59 (81%);
- **sem concentração** por grupo nem por analista (19 afetados, 26 com zero);
- `parcela_n_cge` **não foi decodificada** — coincide com A em 13 de 73 e com B em 1 de 73.

---

## 3. O desempate — ⚠️ **PROVISÓRIO**

⚠️ **Este item foi medido contra as planilhas de 04/08, que estão DESATUALIZADAS.** As de
16/08 chegaram depois e o desempate está sendo refeito. **Não decida por estes números.**

**O número óbvio não vale nada, e os dois agentes disseram isso:**

| chave `(TR, SGPe)` — nas 73 | PCs |
|---|---|
| planilha == B | 64 |
| planilha == A | 0 |
| lista as duas (multi-rótulo) | 9 |

**É circular por construção**: B *é* a planilha. Medir assim é perguntar à planilha se ela
concorda consigo mesma. Os **9 "as duas"** são o resíduo revelador — a planilha traz mais de
um rótulo, A usa o maior e **B usa o menor porque `recarga_exec.js:215` pega o mínimo**.

### Os testes que NÃO são circulares

**I — o subconjunto que B nunca tocou** (2.359 PCs; 695 com linha de planilha):

| | PCs | % |
|---|---|---|
| planilha == **A** | **609** | **87,6%** |
| planilha == hoje | 42 | 6,0% |
| nenhuma | 33 | 4,7% |

**II — projeção inversa** `(TR, número) → qual processo?`, sobre 1.228 linhas que B nunca usou:
**só A 340 (27,7%) · só hoje 10 (0,8%)** — razão **34:1**.

**III — por VALOR**, chave que não vem de nenhuma das duas fontes, exigindo candidato único:

| grupo | casadas | == A | == a outra | nenhuma |
|---|---|---|---|---|
| **controle** (onde já concordam) | 786 | 95,7% juntas | — | **4,3% (piso de ruído)** |
| escopo inteiro | 125 | **108 (86,4%)** | 4 (3,2%) | 13 |
| **as 73** | 9 | **8** | 1 | 0 |

**A prova ao centavo — `2020TR000642`:** a planilha diz parcial 2 = R$ 2.564,63 · parcial 3 =
R$ 962,05 · parcial 4 = R$ 2.564,63. O banco tem os três valores, os três no mesmo
`SCC13297/2020`, e **A os numera 2, 3 e 4**. **B colapsou os quatro no rótulo 1.**

---

## O que nenhum dos dois decidiu, e é do Richard

**As duas fontes usam modelos incompatíveis de "parcial":**

- **B e o banco de hoje:** uma parcial = um processo SGPe. Zero exceções.
- **O mapa da CGE:** um processo SGPe pode abrigar várias parciais do SIGEF. 105 processos.

**Só o SIGEF responde qual é o certo.** Os dois agentes se recusaram a escolher, como manda a
regra do auditor.

## O que não foi possível medir

1. **Se o SIGEF realmente tem duas parciais no mesmo SGPe** — só o SIGEF responde.
2. **A discordância A×B só pôde ser testada por valor em 9 dos 73** — nos outros o valor não
   aparece na planilha (58) ou aparece repetido na TR (6). **8:1 sobre 9 casos é indicativo,
   não prova.**
3. **1.664 das 2.359 PCs sem rótulo em B não têm linha de planilha** — nenhuma fonte terceira.
4. **133 linhas de planilha têm valor ilegível** (nulo ou vírgula ambígua como `R$ 2,661,11`).

## Divergências contra os documentos do repositório — reportadas, não adotadas

| documento | diz | medido |
|---|---|---|
| `AUDITORIA_SIGPC_2026-08-16.md` §2 | 1.621 parciais · **176 TRs** | escopo real **2.432 PCs · 211 TRs** |
| `MAPA_PARCIAL_SIGEF.csv` (`tr_afetada`) | 176 TRs marcadas | **51 TRs do escopo sem a marca** |
| `CLAUDE.md` armadilha 16 | 9 TRs fora da renumeração | 8 delas estão entre as 30; **faltam 22** |
| `CLAUDE.md` armadilha 16 | gabarito 3.281 · 1.792 · 529 | **confere** |

## Erro meu, registrado

Eu disse aos dois agentes que o pacote `xlsx` estava instalado em `sigpc-api`. **Não está** —
não consta do `package.json` nem do `node_modules`. Os dois contornaram instalando fora do
projeto. **Consequência à parte: o `recarga_exec.js` não roda hoje nesse diretório.**
