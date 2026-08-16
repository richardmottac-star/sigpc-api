# O processo em várias parciais — o que muda no código

**16/08/2026** · resposta à pergunta que travava a frente da numeração.
**Nada foi gravado. Nada foi executado no banco.** Só leitura de código e do xlsx.

---

## 0. Antes de tudo — o `.gitignore`

O `ESTOQUE FCEE OFICIAL DA CGE.xlsx` (45 MB) está ignorado, e as três planilhas de grupo
junto. Conferido com `git check-ignore`: os quatro casam a regra e sumiram do `git status`.

Entrou uma regra `*.xlsx` ampla, além dos nomes literais. O motivo é o tamanho: o arquivo
sozinho passa do limite de 100 MB do GitHub quando o pack cresce, e basta **um** `git add -A`
distraído para ele entrar no histórico — de onde não sai sem reescrever a árvore inteira.

⚠️ **E ficou anotado no próprio `.gitignore` que é DELE que o `MAPA_PARCIAL_SIGEF.csv` sai.**
O `SESSAO.md` já dizia "se sumir, reimportar a planilha da CGE"; agora a planilha está na
máquina e não no git, então o aviso tem de estar onde alguém vai olhar antes de apagar.

---

## 1. A medição — DOIS agentes, cegos um ao outro. **BATERAM.**

Nenhum dos dois recebeu o seu número, nem o do outro. Leram o xlsx do zero (um confirmou o
arquivo por SHA-256, 45.607.930 bytes), e um deles nem sabia que existia repositório.

### O número principal

| medida (chave normalizada, exigindo 2 números de verdade) | agente 1 | agente 2 |
|---|---|---|
| **pares (TR, processo) com 2+ parciais** | **113** | **113** |
| **TRs** | **78** | **78** ¹ |
| **PCs** | **465** | 478 ² |
| a mesma coisa com a chave **CRUA** | **105** · 73 TRs · 425 PCs | **105** · 73 TRs |
| quantos pares a normalização funde | **10** | **10** — e a lista é a mesma, TR a TR |
| maior concentração | 2019TR000193 · `SCC2146/2020` · **11** parciais | idêntico |
| **direção inversa** (TR, parcial) com 2+ processos | **81** · 55 TRs · 268 PCs | **81** · 55 TRs · 268 PCs |

¹ o agente 2 reportou 79 na variante que conta o literal `-` — ver abaixo.
² 478 conta as linhas com `Parcial = '-'` que caem dentro desses pares; o agente 1 só contou
as com número. A diferença é **13 linhas sem parcial**, não 13 parcelas.

**A sua medição — 113 pares, 2,2%, 78 TRs, 465 PCs, e a 2019TR000193 com 11 parcelas num
processo — confere nas quatro grandezas, por duas leituras independentes.**

### ⚠️ E o "114" do mapa reconcilia — não é discordância, é o `-`

O agente 1 tentou reproduzir 114 e **não conseguiu por variante nenhuma**. O agente 2, que
mediu contando `'-'` como valor, chegou a 114 — e mostrou que **só 1 dos 114 pares tem como
"segunda parcela" o literal `-`**, isto é, uma PC **sem** número de parcial.

**O certo é 113.** Os 114 do mapa contam uma PC não numerada como se fosse parcela.

### ⚠️ Dois achados que ninguém tinha pedido, e os dois agentes acharam sozinhos

**1 — A aba tem DUAS colunas chamadas `Parcial`** (índices 8 e 11). Os dois conferiram:
**divergem em 0 de 13.626 linhas**. Não muda número nenhum, mas qualquer script que leia a
aba por **nome** de coluna pega uma das duas de forma imprevisível. Ler por índice.

**2 — `Parcial` e `PARCELA N°` NÃO são a mesma pergunta, e a diferença é enorme.**
O agente 1 mediu as duas:

| coluna | pares com 2+ | % dos pares | preenchimento |
|---|---|---|---|
| **`Parcial`** (o número do SIGEF) | **113** | 2,23% | 8.998 de 13.626 — **34% está `-`** |
| `PARCELA N°` | **2.372** | **43,75%** | 13.626 de 13.626 |

