# SIGPC-GT — Contexto do Projeto

Sistema de Gestão de Prestações de Contas do Grupo de Trabalho da FCEE
(Fundação Catarinense de Educação Especial, Governo de Santa Catarina).

**Responsável:** Richard Motta Coelho — superadmin e analista do Grupo 3.
**Última sessão:** 16/08/2026 — ver `SESSAO.md`. **Onze escritas em produção nesse dia.**

> ## ✅ 16/08/2026 — ONZE ESCRITAS EM PRODUÇÃO. Ver `SESSAO.md`.
>
> **14.658 PCs** · 1.031 finais · 3.804 baixadas · **2.318 no C.I.** · **6.090 sem dono, todas
> `livre`**. Renumeração pelo SIGEF em **211 TRs**; 6 PCs incluídas; 87 destravadas; 78 soltas
> atribuídas ao dono da TR.
>
> ⚠️ **A armadilha 16 foi REESCRITA:** um processo SGPe carrega **várias** parcelas do SIGEF —
> 113 pares medidos no estoque da CGE. A regra antiga foi lida do banco já deformado.
> ⚠️ **`parecer`, `estornar` e `ci` ganharam filtro de `baixada`** — faziam `UPDATE ... WHERE tr
> AND parcial_num` e reescreviam baixa alheia em parcela mista.
> ⚠️ **"Livre" tem UMA definição:** `assumir.PC_LIVRE_SQL`, usada pelo assumir, pelo `resumo_tr`
> e pela tela. Antes eram duas, e 87 PCs caíam no vão.
> ⚠️ **`recarga_exec.js` está DESARMADO** — zera 14.652 linhas, e o sistema está aberto.
>
> **O sistema está ABERTO.** Os dois interruptores estão **desligados** e a equipe trabalha.
>
> **Configurações tem TRÊS abas:** Limite de TRs · Modo preparação · Modo manutenção.
>
> | | preparação | **manutenção** |
> |---|---|---|
> | o analista **entra**? | sim, e a tela limita | **não** |
> | isentos | superadmin **e coordenador** | **só superadmin** |
> | quem já está dentro | vira tela restrita | **cai a sessão** |
> | efeito no "online" | nenhum | **zera na hora** |
>
> ⚠️ **A manutenção derruba TODO MUNDO** — coordenadores e o Controle Interno inclusive.
> É ela que abre a janela segura de escrita. A preparação barra os três técnicos do C.I.
> como efeito colateral (`ISENTOS`, em `lib/preparacao.js`).

---

## Arquitetura

| Camada | Stack | Repositório |
|---|---|---|
| Frontend | HTML single-file no GitHub Pages | `sigpc-gt` → `index.html` |
| API | Node.js/Express no Railway | `sigpc-api` → `server.js` |
| Banco | PostgreSQL no Railway | — |

- Sistema: https://richardmottac-star.github.io/sigpc-gt/
- API: https://sigpc-api-production.up.railway.app
- Banco: string de conexão em `DATABASE_URL` (variável de ambiente — ver Railway; não versionar a senha)

O deploy é automático: `git push` no `sigpc-api` redeploya o Railway; no `sigpc-gt` atualiza o GitHub Pages.

---

## Regra de negócio

```
TR ──── processo mãe (1:1)
 └── PC (1 a 83)   ← chave única = codigo_pc | unidade de produtividade
      ├── processo SGPe da PC   (compartilhado entre PCs)
      └── NL (1 por PC)         (compartilhada entre PCs → 1 parecer baixa N)
```

- **1 PC = exatamente 1 NL.** Sem exceção nas 13.626 parciais.
- **1 NL pode ser quitada por várias PCs** — até 19 (ex: `2022NL008336`).
  É o que a CGE descreve como *"um parecer baixa 8 PCs"*.
- O analista assume a **TR inteira** e analisa todas as PCs dela.
- A unidade de produtividade é a **PC baixada**, conforme CGE nº 727/2025.
- Meta padrão: 110 PCs por analista no período; proporcional para quem entrou depois.

---

## Banco de dados

### `ci_mensagem` — a conversa do Controle Interno (12/08/2026)

Uma linha **por PC por mensagem**: `codigo_pc`, `rodada`, `direcao`
(`ci_para_analista` | `analista_para_ci`), `texto`, autor, `criado_em`.

⚠️ **A conversa é por PC, mas o encaminhamento é por PARCELA** — `POST /parcela/ci` manda a
parcela inteira, e há parcela com 7 PCs. A tela agrupa e o técnico escreve uma vez; grava-se
uma mensagem por PC, mesmo texto, mesma rodada.

O estado do ciclo fica em `prestacoes_contas`: `ci_situacao`
(`na_fila` | `com_analista` | `encerrado`, **NULL para quem nunca foi ao CI**), `ci_rodada`,
`ci_encerrado_em`, `ci_encerrado_por`.

⚠️ **`enviado_ci` NÃO mudou de significado**: diz "foi ao CI" e **sustenta a baixa**.
`ci_situacao` diz onde está no ciclo. Confundir as duas foi o defeito que este ciclo corrigiu.

⚠️ **A baixa nunca é tocada** em nenhum caminho do CI. Há teste que falha se um UPDATE do
ciclo mencionar `baixada`, `data_baixa` ou `enviado_ci`.

### `config_sistema` — 1 linha, `id = 1`

`modo_preparacao` (bool), `mensagem`, `atualizado_por/_nome/_em`. `CHECK (id = 1)`.

### Quem está online — `usuarios.sessao_fim`

Online = `ultimo_acesso >= agora − 30 min` **E** `(sessao_fim IS NULL OR sessao_fim < ultimo_acesso)`.
Lê-se: *esteve ativo há pouco e não encerrou a sessão depois disso*.

⚠️ **Nunca recuar `ultimo_acesso` para tirar alguém da lista** — o Painel ADMIN mostra essa
coluna, e ela passaria a mentir. Foi por isso que a `sessao_fim` existe.

⚠️ **O logout grava `clock_timestamp()`, não `NOW()`.** No Postgres o `NOW()` é o instante em
que a **transação** começou; com ele os dois carimbos saíam iguais e a pessoa ficava fora da
lista mesmo tendo voltado. Só apareceu no teste contra o banco.

### `usuarios` — 54 registros

Além do cadastro: `senha_hash` (bcrypt desde 11/08/2026) e **`senha_provisoria`** — quando
`true`, o login desvia para a tela de troca antes de abrir o painel. Criada no boot por
`garantirColunasUsuarios()`, nasce `false`; quem marca é `migracao_senhas.sql`.

⚠️ **Login é por CPF.** Nove usuários estão sem CPF e não conseguem entrar — ver Pendências.

### `prestacoes_contas` — 14.652 registros (fonte única)

Chave: `codigo_pc`. Tipos: `parcial` (13.626) e `final` (1.026, sem NL, id `{TR}-PFINAL`).

Status: `livre`, `analise`, `diligencia`, `reanalise`, `baixada`.

