# Agir pela conta do analista + desfazer ações — as três respostas

> Medido contra o banco e contra o código em 14/08/2026. **Nada implementado, nada gravado.**

---

## 1. Onde o sistema guarda hoje quem EXECUTOU a ação

**Não existe campo de executor separado do dono.** O que existe:

| onde | coluna | guarda | tipo |
|---|---|---|---|
| `prestacoes_contas` | `analista_id` · `analista_nome` | **o DONO** do trabalho | int · varchar |
| `prestacoes_contas` | `registrado_por` | o **NOME** de quem registrou o parecer | **varchar, texto livre** |
| `prestacoes_contas` | `estornado_por` | o **NOME** de quem estornou | varchar |
| `prestacoes_contas` | `ci_encerrado_por` | o **ID** de quem encerrou o ciclo do C.I. | int |
| `solicitacao_devolucao` | `decidido_por` | o **ID** de quem decidiu | int |
| `parcela_historico` | `analista_id` | **depende da rota** — ver abaixo | int |

**O mais próximo de um executor é o `registrado_por`** — e ele não serve para trilha:

- é **varchar com o nome**, não id. Nomes repetem, mudam e são digitados;
- é preenchido com **o que o navegador mandar** (`registrado_por: U.nome`);
- está **nulo em 13.922 das 14.652 PCs**. Das preenchidas, 600 dizem
  `"Importacao planilhas 03/08/2026"`.

### ⚠️ E o `parcela_historico.analista_id` significa DUAS coisas diferentes

| evento | o que está gravado ali | quantas linhas |
|---|---|---|
| `parecer` · `situacao` · `ci` · `resposta_diligencia` | **o DONO** (`b.analista_id`) | 139 |
| `devolucao_tr` · `estorno` | **o EXECUTOR** (`quem.id` / `b.usuario_id`) | 4 |
| `assumir_tr` | o dono, que ali é o executor | 2 |

Isso **já é um defeito de trilha hoje**, sem nenhuma relação com o "ver como": lendo o
histórico não dá para saber se o número é de quem fez ou de quem mandou fazer. Enquanto os
dois papéis coincidiam, ninguém percebeu. **O "agir pela conta do analista" é justamente o que
separa os dois papéis** — e é o que torna esse defeito visível.

### O que isso significa para a autoria dupla

Gravar dono **e** executor exige um lugar para o executor. Como não existe, há dois caminhos —
**e os dois precisam da sua autorização, porque criam coluna**:

| caminho | o que muda | custo |
|---|---|---|
| **A. `executado_por` (int) em `parcela_historico`** | a trilha passa a ter as duas colunas: `analista_id` = dono, `executado_por` = quem clicou | 1 coluna, e a limpeza do significado ambíguo acima |
| **B. só texto na `observacao`** | nada de ALTER; a marca vai na frase | não dá para **consultar** "o que o Richard executou", e a CGE pergunta exatamente isso |

**Recomendo o A.** O B repete o erro do `registrado_por`: informação de auditoria em texto
livre não se audita.

---

## 2. As três travas do navegador — quais saem e quais ficam

| # | trava | destino |
|---|---|---|
| 1 | `vcOff()` põe `disabled` no botão | **SAI** nas ações liberadas |
| 2 | `if(verComoAtivo())` dentro de cada função | **SAI** nas ações liberadas · **FICA** nas outras |
| 3 | `window.fetch` envolvido, bloqueando todo não-GET | **NÃO SAI — MUDA DE PAPEL** |

### A trava 3 não pode ser removida. Ela vira o carimbo.

O próprio `index.html` já documenta o motivo, e ele continua valendo:

> *"São 59 caminhos de escrita em 89 chamadas. Desabilitar botão a botão erra um — e o que
> errar é o que grava uma baixa no nome de outra pessoa, e aí o relatório da CGE deixa de
> provar quem fez o quê."*

Hoje são **56 chamadas de escrita** no arquivo. O `fetch` envolvido é o **único ponto por onde
todas passam**. Em vez de recusar, ele passa a **carimbar** todo corpo não-GET com
`executado_por: U.id`. Assim o carimbo vale para o botão que eu esquecer, para o código
escrito amanhã e para quem chamar a função pelo console — que é a mesma razão de a trava ter
sido posta ali.

### ⚠️ A trava 2 fica de pé para o que não é trabalho do analista