⚠️ **É a mesma armadilha que a auditoria de hoje de manhã descreveu ao contrário.** Escolher
`PARCELA N°` aqui responderia "sim, em 44% dos casos" — e estaria medindo a sequência do
**pagamento** dentro da TR, não a parcial da prestação. Os dois agentes se recusaram a
escolher entre as colunas, como manda a regra. **A sua pergunta é sobre `Parcial`, e a
resposta dela é 113.**

### O resto do que mediram

- **79 linhas têm `NR. PROCESSO PC = '-1'`** (processo degenerado). Tirando o `-1` **e** o
  `'-'`, o número cai para **109 · 101 na chave crua**. Ou seja: **4 dos 113 são o `-1`**,
  que não é processo — é o bloqueio nº 4 do `SESSAO.md` aparecendo por outro caminho.
- **A coluna da TR é `NR. TRANS / NT. TE`** — não existe coluna "TR". E o agente 2 achou
  que **4 dos 1.554 instrumentos são `TE`, não `TR`**: `2021TE002462`, `2021TE000516`,
  `2021TE000260`, `2021TE000314`. Coerente com o nome da coluna, e algo que nenhum documento
  do repositório menciona.
- Os **10 processos com duas grafias na mesma TR** são os mesmos nos dois relatórios, e
  incluem **duas em minúsculas** (`scc 8134/2024`, `scc8214/2024`). **8 dos 10 viram par
  multi ao normalizar** — é literalmente o mecanismo que o `CLAUDE.md` já descrevia.
- **A relação é N:N nos dois sentidos**: 113 processos com várias parciais **e** 81 parciais
  com vários processos. Nem "uma parcial = um processo", nem o inverso.

### Conclusão da dupla verificação

**Bateram em tudo que os dois mediram.** Não há divergência a levar para você antes de seguir.
A regra `uma parcial = (tr, processo_pc)` está **refutada pela fonte**, e o mapa **não parte
processos indevidamente** — ele reproduz o que a CGE tem.

⚠️ **O que isto NÃO prova:** os dois leram o **xlsx**, não o SIGEF. A afirmação é "o estoque
oficial da CGE registra 113 casos", não "eu abri o SIGEF e vi". Se você quiser a prova de
tela, a amostra conferível está nos dois relatórios — a mais direta é a **2020TR000642 /
`SCC13297/2020`, parciais 1, 2, 3 e 4**, que é a mesma TR da "prova ao centavo" do
`PARECER_FONTES`.

---

## 2. A resposta curta sobre o `carregarParcela`

**Ele não precisa mudar de chave. Já está certo.**

```js
// server.js:3164
async function carregarParcela(cli, tr, parcial_num, setorial_id) {
  const { rows } = await cli.query(
    `SELECT * FROM prestacoes_contas
      WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3
      ORDER BY codigo_pc
      FOR UPDATE`,
    [setorial_id, tr, String(parcial_num)]
  );
  return rows;
}
```

A chave é **`(setorial_id, tr, parcial_num)`** — nunca foi `processo_pc`. Os cinco chamadores
(`parecer`, `situacao`, `ci`, `estornar`, `resposta_diligencia`) fazem o `UPDATE` com o
**mesmo `WHERE`**, e nenhum deles lê `processo_pc` das linhas que recebe. A tela também agrupa
por `parcial_num` (`index.html:3205`, `8235`, `10813`), não por processo.

Ou seja: uma TR com o `SCC 13297/2020` nas parciais 2, 3 e 4 vira **três cartões**, e um
parecer na parcial 3 baixa **só a parcial 3**. É o comportamento que se quer, e ele já existe.

⚠️ **A frase "uma parcial = (tr, processo_pc)" nunca esteve no `carregarParcela`.** Ela está
em comentário e em script de validação. Foi por isso que o diagnóstico demorou: o invariante
falso não mora no caminho que o analista usa — mora nas travas que protegem esse caminho.

### O que muda de verdade: o significado do `FOR UPDATE`

Hoje, travar a parcela trava também o processo inteiro, porque os dois conjuntos coincidem.
Depois do lote, **não coincidem mais**: dá para segurar a parcial 3 e deixar a 4 solta, ambas
no mesmo processo. Isso só importa contra a rota que mexe no processo — e é o item 3.