Campos: `codigo_pc`, `codigo_nl`, `tipo`, `tr`, `processo_pc`, `processo_mae`,
`parcela_seq`, `entidade`, `cnpj_cpf`, `valor`, `situacao_origem`, `status`,
`analista_nome`, `analista_id`, `grupo`, `conflito`, `parecer_tipo`, `baixada`,
`data_baixa`, `origem_baixa`, `registrado_por`, `setorial_id`, `dt_limite_pc`,
`dt_recebimento_pc`, `prazo_analise_dias`, `dias_atraso`, `prazo_diligencia`,
`num_diligencia`, `enviado_ci`, `dt_envio_ci`, `parecer_ci`, `situacao_atual`,
`ci_situacao`, `ci_rodada`, `ci_encerrado_em`, `ci_encerrado_por`,
`dt_inicio_analise`, `dt_assumida`

⚠️ **`dt_inicio_analise` e `dt_assumida` respondem perguntas DIFERENTES.**

| | responde | reinicia ao reassumir? |
|---|---|---|
| `dt_inicio_analise` | quando a análise **começou** — o relógio do prazo | **não** (`COALESCE` no servidor) |
| `dt_assumida` | quando **este** analista pegou a TR | **sim**, e volta a `NULL` na devolução |

A diferença só passou a importar quando a devolução ganhou botão: depois de devolver e outro
assumir, `dt_inicio_analise` mostraria a data do analista **anterior**. Criada em 13/08 **sem
backfill** — as 761 TRs de antes não têm data, e o cartão simplesmente omite a linha.

### `solicitacao_devolucao` — o analista PEDE a devolução (13/08/2026)

Ele **pede**, não devolve. Uma linha por pedido: `analista_id`, `tr`, `motivo` (código),
`justificativa`, `indicado_id`/`indicado_nome`, a foto do que foi prometido na tela
(`pcs_total`, `pcs_voltam`, `pcs_ficam_baixadas`), `status`, `decidido_por`, `decidido_em`,
`motivo_decisao`.

⚠️ **TABELA SEPARADA DA `solicitacao_vaga`, e o motivo é medido.** Sete consultas de
`lib/limite-tr.js` leem aquela tabela **sem filtro nenhum**. Um pedido de devolução gravado lá
viraria **+1 no limite** de quem pediu para devolver, **reservaria no Estoque** a TR que ele
quer largar, **expiraria em 3 dias** avisando "a TR voltou ao estoque", e seria **consumido**
como autorização para furar o limite. Nenhum desses dá erro. **Não fundir as duas tabelas.**

⚠️ **A TR CONTINUA CONTANDO NO LIMITE ENQUANTO O PEDIDO ESTÁ PENDENTE.** Não é regra escrita
em lugar nenhum: é consequência de o pedido **não tocar em `analista_id`**. Só a aprovação
devolve. Se o pendente já liberasse a vaga, qualquer um abriria vaga só pedindo devolução.

⚠️ **`motivo` guarda CÓDIGO, não rótulo** (`analise_anterior`, `impedimento`,
`falta_documentacao`, `afastamento`, `redistribuicao`, `outro`). O rótulo do primeiro carrega
uma **data** ("antes de 01/08/2026"), e um CHECK sobre o texto passaria a recusar as linhas
antigas quando o texto fosse reescrito.

⚠️ **`autodecidido` NÃO é coluna** — sai de `decidido_por = analista_id`. Coluna separada
seria uma segunda fonte para a mesma resposta.

Cinco `CHECK` no banco, e o índice **único parcial** `(tr, setorial_id) WHERE status =
'pendente'`: **um pendente por TR**. É ele que segura dois cliques — a conferência da rota
não seguraria.

### `usuarios.papel_ativo` + `papel_historico` — os dois papéis do superadmin (14/08/2026)

O Richard tinha dois papéis no mesmo login e eles se confundiam. Agora é explícito:

| papel | o que vê e faz |
|---|---|
| `analista` | só o que um analista vê e faz. **14 itens somem do menu.** |
| `tecnico` | acesso a tudo, e é o **único** papel que age pela conta de outro analista |

**Padrão ao entrar: `analista`.** O reset é do SERVIDOR, em `POST /usuarios/login` — se o papel
sobrevivesse à sessão, uma entrada de manhã continuaria com o acesso de ontem à noite, e
trocar deixaria de ser ato deliberado.

⚠️ **UMA REGRA SÓ: `papel.perfilEfetivo(u)`.** No papel analista o superadmin **é** analista
em toda parte, e as rotas usam essa função no lugar de `u.perfil` — **10 pontos**. Uma
condição a mais em cada rota seria onde faltaria uma.

⚠️ **O ponto que passa batido são as SEIS rotas de "coordenador OU superadmin"**
(`mesclar`, `repositorio`, `faixa_aviso`, `notificacao`, `parcela/estornar`,
`solicitacao_devolucao/:id`). A condição é `['coordenador','superadmin'].includes(perfil)`, e
o Richard **não é coordenador de ninguém** — tirar só o `superadmin` da lista não bastaria.
O `perfilEfetivo` resolve pelos dois lados.

⚠️ **`papel_historico` só registra quando o papel MUDA.** Uma linha por login normal encheria
a trilha e esconderia a troca deliberada, que é o que se quer enxergar. `origem` separa
`login` de `troca`.

⚠️ **Ninguém troca o papel de outro**, e a troca e o registro vão na **mesma transação** —
papel trocado sem registro seria trilha furada.

### `parcela_historico.executado_por` — a autoria dupla (14/08/2026)

`analista_id` = o **DONO** do trabalho · `executado_por` = **QUEM CLICOU**.

⚠️ **Fica NULO quando o dono executou.** Nulo quer dizer "foi ele mesmo": preencher sempre
pareceria mais completo e tiraria o sinal — o que importa achar é a linha em que os dois
**diferem**.

⚠️ **Só o superadmin age por outro**, conferido contra o perfil lido no BANCO. Sem isso
qualquer analista mandaria `executado_por` e gravaria no nome de outro.

⚠️ **Sem foreign key**, de propósito: existe `DELETE /usuarios/:id`, e uma FK faria a exclusão
de um cadastro falhar por causa de uma linha de histórico. **Trilha não trava cadastro.**