Agir **pelo** analista é fazer o trabalho dele: parecer, situação, C.I., diligência, assumir.
**Não é** trocar a senha dele, mesclar o cadastro dele, ligar modo manutenção ou decidir
pedido de vaga. Essas continuam recusadas dentro da função — e o carimbo não as legitima.

### ⚠️ E há uma quarta coisa, que você não citou e é a que mais importa

Hoje toda escrita manda **`analista_id: U.id`**. Com o modo ligado e as escritas liberadas,
isso gravaria **você como DONO do trabalho** — o oposto exato do que você pediu. A baixa
entraria na **sua** produtividade, e não na do analista.

Para a autoria dupla, o corpo precisa de:

```
analista_id:   alvo().id     ← o DONO, o analista
executado_por: U.id          ← QUEM EXECUTOU, você
```

E o lugar certo para fazer essa troca é **o mesmo `fetch`**, uma vez, e não em 56 chamadas.

⚠️ **A guarda de verdade continua sendo do servidor.** Um carimbo posto pelo navegador é
carimbo que o navegador pode tirar. O `executado_por` precisa ser **conferido contra o perfil
lido no banco**: só `superadmin` pode mandar um `executado_por` diferente do `analista_id`.
Sem isso, qualquer analista poderia gravar no nome de outro — que é o buraco que a troca de
senha de 11/08 fechou.

---

## 3. O que dá para desfazer hoje, ação por ação

| ação | desfaz? | caminho de hoje | o que falta |
|---|---|---|---|
| **Parecer registrado (a baixa)** | **SIM** | `POST /parcela/estornar` | nada. É o **único desfazer completo** que existe: só coordenador/superadmin, motivo ≥ 15 caracteres, limpa `parecer_tipo` e `situacao_atual`, grava `estornado_por` e histórico `estorno`. |
| **Encaminhamento ao C.I.** | **NÃO** | — | não há rota. `enviado_ci` só vira `true`, em `POST /parcela/ci` e na migração de 05/08. |
| **Situação alterada** | **PARCIAL** | `POST /parcela/situacao` grava outra por cima | não volta ao valor anterior. O histórico **tem** `valor_anterior`, e ninguém o usa para reverter. |
| **TR assumida** | **SIM, mas para o ESTOQUE** | `POST /tr/devolver` (só superadmin) ou o pedido de devolução aprovado | não existe "devolver ao dono anterior", exceto no motivo 1 do pedido. |
| **Diligência** | **PARCIAL** | trocar a situação para outra | `qtd_diligencias` **só sobe** (`COALESCE($4, qtd_diligencias)`) e `prazo_diligencia` fica gravado. Não há como cancelar uma diligência lançada por engano. |

### ⚠️ E existe um "desfazer tudo" hoje, sem trava nenhuma

`PATCH /prestacoes_contas/:codigo_pc` monta `SET ${sets.join(', ')}` **a partir das chaves do
corpo**. Ele aceita `enviado_ci: false`, `ci_situacao: null`, `analista_id: null`,
`parecer_tipo: null` — **qualquer coluna**, sem conferir perfil, sem exigir motivo e **sem
gravar histórico**.

É por ali que a tela antiga do C.I. gravava, e é o que sobrou como caminho de reversão.
**Não é um recurso — é o buraco.** Um "desfazer" de verdade significa:

1. rota própria por ação, com **motivo obrigatório** e **histórico**, como o estorno já faz;
2. **fechar esse PATCH** para as colunas que têm rota própria.

Fazer o 1 sem o 2 deixa a porta dos fundos aberta ao lado da porta da frente.

---

## O que eu preciso de você antes de implementar

1. **A coluna `executado_por` em `parcela_historico`** — é ALTER, e é sua decisão. Sem ela a
   autoria dupla não é consultável, só legível.
2. **Confirmar a lista do que fica proibido** mesmo no modo agir: senha, mesclagem, aprovação
   de cadastro, os dois interruptores, decisão de pedido de vaga e de devolução.
3. **Quais desfazeres você quer agora** — o C.I. e a diligência não têm caminho nenhum hoje, e
   cada um é uma rota nova com motivo e histórico.
4. **Se fecho o `PATCH /prestacoes_contas/:codigo_pc`** para as colunas que ganharem rota
   própria. Fechar pode quebrar chamada antiga que eu ainda não mapeei — eu levantaria todas
   antes.