---

## 3. O que precisa mudar de verdade — quatro pontos, todos fora do `carregarParcela`

### ⚠️ 3.1 — `PATCH /prestacoes_contas/:codigo_pc/processo`, o bloco `fusao` (`server.js:2583‑2609`)

**É o único lugar do sistema que executa a regra falsa.** E ele não só a afirma: ele a
**impõe, reescrevendo `parcial_num`.**

```js
const { rows: outras } = await cli.query(
  `SELECT DISTINCT parcial_num FROM prestacoes_contas
    WHERE setorial_id='FCEE' AND tr = $1 AND processo_pc = $2 AND tipo <> 'final'`, [pc.tr, novo]);
if (outras.length) {
  fusao = { ..., parcial_destino: outras[0].parcial_num, ... };
  if (b.juntar !== true) return res.status(409).json({ ... });
}
...
if (fusao && b.juntar === true)
  await cli.query(`UPDATE prestacoes_contas SET parcial_num = $2 ... WHERE codigo_pc = ANY($1) AND tipo <> 'final'`,
                  [codigos, fusao.parcial_destino]);
```

Três defeitos que só aparecem depois do lote:

| | o quê |
|---|---|
| **a** | `outras.length` hoje é 0 ou 1. Depois do lote pode ser 2, 3… até o máximo medido. O 409 passa a disparar em correção de processo **legítima**, e a mensagem diz "vai juntar", que é exatamente o que **não** se pode fazer. |
| **b** | `outras[0]` **sem `ORDER BY`** — com 2+ linhas o Postgres escolhe. Confirmar o `juntar` colapsa as parciais num número **arbitrário**, e desfaz em silêncio a renumeração que o lote acabou de fazer. |
| **c** | O `SELECT` das irmãs (2578) e o da fusão (2587) rodam **antes do `BEGIN`** (2600). Já é TOCTOU hoje; com processo em várias parciais o alvo do `UPDATE` fica maior e a janela passa a valer mais. |

**A correção:** a fusão deixa de ser automática. Colidir no `(tr, processo_pc)` **não é mais
sinal de nada** — o que ainda é colisão real é o `(tr, parcial_num)`. O aviso deve continuar
existindo (o analista precisa saber que o processo já aparece em outra parcial), mas como
**informação**, sem `parcial_destino` e sem o `UPDATE parcial_num`. E os dois `SELECT` vão
para dentro do `BEGIN`.

⚠️ **Isto é decisão sua, não minha:** hoje `juntar: true` é um caminho que o analista aciona
na tela. Tirar o "juntar" muda o que o sistema faz para ele. Eu **não mudo isso sem sua
ordem** — a mudança está descrita, não aplicada.

### ⚠️ 3.2 — Três scripts abortam para sempre depois do lote

Todos rodam a mesma consulta e mandam `ROLLBACK` se ela não der zero:

```sql
SELECT tr, processo_pc FROM prestacoes_contas
 WHERE setorial_id='FCEE' AND tipo <> 'final'
 GROUP BY 1,2 HAVING COUNT(DISTINCT parcial_num) > 1
```

| arquivo | linha | rótulo |
|---|---|---|
| `corrigir_processo_pc.js` | 224‑227 · 235 | `parcela partida em 2 numeros` |
| `renumerar_parcial_num.js` | 216‑219 · 250 | `parcela partida em 2 numeros` |
| `resolver_processos_restantes.js` | 281 · 286 | `parcela partida em 2 numeros` |

⚠️ **A consulta é GLOBAL, não é recortada pelas linhas que a rodada tocou.** Depois do lote
ela passa a devolver o número medido acima **em toda rodada**, mesmo numa que não encoste em
`parcial_num`. Os três scripts ficam inutilizáveis — e, pior, dizem "FALHA" apontando para o
lugar errado.

E há um mais forte ainda, o `c7` do `renumerar_parcial_num.js:221‑226`:

```sql
HAVING MAX(parcial_num::int) <> COUNT(DISTINCT processo_pc)
    OR COUNT(DISTINCT parcial_num) <> COUNT(DISTINCT processo_pc)
```

