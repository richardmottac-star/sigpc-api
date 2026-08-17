# Troca de papel do superadmin — as três respostas

> Medido no código e no banco em 14/08/2026. **Nada implementado, nada gravado.**
> Você é o **único** `superadmin` do sistema (id 4). Esta função existe para uma pessoa.

---

## 1. Onde o papel ativo fica guardado, e se sobrevive ao refresh

### Como a sessão funciona hoje

Não há token nem sessão no servidor. O login devolve a linha de `usuarios`, o navegador
guarda em **`localStorage`** (chave `SESSAO_KEY`, validade em `expira_em`) e **cada requisição
manda o `usuario_id`**; o servidor relê o perfil no banco quando a rota se importa.

`restaurarSessao()` recompõe o `U` a partir do `localStorage` — então **o que estiver no `U`
sobrevive ao F5**, e some quando a sessão expira ou no logout.

### ⚠️ Existe um `modoAnalista` no `U` hoje, e ele é ARMADILHA

```js
modoAnalista: sec !== 'ADMIN'     // gravado no login e na sessão
```

Ele é gravado, salvo no `localStorage` e **nunca lido em lugar nenhum** — três ocorrências no
arquivo, todas de escrita. E não tem nada a ver com papel: é sobre `setorialAcesso` (ADMIN x
FCEE). **Não reaproveitar esse nome**, sob pena de o papel novo herdar um significado morto.
O campo novo precisa de outro nome — `papelAtivo`.

### As duas formas de guardar, e o que cada uma custa

| | **A. só no navegador** (`localStorage`) | **B. coluna `papel_ativo` em `usuarios`** |
|---|---|---|
| sobrevive ao F5 | sim | sim |
| sobrevive em **outro navegador/aba** | não — cada um com o seu papel | sim, é um estado só |
| o servidor sabe o papel | **só se o navegador contar** | **sim, lê do banco** |
| registro da troca | precisa de rota própria | a mesma rota que grava |
| custo | zero | **1 coluna + 1 tabela ou coluna de registro** |

⚠️ **A sua exigência — "a guarda é do servidor" — só se cumpre de verdade no B.** No A, o
servidor confere um valor que o próprio navegador manda: protege contra **engano**, não contra
**quem monta o pedido HTTP à mão**. Como o único superadmin é você, o A não é escalada de
privilégio (você já pode tudo); mas a trilha ficaria dizendo "estava como analista" com base
na palavra do cliente, e é a trilha que a CGE lê.

**Recomendo o B**, e ele precisa da sua autorização: `papel_ativo TEXT DEFAULT 'analista'` em
`usuarios`.

### E o registro de cada troca

Você pediu que **cada troca fique registrada, com quando e para qual papel**. Não há onde
gravar isso hoje: `parcela_historico` é por TR/parcela, e uma troca de papel não tem TR.
São dois caminhos, e os dois exigem autorização:

- **tabela nova `papel_historico`** (`usuario_id`, `papel`, `criado_em`) — 3 colunas, limpa;
- **reaproveitar `notificacao`** — não: notificação se apaga, e trilha não pode ser apagável.

---

## 2. Quantas rotas conferem superadmin hoje

**São 8 rotas** que exigem `superadmin`, e **mais 6** que aceitam `superadmin` junto com
`coordenador`. Todas passariam a conferir o **papel ativo**, não só o perfil:

### Exigem só superadmin (8)

| rota | o que faz |
|---|---|
| `DELETE /usuarios/:id` | exclui usuário |
| `PATCH /config_sistema` | os dois interruptores (preparação e manutenção) |
| `PATCH /config_limite_tr` | o limite de TRs |
| `GET /busca_global` | o acervo de qualquer analista |
| `GET /tr/:tr/devolucao` | a prévia da devolução |
| `POST /tr/devolver` | devolve a TR ao estoque |
| `PATCH /prestacoes_contas/estornar` (linha 1278) | estorno em lote |
| `POST /prestacoes_contas/registrar_parecer` (linha 2272) | parecer administrativo |