A marca vai na **coluna e no texto**: a coluna serve para consultar ("o que o Richard
executou"), o texto para quem abre uma linha solta. Só a coluna repetiria o erro do
`registrado_por`, que é nome em texto livre e nunca respondeu à pergunta da CGE.

⚠️ **Isto corrigiu um defeito que já existia:** o `analista_id` do histórico significava o
DONO em `parecer`/`situacao`/`ci` e o EXECUTOR em `devolucao_tr`/`estorno`. Enquanto os dois
papéis coincidiam, ninguém percebeu.

### Outras
- `metas_analistas` — 46 analistas, `vigente = true`, período Nov/2025 a Abr/2026
- `anotacoes_tr` — anotações por TR com histórico
- `usuarios` — cadastro e login
- `planilha_analista` — **DESCONTINUADA.** Nenhuma tela usa. Não reintroduzir.

### Baixas históricas
`origem_baixa = 'carga_historica'` · `data_baixa = 2026-06-30`

---

## Equipe

| Grupo | Coordenador | Analistas |
|---|---|---|
| 1 | Nayara Limas Ferreira | 15 |
| 2 | Zadir T. Machado Ferreira | 14 |
| 3 | Gustavo Hallack Porto (id 56) | 17 |

**Controle Interno** — 3 técnicos, perfil `controle_interno`, sem grupo, `meta_mensal = 0`:
ids **62 Marcia Terezinha Miranda · 63 Atemilson Bispo dos Santos · 64 Sirene Wolf dos Santos**.

⚠️ **Coordenadores E técnicos do C.I. não entram em relatório de produtividade.** Não é meta
zero — é não aparecer. A regra é `contaProdutividade(u)` no `index.html`, usada pela
Produtividade, pela Gestão Grupo e pelo Board. O Quadro 2 do CGE resolve por outro caminho:
lista de **inclusão** (`perfil === 'analista'`), que exclui qualquer perfil novo sozinha.

---

## As libs, e o que cada uma decide

A regra mora na lib; o `server.js` só abre a transação, confere quem pede e responde. Testar
a lib é testar a regra.

| lib | decide |
|---|---|
| `auth.js` | quem entra, e a senha (`senha_hash` NUNCA sai do servidor) |
| `preparacao.js` | o modo preparação — isentos: superadmin **e** coordenador |
| `manutencao.js` | o modo manutenção — isento: **só superadmin**; e o carimbo que derruba |
| `limite-tr.js` | quantas TRs cada um pode ter, e a reserva de quem pediu antes |
| `assumir.js` | assumir a TR inteira, e o **nome curto** do analista |
| `busca-global.js` | o card por TR da busca global, e o que pode ser mostrado como prazo |
| `devolucao.js` | devolver ao estoque, e o bloqueio quando há PC no C.I. |
| `devolucao-pedido.js` | o PEDIDO de devolução do analista — quem decide, e para onde a TR vai |
| `autoria.js` | o DONO e o EXECUTOR de cada ação — e quem pode agir por outro |
| `papel.js` | os dois papéis do superadmin, e o **perfil efetivo** que todas as rotas usam |
| `processo-edit.js` | corrigir o processo SGPe, e ler o link colado |
| `ci.js` | o ciclo do Controle Interno |
| `sgpe-link.js` | o mapa de **183 órgãos** e a URL do SGPe |
| `sgpe-lote.js` / `sgpe-dwr.js` | o cache de links e a consulta ao SGPe |
| `datas.js` | `HOJE_BR` — prazo é data civil brasileira, nunca `CURRENT_DATE` |

### Rotas que escrevem em bloco — todas transacionais

```
GET  /busca_global                          localiza qualquer TR ou PC (só superadmin)
POST /tr/assumir                            assume a TR inteira
POST /tr/devolver                           devolve ao estoque (só superadmin)
GET  /tr/:tr/assumir  ·  GET /tr/:tr/devolucao      as prévias, pela MESMA regra
PATCH /prestacoes_contas/:codigo_pc/processo        corrige o processo SGPe
POST /sgpe/link_manual                      grava o link colado (origem MANUAL)
POST /parcela/parecer · /situacao · /ci · /estornar · /resposta_diligencia
POST /ci/decidir  ·  /ci/responder
PATCH /config_sistema                       os dois interruptores

GET  /tr/:tr/pedido_devolucao               a prévia do pedido do analista
POST /solicitacao_devolucao                 ele PEDE (não devolve)
GET  /solicitacao_devolucao                 a fila — recorte pelo perfil lido no BANCO
PATCH /solicitacao_devolucao/:id            decide e, se aprovada, DEVOLVE na mesma transação

PATCH /usuarios/:id/papel                   troca o papel (só o próprio, só superadmin)
GET  /usuarios/:id/papel                    o papel de agora e as últimas 20 trocas
```

⚠️ **QUATRO ROTAS LIAM O `perfil` DO CORPO** — excluir usuário, excluir no repositório e os
dois estornos. Bastava mandar `perfil: 'superadmin'` para passar. Leem do BANCO desde 14/08,
pelo `usuario_id`. **Não voltar a confiar no corpo: ele nunca provou nada.**

⚠️ **A prévia e a gravação usam a MESMA função de regra.** Se cada uma calculasse do seu
jeito, o modal prometeria um número e o banco faria outro.

⚠️ **A aprovação do pedido de devolução tem DOIS CAMINHOS:**

| motivo | para onde a TR vai | por quê |
|---|---|---|
| **1** `analise_anterior` | **direto para o analista indicado**, pela `lib/assumir.js` | mandar ao estoque uma TR que tem destino a entrega a quem chegar primeiro |
| os outros **5** | estoque, pela `lib/devolucao.js` | é a devolução normal |

⚠️ **O LIMITE NÃO É CONFERIDO na transferência.** A trava de 10/08 vale no **ato de assumir**,
e aqui a TR está voltando para quem já a analisava. Medido em 13/08: **29 dos 44 analistas já
estão em 6 ou acima** — conferir faria o motivo 1 nascer inútil. A carga do indicado aparece
no cartão ("Marisa: 8 TRs, limite 6") e quem decide é o coordenador.

⚠️ **Indicado sem cadastro ativo BLOQUEIA a aprovação** (409), em vez de cair no estoque em
silêncio. O primeiro caso real é a **Caroline**: meta vigente, nenhum cadastro.

⚠️ **O solicitante não decide o próprio pedido.** Exceção: o **superadmin**, porque não há
ninguém acima dele — e aí o `parcela_historico` ganha `AUTODECIDIDO — quem pediu e quem
decidiu sao a mesma pessoa`. Apareceu no primeiro ciclo real: pediu e aprovou pela mesma
conta, e nada objetou.

### Scripts de manutenção (dry-run por padrão, só gravam com `--gravar`)

```
janela_livre.js                  "dá para gravar agora?" — três sinais
renumerar_parcial_num.js         a renumeração das parciais
corrigir_processo_pc.js          correção em lote (aceita --mae)
resolver_processos_restantes.js  os casos que a regra recusou
job_sgpe_links.js                resolve links no SGPe — NUNCA no boot
```

---

## Armadilhas conhecidas

1. **Nome curto vs completo** — `prestacoes_contas.analista_nome` é curto ("Richard");
   `usuarios.nome` é completo ("Richard Motta Coelho").
   **Sempre filtrar por `analista_id`**, nunca por nome.

2. **`CREATE TABLE IF NOT EXISTS` não altera tabela existente.**
   Para colunas novas usar `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

3. **Datas futuras zeram o relatório.** `data_baixa` sempre no passado.

4. **Colunas que NÃO existem em `usuarios`:** `email`, `obs`, `atualizado_em`.
   Incluí-las no payload gera erro. Se precisar, criar antes com `ALTER TABLE`.

5. **Não editar `index.html` por número de linha via PowerShell** — risco de corromper
   o arquivo inteiro. Usar edição por busca de texto.

6. **Setorial é sempre FCEE.** Os processos são abertos pelos núcleos (SCC, ADR, SDR),
   mas a concedente é a FCEE.

7. **Chave de agrupamento é `codigo_pc`**, nunca `processo_sgp` — 2.704 processos
   têm mais de uma PC.

8. **`senha_hash` NUNCA sai do servidor.** Toda rota que devolve linha de `usuarios` passa
   por `auth.semSegredo()`. Até 11/08/2026 não era assim: `GET /usuarios` entregava as 49
   senhas em texto puro a quem pedisse, sem credencial nenhuma — medido em produção.
   `teste_auth.js` falha se qualquer `SELECT *` ou `RETURNING *` de `usuarios` chegar à
   resposta sem o filtro. **Não contornar a trava: ela é a correção.**

9. **A senha não se confere no front.** Quem confere é `POST /usuarios/login`. A regra de
   quem pode entrar mora em `lib/auth.js`, não no `index.html` — lá ela era contornável
   pelo DevTools.

10. **Comentário dentro de template literal não leva crase.** Uma crase no meio de uma
    `` `...` `` fecha a string e o arquivo deixa de compilar. Aconteceu duas vezes em
    11/08, no `server.js` e no `index.html`. Escrever `FALSE`, não `` `false` ``.

11. **NUNCA testar contra o banco real uma função que gerencia a própria transação.**
    O `COMMIT` interno dela **confirma a transação externa**, e o `ROLLBACK` do teste não
    tem mais o que desfazer. Em 12/08/2026 isto gravou 7 PCs como `encerrado` e 14
    mensagens em produção, num teste que parecia isolado.
    **Ou** se testa a função com dublê de banco, **ou** se testa o SQL cru dentro de
    `BEGIN/ROLLBACK` — nunca as duas coisas misturadas.

12. **`WHERE` de reversão SEMPRE por lista explícita de chaves.** Nunca por condição
    derivada. Ainda em 12/08, reverter com `ci_rodada <> 1` casou as 14.639 PCs que tinham
    o valor padrão `0` e carimbou todas — de 7 linhas para 14.639.
    O certo é `WHERE codigo_pc = ANY($1)` com a lista capturada **antes** da escrita.

13. **Rota de nome fixo vem ANTES da rota com `:id`.** O Express casa na ordem de
    declaração: `/usuarios/pendentes` declarada depois de `/usuarios/:id` caía nela com
    id `"pendentes"` e devolvia HTTP 500 em produção. **O dublê não pega — dublê não
    roteia.** Há teste de posição e um HTTP que sobe o servidor de verdade.

14. **Ordem importa quando há `UNIQUE`.** A mesclagem copiava o CPF para a conta antiga e só
    então apagava a nova: as duas ficavam com o mesmo CPF por um instante e o Postgres
    recusava. **Apaga primeiro, copia depois.** O dublê também não pega — dublê não tem
    restrição de unicidade.

15. **Botão que aceita clique e não responde é pior que botão cinza.** O Confirmar do modal
    Assumir só era ajustado no caminho de sucesso; no erro continuava aceso, e clicar não
    fazia nada. Todo botão de ação nasce desabilitado e é habilitado no caminho que o
    autoriza — com o motivo no `title` quando não estiver.

16. **⚠️ UM PROCESSO SGPe PODE CARREGAR VÁRIAS PARCELAS DO SIGEF.** Reescrita em 16/08/2026.

    Até esta data esta armadilha dizia **"uma parcial = (tr, processo_pc)"**. **É falso**, e
    a frase custou caro: dela nasceram um `409` na rota do lápis que reescrevia `parcial_num`
    sozinho, e travas em três scripts que abortariam para sempre.

    **Medido no `ESTOQUE FCEE OFICIAL DA CGE.xlsx`, aba `Parcial`, por dois agentes cegos um
    ao outro — bateram:**

    | | |
    |---|---|
    | pares (TR, processo) com **2+ parcelas** | **113** (chave normalizada) · 105 na chave crua |
    | TRs · PCs | **78 TRs · 465 PCs** — 2,2% dos pares |
    | maior caso | **2019TR000193**, `SCC2146/2020`, com **11 parcelas** |
    | a direção contrária (parcela com 2+ processos) | **81** · 55 TRs · 268 PCs |

    **A relação é N:N nos dois sentidos.** Nem "uma parcial = um processo", nem o inverso.

    ⚠️ **POR QUE A REGRA FALSA PARECIA VERDADEIRA:** ela foi escrita observando o banco, e o
    banco estava deformado — a recarga de 05/08 (`recarga_exec.js:214-215`, que grava
    `nums[0]`, o **menor** rótulo) colapsou parcelas num número só, e a renumeração de 13/08
    preencheu as lacunas por processo. **Ler o dado de saída de uma migração e chamar o padrão
    dele de regra de negócio é como este erro nasce.** A fonte é o SIGEF, não a base.

    ⚠️ **QUEM AGRUPA A PARCELA É O `parcial_num`, E SÓ ELE.** `carregarParcela` sempre chaveou
    por `(setorial_id, tr, parcial_num)`, os cinco chamadores dele também, e a tela igual —
    por isso o sistema **já** suporta o processo em várias parciais, sem mudança nenhuma.
    A regra falsa nunca esteve no caminho do analista: estava nas travas em volta dele.

    ⚠️ **O "114" que circulou nos documentos é 113.** O par a mais tem como segunda parcela o
    literal `-` — uma PC **sem** número de parcial, não uma segunda parcela.

    ⚠️ **8 dos 113 só aparecem ao NORMALIZAR o processo.** São 10 casos do mesmo processo
    escrito de dois jeitos na mesma TR (`SCC8137/2021` × `SCC 00008137/2021`), **dois deles em
    minúsculas** (`scc 8134/2024`, `scc8214/2024`). Na chave crua eles se passam por processos
    diferentes — foi assim que a regra falsa sobreviveu tanto tempo.

16-A. **⚠️ A ABA `Parcial` DO ESTOQUE DA CGE TEM DUAS COLUNAS CHAMADAS `Parcial`.**
    Índices 8 e 11, e são **idênticas em 13.626 de 13.626 linhas** — não muda número nenhum,
    mas **qualquer script que leia a aba por NOME de coluna pega uma das duas de forma
    imprevisível**, conforme a biblioteca. **Ler por índice.**

    E a coluna da TR **não se chama TR**: é `NR. TRANS / NT. TE`. Nela, **4 dos 1.554
    instrumentos são `TE`, não `TR`** — `2021TE002462`, `2021TE000516`, `2021TE000260`,
    `2021TE000314`.

16-B. **⚠️ `Parcial` E `PARCELA N°` RESPONDEM PERGUNTAS DIFERENTES — e a coluna errada
    INVERTE a resposta.**

    | coluna | pares com 2+ parcelas | preenchimento |
    |---|---|---|
    | **`Parcial`** — o número do SIGEF, o que o analista vê | **113 · 2,2%** | 8.998 de 13.626 (**34% está `-`**) |
    | `PARCELA N°` — a sequência do pagamento na TR | **2.372 · 43,75%** | 13.626 de 13.626 |

    Escolher a `PARCELA N°` porque está 100% preenchida responderia **"sim, em 44% dos casos"**
    a uma pergunta sobre a parcial da prestação. **É a coluna `Parcial` que responde**, e o
    preço dela é o `-` em um terço das linhas. Mesma família da armadilha 19: o número que
    aparece primeiro não é o que responde.

16-C. **A renumeração de 12–13/08, e o que ainda vale dela.**

    ⚠️ **NÃO renumerar por `parcela_seq`.** Era o caminho escrito aqui até 12/08, e foi
    **medido e reprovado**: reescrevia **592 parcelas** (1.017 PCs, 67 TRs) cujo rótulo veio
    da planilha do analista — que é o número do SIGEF. `parcela_seq` **não é a ordem do
    SIGEF**: na 2020TR000704 a parcial 2 tem `parcela_seq` 10 e a parcial 3 tem `parcela_seq` 2.

    ⚠️ **E NÃO renumerar por `processo_pc` também** — é o que o `renumerar_parcial_num.js`
    faz (`GROUP BY p.tr, p.processo_pc`), e é por isso que **aquele script não pode mais
    rodar**. O sucessor é o `renumerar_sigef.js`, que lê o número da CGE em vez de deduzi-lo.

    ⚠️ **O gabarito é o `_backup_parcial_num_20260805`** — os rótulos numéricos dele são os
    do SIGEF (3.281 PCs, 1.792 parcelas, 529 TRs). **Não apagar essa tabela.**

    ⚠️ **9 TRs ficaram de fora da renumeração de 13/08:** 7 têm rótulo acima do total de
    parcelas (o SIGEF tem parcela que a base não tem — a 2020TR000638 tem 7 faltando: 623,
    638, 681, 718, 722, 809, 2385) e 2 têm o mesmo SGPe em duas grafias (791: `SCC 4813/2024`
    e `SCC 00004813/2024`; 967: `SCC15029/2022` e `SCC 00015029/2022`).
    ⚠️ **Essas 2 últimas deixaram de ser exceção** — são dois dos 10 casos de grafia dupla, e
    o processo em duas parcelas ali é legítimo.

    ⚠️ **A 2020TR000637 fecha 1..20, mas o SIGEF tem 19.** A sobra é a PC de
    `processo_pc = '-1'`, isolada no 20 de propósito. É problema de DADO — ver `pcs_sgpe_-1.csv`.
    ⚠️ E **4 dos 113 pares são o `-1`**, que não é processo: são o mesmo problema de dado
    aparecendo por outro caminho.

17. **⚠️ Ao criar trava de janela de escrita, o superadmin NÃO bloqueia.** O modo manutenção
    carimba `sessao_fim` em todos menos nele, de propósito — é ele quem precisa continuar
    entrando. Mas é o mesmo que acabou de ligar o modo e está rodando o script: contando-o,
    a trava recusa para sempre. Aconteceu em 12/08, na primeira gravação: o `janela_livre.js`
    dizia LIVRE e o `renumerar_parcial_num.js` recusava, porque só um dos dois tinha sido
    corrigido. **Se houver dois critérios de "pode gravar", eles têm de ser o mesmo.**

18. **⚠️ `AT TIME ZONE` sozinho está errado para coluna `timestamp` que guarda UTC.**
    `usuarios.ultimo_acesso`, `sessao_fim`, `prestacoes_contas.atualizado_em` e
    `parcela_historico.criado_em` são `timestamp WITHOUT time zone` **com valor em UTC**.
    Para um naive, `col AT TIME ZONE 'America/Sao_Paulo'` **interpreta** o valor como sendo
    de Brasília e SOMA 3 h. O certo são dois passos:
    `(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`.
    O `lib/datas.js` usa um passo só porque converte `NOW()`, que é `timestamptz` — não
    copiar de lá para coluna gravada. Em 12/08 isto mostrou 03:31 às 21:31.

19. **⚠️ UM CANDIDATO SÓ ESCONDE A AMBIGUIDADE.** Ao deduzir dado (processo SGPe, número,
    ano), gere **vários** candidatos e aceite só quando **exatamente um** se confirmar. Em
    13/08 o `SCC7537` não tinha ano; testar só o ano da TR confirmou e quase gravou — o SGPe
    tem `SCC 7537` em **sete** anos diferentes, e o `SCC 6579` em seis. **Link para o processo
    errado não dá erro na tela, e ninguém percebe.** Duas confirmações são ambiguidade, não
    confirmação.

20. **⚠️ Confirmar no SGPe e não gravar em `sgpe_processo_ref` deixa o texto certo e a tela
    SEM LINK.** O cache é o que faz o link existir — `procHtml` é um `Map.get` e nada mais.
    Corrigir o `processo_pc` sem popular o cache não resolve nada para quem olha a tela.

21. **⚠️ Validação que compara com backup antigo acusa o que rodadas anteriores fizeram de
    propósito.** Numa correção em várias etapas, compare com uma **foto do início da rodada** —
    a pergunta é "esta rodada mexeu no que não devia?", não "algo mudou desde ontem?".

22. **⚠️ Conferência de fusão de parcela só vale para `processo_pc`, e nunca quando o valor
    novo é igual ao antigo.** O `processo_mae` não agrupa parcial nenhuma. Em 13/08 isso
    abortou duas rodadas com "fusões" que eram a própria PC colidindo consigo mesma.

23. **⚠️ `kill` pode não pegar.** Em 13/08 uma rodada que mandei parar seguiu até o fim e só
    notificou depois. Era dry-run e não houve dano — foi sorte de sequência. **Antes de
    seguir, confirme que o processo morreu** (`Get-Process node`).

24. **⚠️ Ao tirar um laço de requisições, confira o que era feito DENTRO dele.** O "assumir"
    fazia um PATCH por PC — e a trava de limite era conferida a cada um. Como a PC 1 já
    contava como assumida, o limite podia estourar no meio e deixar a TR pela metade,
    justamente por causa da trava que existe para organizar a carga. Numa transação, a
    conferência é UMA, antes de escrever.

25. **⚠️ `String(d).slice(0,10)` num `Date` NÃO dá uma data ISO — dá `"Thu Mar 31"`.**
    O `pg` devolve coluna `date`/`timestamp` como **objeto `Date`**. Comparado como texto
    contra `'2026-08-01'`, `"Thu Mar 31"` **passa** em qualquer corte por data, porque `T` > `2`.
    Foi assim que a busca global mostrou **9.221 dias de atraso** sobre um `dt_limite_pc` que
    a trava existia justamente para esconder. Use uma função que trate `Date` e string
    (`paraIso` em `lib/busca-global.js`). É a mesma família de erro da armadilha 18.

---

## Método: TRABALHAR EM BLOCO, NÃO PASSO A PASSO (desde 12/08/2026)

**Motivo:** em 10/08 o método passo a passo — mockup, parar, implementar uma tela, parar,
reportar — consumiu o dia inteiro e cansou o Richard sem necessidade.

- **Agrupar frentes relacionadas num único ciclo**, em vez de parar entre cada tela.
- **Parar só quando a decisão for realmente dele:** regra de negócio, prioridade, ou
  dado de analista real.
- **Não parar** para confirmar detalhe de implementação, texto de mensagem ou escolha
  técnica — decidir, seguir, e reportar depois.
- **Reportar em bloco no fim**, não a cada etapa.
- **Rodar contra o banco antes de publicar continua valendo** — foi o que pegou os quatro
  defeitos de SQL de 10–11/08, todos invisíveis aos 220 testes com dublê.

Isto NÃO afrouxa a regra de escrita no banco: `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE`
continuam exigindo autorização expressa. O que muda é o ritmo do trabalho, não a permissão.

---

## As três regras do time de agentes (Richard, 13/08/2026)

Valem para **TODOS** os agentes — `orquestrador`, `coder`, `qa-banco`, `revisor` e qualquer
outro que venha depois. Estão repetidas dentro do prompt de cada um; aqui é a fonte.

### 1. NENHUM agente escreve no banco

`INSERT` · `UPDATE` · `DELETE` · `ALTER` · `CREATE` **passam pelo Richard, com o comando na
tela antes**. Sem exceção, sem "é só uma linha", sem dry-run que grava no fim.

**`SELECT` e teste rodam livres** — medir não precisa de autorização, e é medindo que este
projeto acha defeito.

### 2. NENHUM agente decide regra de negócio

Encontrou decisão de **regra** — quem pode fazer a ação, o que fazer quando o dado não
existe, qual o padrão, qual o critério —, **para e pergunta**. Uma escolha do agente viraria
regra do sistema sem ninguém ter decidido.

Decisão **técnica** — nome de função, ordem dos campos, formato do teste, onde extrair a
lib — ele resolve sozinho e segue. Perguntar isso é o passo a passo que o método de 12/08
abandonou.

> A fronteira, na dúvida: **se a resposta muda o que o sistema faz para o analista, é regra.
> Se muda só como o código está escrito, é técnica.**

### 3. NENHUM agente publica

`git commit` e `git push` são do Richard. O agente entrega a árvore de trabalho suja e o
relatório; a publicação sai quando ele mandar, nunca como consequência de "terminou".

### E o orquestrador, em particular

- **Não abre frente que o Richard não pediu.** Achou coisa a fazer? Vira linha em
  Pendências, não tarefa.
- **Não gera sugestão enquanto espera decisão dele.** Parada é parada — não se enche o
  intervalo com alternativas que ninguém pediu.

---

### O auditor, e o que é só dele (16/08/2026)

O `revisor` lê **código**; o **`auditor`** lê **DADO**. Ele confere a base contra as fontes
externas — estoque da CGE, planilhas dos grupos, gabaritos, backups anteriores — e entra
**sempre que uma correção tocar dado em massa**.

⚠️ **ELE NÃO ESCOLHE ENTRE DUAS FONTES.** Quando discordam, mostra as duas, mede o tamanho da
discordância e diz **por que uma seria mais confiável** — e para aí. Escolher por você é
decidir regra de negócio com outro nome.

⚠️ **Nem a planilha nem a base são gabarito por padrão.** O erro tem duas direções, e as duas
já foram medidas: a coluna "Número de PCs" do Grupo 2 está **inflada ~2x** em 44,7% das chaves
(G1 e G3 dão 96% no mesmo banco), e a numeração das parciais **na base** é que estava errada
na migração. Quem "consertar" um lado para bater com o outro sem medir destrói dado bom.

### ⚠️ DUPLA VERIFICAÇÃO — dois agentes, o mesmo número, cegos um ao outro (16/08/2026)

**DOIS agentes medem o MESMO número de forma INDEPENDENTE, sem ver o resultado um do outro.**

- Bateram → segue.
- **Divergiram → a divergência É o achado**, e vem para o Richard antes de qualquer coisa.

⚠️ **Nada de "um mede e o outro confere".** Quem confere já chega sabendo a resposta e tende a
concordar — vira carimbo, não medição. **Foi a medição independente que revelou, em 16/08, as
51 TRs que ninguém tinha visto**, e o `split` de processo que a análise original não mediu
porque só olhou a direção contrária.

⚠️ **E TODA GRAVAÇÃO EM MASSA CONFERE DE NOVO DEPOIS DE GRAVAR**, dentro da MESMA transação,
comparando com o previsto no dry-run — e faz `ROLLBACK` se não bater. Conferir só antes prova
o que se esperava, não o que aconteceu.

---


### ⚠️ A NUMERAÇÃO DAS PARCIAIS — frente ABERTA em 16/08/2026

**Não corrija `parcial_num` sem ler o `SESSAO.md`**, que abre com o estado completo.

O diagnóstico mudou: **a migração carregou o número da CGE CORRETO** (8.998 PCs); quem
estragou foi a **recarga de 05/08**, que apagou 5.716 números e trocou 77 — porque
`recarga_exec.js:214-215` grava `nums[0]`, **o MENOR rótulo** da planilha. O padrão de 87,5%
"numerado por `parcela_seq`" que a auditoria mediu é resíduo da renumeração de 13/08
preenchendo as lacunas que a recarga abriu.

✅ **A PERGUNTA QUE TRAVAVA TUDO FOI RESPONDIDA EM 16/08/2026: SIM.** O SIGEF permite várias
parcelas no mesmo processo SGPe — **113 pares (TR, processo), 78 TRs, 465 PCs**, medidos no
`ESTOQUE FCEE OFICIAL DA CGE.xlsx` por dois agentes cegos um ao outro. **Logo o mapa NÃO parte
processos indevidamente**, e a armadilha 16 foi reescrita. Ver `SPLIT_PROCESSO_2026-08-16.md`.

Consequência já aplicada: o `juntar`/`fusao` saiu da rota do lápis, e as travas de
`corrigir_processo_pc.js`, `resolver_processos_restantes.js` e `renumerar_parcial_num.js`
deixaram de exigir a bijeção. **O `renumerar_parcial_num.js` não pode mais rodar** — o
`GROUP BY tr, processo_pc` dele É a regra refutada.

⚠️ **O bloqueio nº 1 do `SESSAO.md` deixou de ser bloqueio** (o "split", 114 processos): ele
descrevia o dado correto como se fosse dano. **Os outros quatro continuam de pé.**

---

## Padrões de trabalho

- Validar sempre com `node --check` antes de commit.
- No `index.html`, extrair os blocos `<script>` para um arquivo temporário e validar.
- Testar rotas contra o banco antes do push; reverter dados de teste em seguida.
- Nunca commitar CSVs de carga nem scripts com credencial.
- Comunicação com o Richard em português do Brasil.

### O aviso sonoro — `C:\Users\Richard\.claude\avisar.ps1`

Roda ao fim de **toda** resposta, inclusive diagnóstico e pergunta.

```powershell
powershell -File C:\Users\Richard\.claude\avisar.ps1                  # terminou
powershell -File C:\Users\Richard\.claude\avisar.ps1 -Modo problema   # espera decisão
```

⚠️ **SEM VOZ, desde 13/08/2026.** A frase falada saiu por decisão do Richard, e o bloco de
síntese (WinRT, SAPI5 e a queda para a Maria) foi **removido, não comentado** — código que
ninguém chama é código que ninguém revisa. O parâmetro `-Mensagem` deixou de existir.

| modo | som |
|---|---|
| `ok` | **toque de aeroporto**: 880 Hz · 659 Hz · 523 Hz (Lá–Mi–Dó), com 40 ms entre elas |
| `problema` | **6 graves** de 400 Hz — inalterados, e é o único som que interrompe de propósito |

⚠️ **kernel32 `Beep`, NUNCA `[console]::Beep`.** O do console some quando a saída está
redirecionada; o do kernel32 fala com o driver e toca em qualquer contexto — inclusive
chamado de dentro de outro processo, que é como este script sempre roda.

⚠️ **O arquivo é ASCII PURO, de propósito.** O PowerShell 5.1 lê `.ps1` como ANSI quando não
há BOM: um travessão ou um emoji num comentário vira lixo e **quebra o parser**. Não é erro de
exibição — o script inteiro deixa de rodar. Já aconteceu.

---

## Pendências

> Conferida contra o banco em **13/08/2026**. O que está `[x]` foi verificado, não presumido.
> **Estado medido:** 53 usuários (46 analista · 3 coordenador · 3 controle_interno ·
> 1 superadmin) · **2 sem CPF** · 0 aguardando aprovação · 15 senhas provisórias ·
> 14.652 PCs · 3.645 baixadas · **585 no ciclo do C.I., em 114 TRs** · 1.559 TRs · 46 metas
> vigentes.
>
> ⚠️ **O "13 no ciclo do C.I." era falso, e ficou semanas neste documento.** Medido contra o
> banco em 16/08/2026: são **585 PCs em 114 TRs**, todas `na_fila` e todas `baixada = true`.
> E **`ci_mensagem` está VAZIA** — 0 mensagens. O ciclo existe no estado, não na conversa.

### ⚠️ NÃO TESTADO EM NAVEGADOR — o que foi feito em 12–13/08
Nada disto foi clicado por uma pessoa; tudo foi validado por teste e contra o banco. Em 12/08
o Richard achou três defeitos abrindo as telas que os testes não pegaram.

- [ ] **Assumir uma TR** — reescrito em 13/08, e é a ação mais usada. A TR inteira tem de
      aparecer na Minha Planilha, não parte dela. No erro o modal FICA ABERTO.
- [ ] **Devolver a TR ao estoque** — botão no cartão, só superadmin. Conferir as contagens,
      o motivo obrigatório, o "Outro" exigindo descrição, e que **baixada não volta**.
- [ ] **O lápis do processo SGPe** — em 11 telas. Onde não há link, o número sai em âmbar.
      Corrigir e ver o link nascer sozinho.
- [ ] **Cabeçalho do cartão** — "assumida em" e a etiqueta ✨ NOVA (7 dias). Nas TRs antigas
      não aparece nada, e isso é proposital.
- [ ] **Indicador de online** — rótulo e seta. Fechar pelo botão, clicando fora e com **Esc**:
      a seta tem de voltar nos três.
- [ ] **Modo manutenção** — ⚠️ ligar **derruba a equipe na hora**. Testar fora do expediente.
      Conferir: 0 online no cartão, painel vermelho sem formulário, e o link "Acesso do
      administrador" revelando o campo.

### ⚠️ Os 11 processos SGPe que não deram para resolver
Corrigem pelo **lápis**, quando alguém tiver o número certo do SGPe. Detalhe no `SESSAO.md`.

- [ ] **O SGPe não tem o processo** (6): `ADR05 00011020/2017` · `ADR07 1064/2016` ·
      `SDR05 001028/2017` · `SDR13 458/2017` · `fcee 6291/2024` · `fcee 7198/2024`
- [ ] **Nenhuma leitura plausível** (4): `AR355478172` (333 candidatos testados) ·
      `ADR19 0011181.2017` · `ADR 1181/2017` · `ER221202154` (só na coluna mãe)
- [ ] **Ambíguos** (2): `SCC7537` existe em 7 anos · `SCC 6579` em 6. **Escolher seria chutar.**

### Abertura — o que ainda trava
- [ ] **2 sem CPF não conseguem entrar. O login é por CPF.** ids **49 Scheila** (ativa) e
      **52 Eduardo** (também `ativo = false` — duas decisões). Resolve pelo Primeiro Acesso,
      como sete colegas fizeram, ou inserindo o CPF direto.
- [x] ~~Fila de aprovação~~ — **vazia**. Sete mesclagens, duas rejeições, duas aprovações (12/08).
- [x] ~~Modo preparação x Controle Interno~~ — o modo está **desligado**. Se religar, a decisão
      volta: isentar o perfil ou aceitar que os três técnicos fiquem de fora.

### ▶ A PRÓXIMA SESSÃO — ver `SESSAO.md`, que tem o detalhe

- [ ] **⚠️ AUDITORIA: planilhas dos analistas × base do sistema. SÓ LEITURA PRIMEIRO.**
      Vários analistas relatam divergência de **número de PCs** e de **VALORES**. Ainda não
      medido.
      ⚠️ **Não "consertar" o banco para bater com a planilha:** há caso medido em que a
      PLANILHA é que estava errada — a coluna "Número de PCs" do **Grupo 2** está inflada
      (44,7% das chaves com razão 2,0 contra o banco; o gabarito 1.899 saiu dali, e o real é
      ~1.217). G1 e G3 deram 96,4% e 93,1% de razão 1,0 lendo o mesmo banco.
      Medir → separar quem diverge de quanto diverge → levar a lista ao Richard **antes** de
      qualquer `UPDATE`.
- [ ] **Ativar o time de agentes** — os quatro estão em `.claude/agents/`, nada acionado.
- [ ] **As 14 telas que ninguém clicou** — as duas últimas são os dois papéis e o agir pela conta.
- [ ] **3 PCs FINAIS com `parcial_num = '1'`** — `2021TR001689`, `2021TR002133`,
      `2023TR000048`. Um parecer na parcial 1 dessas três baixaria a FINAL junto. Correção de
      DADO, com o comando na tela antes.

### Aberto — precisa de decisão do Richard
- [ ] **Caroline** — meta 27 vigente, **sem usuário em `usuarios`**. É a única nessa situação.
- [ ] **Meta vigente: CGE (Ago/25) ou Monitoramento (Nov/25)** — nunca decidido.
- [ ] **Gustavo: nome completo e portaria.** O cadastro existe (id 56, coordenador, grupo 3),
      mas a assinatura segue comentada no PDF do relatório CGE.
- [ ] **A sua senha** ainda é a antiga, agora em bcrypt. Esteve pública por meses.

### Aberto — trabalho técnico
- [ ] **A fusão de parcelas** está implementada e testada por unidade, mas **nunca foi
      exercitada contra o banco** — não há hoje correção que a dispare. Quando aparecer, o
      caminho é 409 → confirmação → junta e iguala o `parcial_num` na mesma transação.
- [ ] **A camada de autorização** continua sendo o buraco de fundo: quem montar um pedido HTTP
      e se declarar coordenador passa. Preparação e manutenção são **cortina, não tranca**.
- [ ] **11,3 MB por tela** — a compressão resolveu o transporte (−96%), mas seis telas ainda
      baixam o acervo inteiro para filtrar no cliente.
- [ ] `GET /notificacao?destinatario_id=X` não confere se quem pede é o X.
- [ ] `POST /notificacao` com `alvo:'analista'` escapa da conferência de grupo.
- [ ] **Quadro 2 do relatório CGE** lista os 45 servidores? (estava truncando em 5) — nunca
      conferido depois da correção.
- [ ] **Estoque no Quadro 1.** A anotação antiga diz 11.552; o banco tem **11.007 abertas**
      (14.652 − 3.645). Conferir de onde sai o 11.552.
- [x] ~~**Código morto: `confDev` e modal `moDev`**~~ — **RESSUSCITADOS em 13/08/2026.** A
      versão antiga chamava `db.from('estoque').update(...)`, uma rota que **nunca existiu**:
      a TR nunca ficou "Aguard. Dev." porque nada gravava isso. Hoje são o modal e a função do
      pedido de devolução, e gravam em `POST /solicitacao_devolucao`.
      ⚠️ **Continua valendo: não confundir com `moDevM`/`confDevM`**, que é a devolução direta
      do superadmin.
- [ ] **`identidade_sigpc.css` e `logo_sc_base64.js`** (no `sigpc-gt`): nenhum `<script>` ou
      `<link>` os carrega — candidatos a exclusão, **confirmar antes**.
- [ ] **`ZZ TESTE TRAVA`** (analista) continua entrando no sistema. Se não é conta de teste,
      vale olhar quem é.

### Resolvido — não reabrir
- [x] **16 TRs com 2+ analistas** — `SELECT COUNT(DISTINCT tr) WHERE conflito = true` → **0**.
- [x] **6 TRs que não casaram** (`2020 TR000777`, `2022TR 002065`, `2019TR000319`,
      `2021TR000719`, `2021TR000804`, `2024TR000204`) — **nenhuma existe** em
      `prestacoes_contas`. A lista está obsoleta.
- [x] **Gustavo sem cadastro** — existe desde então: id 56, coordenador, grupo 3. A armadilha
      antiga ("Grupo 3 não tem coordenador em `usuarios`") **não vale mais**, mas o
      cai-para-o-superadmin em `notificacao.coordenadoresDoGrupo` fica: protege qualquer grupo
      que venha a ficar sem coordenador.
- [x] **Claudia com meta "—"** — id 36 em `usuarios`, meta 120 vigente. O dado está completo;
      reabrir só se voltar a aparecer no relatório.
- [x] **Notificações internas / sininho** — implementado em 10–11/08. Quatro canais.
- [x] **Tela Produtividade com linhas neutras** — corrigido em 19/07/2026.

### Decisões registradas (não são pendências — são o motivo de o sistema ser assim)
- **`dt_limite_pc` histórico NÃO é prazo — é cálculo em lote. Decisão do Richard, 10/08/2026.**
      Não é defeito a investigar: é dado que não deve ser usado como prazo.
      A prova está na própria distribuição — **29/07/2024** é a `dt_limite_pc` mais recente de
      *todos* os 44 analistas, e as 231 de 2027 caem *todas* em 30/01/2027. Nenhuma PC vence
      entre ago/2026 e jan/2027, num acervo de 4.721.
      **Prazo real só passa a existir quando o analista inserir a data no sistema**, a partir
      da abertura para a equipe.
      Consequência já implementada: `CORTE_PRAZO = '2026-08-01'` em `job_notificacoes.js`.
      O sino não emite prazo sobre o acervo antigo — só sobre data inserida daqui pra frente.
      **Não baixar esse corte** achando que é conservador demais: baixá-lo faz o sino avisar
      sobre datas que ninguém definiu.
- **O C.I. vem DEPOIS do parecer. Decisão do Richard, 13/08/2026.**
      O manual dentro do sistema diz que *"o envio ao CI conta como baixa (CGE 30/04/2026)"*,
      o que sugeriria um caminho alternativo ao parecer. **Não é.** O parecer prévio continua
      exigido, e `POST /parcela/ci` mantém o `'CI exige parecer prévio'` — **não mexer nessa
      trava.** O que estava errado era só a tela: depois do parecer a parcial virava `baixada`
      e o botão do C.I. sumia do cartão, deixando **2.181 parciais** sem caminho para o C.I.
      Corrigido no `index.html` (armadilha 19 de lá), sem tocar em `baixada`, `data_baixa`
      nem `enviado_ci`.
      ⚠️ **Encaminhar ao C.I. é OBRIGATÓRIO** (corrigido pelo Richard no mesmo dia — a
      primeira versão desta linha dizia "opcional", e o texto do botão também). A parcial não
      está pronta quando é baixada: a baixa é o passo do parecer, e o C.I. é o passo seguinte.
      **O que não muda é a baixa** — nem o encaminhamento nem o retorno do C.I. a cancelam.
      ⚠️ **Mas não existe trava nenhuma que exija o encaminhamento** — nem no servidor, nem
      no sino, nem em relatório. Hoje são **2.186 parciais baixadas que nunca foram ao C.I.**,
      e nada avisa. Ver Pendências.
- **Prazo é data civil brasileira, nunca `CURRENT_DATE`.** O Postgres do Railway roda em UTC,
  então `CURRENT_DATE` vira o dia seguinte às 21h de Brasília. Medido em 11/08 às 23h55:
  as **11.033** PCs com prazo mostravam um dia a mais de atraso, e o número voltava de manhã.
  Use `HOJE_BR` de `lib/datas.js`. Há teste que falha se um `CURRENT_DATE` cru voltar.

### E-mails dos analistas — não é pendência de dado
O campo `email` existe e é preenchido (Primeiro Acesso e Meu Perfil, desde 19/07/2026).
O que não existe é **envio** de e-mail — isso é funcionalidade nova, não item em aberto.