Isso é a **bijeção** parcial ↔ processo escrita por extenso, com o valor esperado cravado em
`c7.n === 9` (as 9 TRs conhecidas). Depois do lote o número sobe para as 9 mais as TRs com
split. **`9` deixa de ser a resposta certa**, e o teste que existe para pegar erro passa a
denunciar o acerto.

### 3.3 — O comentário de `lib/processo-edit.js:13‑16`

Escreve a regra falsa como se fosse a regra do sistema. É o texto que qualquer um lê antes de
mexer na rota — e foi ele que sustentou o bloco `fusao`. Some junto com 3.1.

### ⚠️ 3.4 — O que o `carregarParcela` **deveria** ganhar, e não é sobre processo

Ele **não filtra `tipo`**. As PCs FINAIS gravadas com `parcial_num = '1'`
(`2021TR001689`, `2021TR002133`, `2023TR000048`) entram na parcial 1 e são baixadas,
encaminhadas ao C.I. e estornadas junto com ela — em **todos os cinco** chamadores.

Note que o resto do sistema já sabe disso e se protege: a tela usa `planEhFinal` por `tipo`
(`index.html:8167`), e a rota de fusão escreve `AND tipo <> 'final'` no `UPDATE`. **Só o
`carregarParcela` não.**

Não é consequência do split — é anterior a ele, e já está na sua lista de pendências como
correção de DADO. Mas o lote é a hora de decidir: **corrigir o dado das 3 PCs** ou **pôr a
guarda no código**. As duas são defensáveis, e a escolha é sua:

- **só o dado** deixa a rota confiando num invariante que nada garante;
- **só o código** esconde três linhas erradas em vez de consertá-las;
- **as duas** é o que eu faria, e é a única que fecha o buraco pelos dois lados.

---

## 4. O que NÃO precisa mudar — medido, não presumido

| | por quê |
|---|---|
| `carregarParcela` e os 5 chamadores | chaveiam por `(tr, parcial_num)`; nenhum lê `processo_pc` das linhas |
| o agrupamento da tela | `index.html:3205`, `8235`, `10813` — todos por `parcial_num` |
| `lib/ci.js` | seleciona `processo_pc` só para exibir |
| `lib/busca-global.js:139,143` | monta o cartão por parcela e mostra o processo da primeira PC — é o caso **inverso** (uma parcela, vários processos), que já existia |
| `parcela_historico` | chaveia por `(tr, parcial_num)`; o problema dele é a **renumeração**, não o split — é o bloqueio nº 3 do `SESSAO.md`, e continua de pé |
| `renumerar_sigef.js` | não tem a validação da bijeção. É o único dos quatro scripts que não aborta sozinho |

---

## 5. A ordem que eu proporia

1. **Corrigir os 3 scripts e a rota ANTES do lote.** Se o lote gravar primeiro, o
   `corrigir_processo_pc.js` e o `resolver_processos_restantes.js` param de rodar — e são eles
   que consertam os processos SGPe que ainda faltam.
2. **Trocar a validação, não apagar.** `HAVING COUNT(DISTINCT parcial_num) > 1` deixa de ser
   um erro, mas a colisão que interessa continua: **`(tr, parcial_num)` com mais de um
   `processo_pc`** onde não deveria, e `parcial_num` fora de `1..N`. A trava tem de mudar de
   pergunta, não sumir — script sem validação é como o `renumerar_sigef.js` está hoje.
3. **Reescrever a armadilha 16** nos dois `CLAUDE.md` e o comentário do `processo-edit.js`.
4. Só então os 5 bloqueios do `SESSAO.md` e os 4 defeitos do `renumerar_sigef.js`.

---

## 6. O QUE FOI FEITO (16/08/2026, com as três decisões do Richard)

**Testes: 19 suítes no `sigpc-api` + 16 no `sigpc-gt`, todas 0 falhas. `node --check` nos 6
arquivos JS e os 2 blocos `<script>` do `index.html` compilam. NÃO publicado.**

### 6.1 A rota — o `juntar` saiu (decisão 1)