### Aceitam superadmin OU coordenador (6)

`POST /usuarios/mesclar` · `DELETE /repositorio/:id` · `POST /faixa_aviso` ·
`POST /notificacao` · `POST /parcela/estornar` · `PATCH /solicitacao_devolucao/:id`

⚠️ **Nestas seis, você como "analista" cairia na regra do coordenador — e você não é
coordenador de ninguém.** Ou seja: no papel analista elas devem recusar você **igual a
qualquer analista**, e não "aceitar porque sobrou o ramo do coordenador". É o tipo de detalhe
que passa: a condição é `['coordenador','superadmin'].includes(perfil)`, e tirar só o
`superadmin` não basta se o papel não for conferido antes.

### E a que não aparece na conta

`POST /solicitacao_devolucao` e as rotas de trabalho **não conferem superadmin** — mas mudam
de comportamento quando o pedido vem de você: hoje `podeDecidir` deixa o superadmin decidir
qualquer pedido, inclusive o próprio. **No papel analista isso também tem de cair.**

---

## 3. Isso quebra alguma tela que já existe?

**Quebra nada; esconde muito.** No papel analista somem do menu **11 itens**:

```
Board / Gráficos · Relatórios · Ver como analista · Gestão Grupo · Aprovações
Férias e Afastamentos · Estornos Realizados · Controle Interno · Faixa de avisos
Enviar recado · Painel ADMIN          + Busca global (bloco superadmin)
```

O que **fica**: Dashboard, Estoque TRs, Minha Planilha, Produtividade, Repositório, Meus
pedidos, Meu Perfil — exatamente a carteira de um analista.

### ⚠️ Quatro pontos onde a tela vai mudar de comportamento, e é preciso decidir

1. **O botão "↩ Devolver" no cartão da TR** (`U.perfil === 'superadmin'`) some — e no lugar
   dele aparece o **"Solicitar devolução"**, que é o do analista. Isso é o certo, mas significa
   que **no papel analista você pede a devolução das suas TRs, e ninguém pode aprovar**: você é
   o único superadmin, e o coordenador do grupo 3 é o Gustavo. Ou o pedido fica esperando o
   Gustavo, ou você troca de papel para decidir. **Decisão sua.**

2. **O "↩ Estornar"** no cartão some no papel analista — hoje ele aparece para coordenador e
   superadmin.

3. **O Painel ADMIN muda de nome conforme o perfil** (`Painel ADMIN` x `Gestão de Usuários`).
   No papel analista ele some inteiro.

4. **A Produtividade e o Board** contam por `contaProdutividade(u)`, que exclui coordenadores
   e o C.I. **Você continua fora da conta nos dois papéis** — trocar de papel não faz você
   aparecer no relatório da CGE. Se a intenção é que "Richard analista" apareça como analista
   na produtividade, isso é outra decisão, e mexe no Quadro 2 do relatório.

### O que NÃO quebra

- **Nada no servidor deixa de funcionar** enquanto o papel não for conferido lá: a mudança é
  aditiva (uma condição a mais), não substitutiva.
- **O "ver como analista" continua igual** — ele é do papel técnico, e no papel analista o
  item some do menu. Os dois recursos não se cruzam: um é *ver a tela de alguém*, o outro é
  *ser você mesmo com menos poder*.

---

## O que preciso de você antes de implementar

1. **`papel_ativo` em `usuarios`** — sem ela a guarda do servidor é a palavra do navegador.
2. **Onde registrar cada troca** — tabela `papel_historico` (3 colunas) é o que recomendo.
3. **O caso do item 1 acima:** no papel analista, quem aprova o seu pedido de devolução?
4. **Se "Richard analista" deve passar a contar na produtividade** — hoje não conta, em
   nenhum dos dois papéis.