`server.js` · `PATCH /prestacoes_contas/:codigo_pc/processo`

| saiu | entrou |
|---|---|
| o `409` de "fusão de parcela" | nada — colidir em (tr, processo_pc) não bloqueia mais |
| `b.juntar` | — |
| `UPDATE ... SET parcial_num = fusao.parcial_destino` | — |
| `outras[0]` sem `ORDER BY` | `convive`, com as parciais em **ordem numérica** |

⚠️ **O 409 saiu junto com o `juntar`, e não por decisão minha:** ele só existia para oferecer
o `juntar`. Mantê-lo bloquearia a correção legítima sem caminho de saída.

⚠️ **Corrigi também o TOCTOU** (item 3.1c): o `BEGIN` passou para **antes** das leituras, e as
duas ganharam `FOR UPDATE`. O `UPDATE` escreve pela lista que elas produzem — ela não pode
mudar no meio.

No `index.html`, o modal *"⚠ Isto junta duas parciais"* com o botão **"Entendi, juntar"** saiu.
O toast do sucesso agora diz *"este processo também está na parcial N desta TR"*.

### 6.2 Os scripts — eram três, são **quatro**

| arquivo | o que mudou |
|---|---|
| `corrigir_processo_pc.js` | **DOIS pontos**, não um: o `c4` saiu da lista de checks **e** o §4, que abortava a rodada inteira (`exitCode = 3`) antes de escrever. Os dois viraram medição impressa. |
| `resolver_processos_restantes.js` | `c3` saiu dos checks, virou medição `antes -> depois`. |
| `renumerar_parcial_num.js` | `c5` virou medição; o `c7` perdeu as duas cláusulas de bijeção e virou **delta** ("não aumentou"), porque `=== 9` deixou de ser a resposta certa. |
| **`backfill_parcial_num.js`** | **não estava na lista, e é o pior dos quatro** — ver abaixo. |

### ⚠️ 6.2-A O quarto script, achado na conferência final

`backfill_parcial_num.js` não aparecia nas buscas anteriores porque escreve o invariante **na
direção contrária**: `(tr, parcial_num)` com `COUNT(DISTINCT processo_pc) > 1`, sob o
comentário *"uma parcial nunca deve juntar processos SGPE diferentes"*. O check abortava com
mais de **5**. **A medição diz 81** (55 TRs, 268 PCs) — ele mandaria `ROLLBACK` para sempre.

⚠️ **E o cabeçalho dele é o registro de como o erro nasceu.** Dizia, literalmente:

> *"Uma parcial = (tr, processo_pc). **Verificado:** nas 2.125 chaves já numeradas, nenhuma
> tem mais de um parcial_num — a relação é funcional."*

Era **verdade sobre o banco e falso sobre o SIGEF**: o "verificado" olhou o dado de saída da
própria migração e chamou o padrão dele de regra. É a mesma frase que virou a armadilha 16 e
que só caiu quando alguém foi ler a fonte.

Tratado como o `renumerar_parcial_num.js`: check virou delta, e cabeçalho de bloco dizendo que
o **método** também está refutado — o `herd` herda o número pelo `processo_pc` (um número por
processo) e o resto vem de `parcela_seq`, caminho já reprovado em 13/08.

⚠️ **O §4 do `corrigir_processo_pc.js` eu não tinha reportado antes** — só apareceu ao abrir o
arquivo para editar. Era mais forte que o `c4`: abortava **antes** da escrita, e era ele que
impediria de vez a correção dos 11 processos SGPe pendentes.

⚠️ **NÃO INVENTEI CHECK SUCESSOR nos dois primeiros, de propósito.** Eles não escrevem em
`parcial_num`, e isso quem prova é o `c2`, que já existe: com `c2 = 0`, corrigir texto de
processo não consegue partir nem juntar parcela nenhuma. Um substituto encenaria uma proteção
que já existe. **No `renumerar_parcial_num.js`, que escreve, o check ficou** — só trocou de
pergunta, para a metade do `c7` que não fala de processo: os números de uma TR vão de 1 a N,
sem furo e sem repetido.

### ⚠️ 6.3 O achado que muda a ordem de trabalho: o `renumerar_parcial_num.js` não pode rodar

Corrigir a validação **não bastou**. O `GROUP BY p.tr, p.processo_pc` do `PLANO` (linha 49)
**é** a regra refutada: o script deduz o número da parcela a partir do processo. Rodá-lo hoje
daria **um número por processo** e recolapsaria exatamente as parcelas que o lote existe para
separar — o mesmo estrago da recarga de 05/08, por outro caminho.

Pus um cabeçalho de bloco dizendo isso. **Não pus trava de execução:** recusar a rodar muda o
que a ferramenta faz, e isso é seu. **Se você quiser, o próximo passo é apagar o script** — o
sucessor (`renumerar_sigef.js`) já existe e o histórico está no git.

### 6.4 As FINAIS ficaram como DADO (decisão 2)

**Nenhum `AND tipo <> 'final'` entrou no `carregarParcela`.** O que entrou foi um comentário
dizendo por quê, e terminando em *"se você veio aqui para adicionar o filtro, conserte o
dado"* — senão o próximo a passar por ali "corrige" o código e as 3 linhas erradas ficam.

O `UPDATE` **não foi executado nem escrito em script**. Para quando você mandar:

```sql
-- CONFERIR PRIMEIRO (tem de devolver exatamente 3 linhas, todas tipo='final')
SELECT codigo_pc, tr, tipo, parcial_num, baixada, enviado_ci
  FROM prestacoes_contas
 WHERE tipo = 'final' AND parcial_num = '1'
   AND tr IN ('2021TR001689','2021TR002133','2023TR000048');

-- E SÓ ENTÃO, com a lista explícita de chaves (regra 12), nunca por condição derivada:
-- UPDATE prestacoes_contas SET parcial_num = 'FINAL', atualizado_em = NOW()
--  WHERE codigo_pc = ANY($1);
```

⚠️ O `index.html` comenta **cinco** finais com `parcial_num = '1'`; o `SESSAO.md` diz **três**.
**Confira o `SELECT` antes** — os dois números não podem estar certos ao mesmo tempo.

### 6.5 A armadilha 16, reescrita (decisão 3)

Nos **dois** `CLAUDE.md`, e virou quatro blocos: a regra nova (**16**), as duas armadilhas de
leitura que os agentes acharam (**16-A** as duas colunas `Parcial` + a TR que se chama
`NR. TRANS / NT. TE` com 4 instrumentos `TE`; **16-B** `Parcial` × `PARCELA N°`, 113 contra
2.372), e o que sobrou da renumeração de 13/08 (**16-C**). No `sigpc-gt` é a armadilha **14**.

Registrei também **por que a regra falsa parecia verdadeira** — foi lida do banco já deformado
pela recarga. É a lição que se perde se ficar só o número.

### 6.6 Um defeito de teste, achado ao corrigir

`teste_processo_edit.js` fatiava a rota por **tamanho fixo** (`+ 5200`) e a rota tem 4.689 —
sobravam **511 caracteres da rota seguinte** dentro da fatia. Enquanto os testes só procuravam
o que **tinha** de existir, a sobra não atrapalhava. Os novos conferem o que **não pode**
existir (`juntar`, `409`), e aí um trecho do vizinho reprova o arquivo certo. A fatia agora
termina na rota seguinte.

E a minha primeira versão do teste de ordem `BEGIN` × `FOR UPDATE` **reprovou o código certo**:
comparava posição sobre o texto cru, e o comentário que explica a ordem cita `FOR UPDATE` 240
caracteres antes do `BEGIN`. Passou a comparar sem as linhas de comentário.

### 6.7 O que NÃO foi feito

- **Nada foi publicado.** Sem `git commit`, sem `git push`, nos dois repositórios.
- **Nada foi escrito no banco.** Nenhum `UPDATE`/`INSERT`/`ALTER` rodou.
- **O `renumerar_sigef.js` não foi tocado** — os 4 defeitos dele continuam de pé.
- **Os outros 4 bloqueios do `SESSAO.md` continuam de pé.** Só o nº 1 (o "split") caiu, porque
  descrevia o dado correto como se fosse dano.
