# SIGPC-API — ESTADO EM 14/08/2026

Cole no início do chat novo. Este arquivo é o que basta para retomar.

---

## ⚠️ O SISTEMA ESTÁ ABERTO

Modo preparação **desligado**. Modo manutenção **desligado**. A equipe trabalha.

**Os dois interruptores ficam em Configurações**, em abas separadas. Se ligar a manutenção,
lembre: **ninguém além do superadmin entra** — nem coordenador, nem o Controle Interno.

---

## O QUE FICOU PRONTO EM 12–14/08

### 🔒 Modo manutenção — a janela segura de escrita
Antes dele, gravar dependia de pedir no WhatsApp e esperar 30 min de inércia do
`ultimo_acesso`. **Funcionou na primeira: de 3 analistas online para 0.**

⚠️ **São TRÊS mecanismos, e os três são necessários:**
1. `sessao_fim = clock_timestamp()` em todos menos o superadmin, na MESMA transação;
2. **`PATCH /usuarios/:id` recusa quem não é superadmin** — SEM ISTO O ITEM 1 NÃO SEGURA:
   o heartbeat de `onlineCarregar()` bate de 5 em 5 min e ressuscitaria a pessoa na lista;
3. o polling de `config_sistema`, agora de 20 s, derruba a tela de quem está dentro.

⚠️ **O superadmin NÃO bloqueia a janela** — nem no `janela_livre.js`, nem no
`renumerar_parcial_num.js`. Ele nunca é derrubado (de propósito), mas é o mesmo que ligou o
modo e roda o script. **Custou uma recusa real:** um dos dois critérios tinha sido corrigido
e o outro não. **Se houver dois critérios de "pode gravar", eles têm de ser o mesmo.**

```bash
node janela_livre.js            # uma foto
node janela_livre.js --vigiar   # até dar LIVRE
```

### ✅ As parciais foram renumeradas — 1.189 PCs em 70 TRs
`parcial_num` voltou a ser o número do SIGEF em **1.545 das 1.554 TRs**.

⚠️ **NÃO renumerar por `parcela_seq`** — era o caminho escrito aqui e foi **medido e
reprovado**: reescrevia 592 parcelas cujo rótulo veio da planilha do analista, que é o número
do SIGEF. Na própria 704, 44 dos 48 rótulos conferidos mudariam. `parcela_seq` **não é a
ordem do SIGEF**.

O que se fez: **preservar o rótulo da planilha e preencher só a lacuna.**
⚠️ **O gabarito é o `_backup_parcial_num_20260805`. Não apagar.**

9 TRs ficaram de fora, e nenhuma é numeração: 7 têm rótulo acima do total (o SIGEF tem
parcela que a base não tem) e 2 têm o mesmo SGPe em duas grafias.

### ↩ Devolver a TR ao estoque — só superadmin
Existia desde 30/07 e tinha sido **perdida de vista**: em 05/08 a Minha Planilha foi
reconstruída e levou o botão junto. Voltou no cartão da TR, agora com rota transacional,
guarda no servidor e rastro em `parcela_historico`.

⚠️ **PC no ciclo do C.I. BLOQUEIA a devolução** (opção B). E atenção: **as 13 PCs no C.I. são
todas `baixada = true`** — encaminhar ao C.I. já conta como baixa. A primeira versão procurava
C.I. só entre as não baixadas e **a trava nunca disparava**.

### ✎ Corrigir o processo SGPe — em todas as telas
O lápis entrou no `procHtml`, que é usado em 11 pontos: aparece nas onze de uma vez.
`processo_mae` também é editável. **Automático primeiro, manual depois** — o campo de colar
o link só aparece quando mapa + cache + SGPe ao vivo não resolvem.

⚠️ **`origem = 'MANUAL'` é imune ao job**, em DOIS lugares: `montarFila` não o põe na fila e
as três gravações de `lib/sgpe-lote` recusam sobrescrevê-lo.

**Resultado:** `processo_pc` 14.419 de 14.652 com link (98,4%) · `processo_mae` 14.501 (98,9%).

### ✓ Assumir a TR numa transação — o último PATCH-por-PC
Era o mesmo defeito da devolução, e o único lugar que restava. `POST /tr/assumir`.

⚠️ **A trava de limite era conferida a cada PATCH.** Numa TR de 83 PCs, 83 consultas — e
como a PC 1 já contava como assumida, o limite podia estourar no meio e deixar a TR pela
metade. Agora é conferida UMA vez, dentro da transação.

O **nome curto** (`analista_nome` = "Richard", não "Richard Motta Coelho") saiu do
`index.html` e virou `lib/assumir.js`.

### 🔍 Busca global — localizar qualquer TR ou PC numa tela só. SÓ SUPERADMIN.
Menu → bloco Superadmin. Um campo, seis identificadores (TR, PC, NL, processo mãe,
processo da PC, entidade). **Um card por TR, nunca uma linha solta.**

⚠️ **A guarda é da ROTA, não do menu.** `GET /busca_global` devolve o acervo de qualquer
analista — o oposto do recorte por `analista_id` das outras telas. O perfil vem do banco;
coordenador, analista e C.I. levam 403 (conferido em produção).

⚠️ **`tr = ANY(...)`, e não o termo no `WHERE` das agregações** — o defeito de 09/08. Com o
filtro junto, as contagens veriam só as linhas que casaram: a 2019TR000168 tem 20 PCs e
aparecia com 2.

⚠️ **O prazo antigo quase voltou.** O `pg` devolve `date` como **objeto `Date`**, e
`String(d).slice(0,10)` num Date dá `"Thu Mar 31"` — que, comparado como TEXTO contra
`"2026-08-01"`, PASSA no corte. A busca chegou a mostrar **9.221 dias de atraso**. Corrigido
com `paraIso()`. Ver a armadilha 18: é a mesma família de erro do fuso.

**O encaminhamento** sai por `window.print()` (PDF) e `Blob application/msword` (.doc), com o
cabeçalho institucional do CGE. **Sem biblioteca nova** — o `package.json` continua com seis
dependências. Um botão abre a janela com o documento pronto e as duas ações no topo, que
somem no papel.

**A coluna "Código da PC" é dimensionada pela FINAL**: `2018TR000093-PFINAL` tem 19
caracteres contra 12 de `2018PC000015`. `nowrap` na tela e no papel.

⚠️ **"No estoque desde" só nas devolvidas.** Das 795 TRs sem dono, **793 nunca tiveram um** —
para essas não existe "desde quando", e usar a data da carga (18/07, igual para todas) daria
um número que parece resposta e não é.

### 🏛 O botão do C.I. nunca tinha acendido — e agora são TRÊS passos
**O defeito mais caro do dia, e nenhum dos 15 testes pegava.** Sem parecer o botão
"Encaminhar ao CI" ficava cinza; **com** parecer a parcial virava `baixada` e caía no ramo
verde do cartão, **que não desenhava botão nenhum**. Medido: **4.259** parciais no cinza,
**2.181** sem botão, e **zero** encaminhamentos feitos por analista em produção — as 13 PCs
que estão no C.I. entraram pela `migracao_ci` de 05/08, não pela tela.

⚠️ **A trava do servidor NÃO mudou.** `POST /parcela/ci` continua exigindo parecer prévio.
O que se corrigiu foi a tela esconder o botão depois que o parecer existe.

⚠️ **Encaminhar ao C.I. é OBRIGATÓRIO** (decisão do Richard). A primeira versão do texto dizia
"opcional — a parcial já está baixada" e convidava a parar na baixa.

```
Passo 1 de 3  âmbar  registre o parecer para poder baixar   · botão cinza COM o motivo ao lado
Passo 2 de 3  verde  baixada em <data> · parecer: <tipo>    · botão ATIVO
                     FALTA ENCAMINHAR AO CONTROLE INTERNO
Passo 3 de 3  azul   No Controle Interno desde <data> · aguardando retorno há N dias
                     o retorno do CI não cancela a baixa
```

⚠️ **Havia uma SEGUNDA tela com a regra invertida** — o detalhe da TR (o "Ver PCs"):
`!p.baixada && !p.enviado_ci` escondia o botão justamente quando a PC era baixada. E era pior:
gravava por **PATCH de UMA PC** (o encaminhamento é por PARCELA, e há parcela com 7), montava
`baixada`/`data_baixa` **no navegador** com o relógio de quem clicou, e por ser PATCH genérico
**passava por fora da trava do parecer**. As duas telas agora decidem pelo mesmo `pPasso` e
gravam pela mesma rota transacional.

### 🏛 Etiqueta "N sem C.I." na lista — a dívida que ninguém enxergava
Encaminhar é obrigatório e **nada exige**: sem trava no servidor, sem sino, sem relatório. O
cabeçalho da TR agora mostra `🏛 3 sem C.I.` em âmbar — **inclusive na TR "✓ concluída", e
principalmente nela**, que é onde a dívida se perde de vista.

**2.181 parciais em 550 TRs vão nascer com a etiqueta.** A contagem é conferida contra o banco
em `prova_banco_ci.js` — contagem que diverge do banco é pior que contagem nenhuma.

### ↩ O analista PEDE a devolução da TR — e quem devolve é a coordenação
Tabela nova **`solicitacao_devolucao`** (criada em 13/08, com autorização). Botão no cartão da
TR, ao lado do "Ver PCs"; modal com **seis motivos** em lista fechada e justificativa
obrigatória em todos; fila em **Aprovações**, aba nova ao lado de "Vagas extras".

⚠️ **TABELA SEPARADA, e o motivo é medido.** Sete consultas de `lib/limite-tr.js` leem a
`solicitacao_vaga` **sem filtro nenhum** — um pedido de devolução gravado lá viraria +1 no
limite de quem pediu para devolver, reservaria no Estoque a TR que ele quer largar, e seria
consumido como autorização para furar o limite. Nada disso dá erro. **Não fundir as duas.**

⚠️ **A TR continua contando no limite enquanto o pedido está pendente** — o pedido não toca em
`analista_id`. Só a aprovação devolve. Senão qualquer um abriria vaga só pedindo devolução.

⚠️ **DOIS CAMINHOS NA APROVAÇÃO.** Motivo 1 ("já estava em análise por outro antes de
01/08/2026") vai **direto para o analista indicado**, pela `lib/assumir.js` — mandar ao
estoque uma TR que tem destino a entrega a quem chegar primeiro. Os outros cinco vão ao
estoque, pela `lib/devolucao.js`. **O limite NÃO é conferido** na transferência: 29 dos 44
analistas já estão em 6 ou acima, e a trava vale no *ato de assumir*. A carga do indicado
aparece no cartão e quem decide é o coordenador.

⚠️ **Indicado sem cadastro ativo BLOQUEIA** (409) em vez de cair no estoque em silêncio. O
primeiro caso real é a **Caroline** — meta vigente, nenhum cadastro.

⚠️ **O solicitante não decide o próprio pedido.** Exceção: o superadmin, e aí o histórico
ganha `AUTODECIDIDO — quem pediu e quem decidiu sao a mesma pessoa`.

**Provado contra o Postgres em dois ciclos completos, e os dois revertidos por inteiro:**
o índice único (segundo pedido → 409), a segunda decisão (→ 409), a `dt_inicio_analise`
preservada, a baixada que fica no nome de quem baixou, o sino nas duas decisões, e a marca do
autodecidido. **Nada sobrou no banco.**

### 🛠 AGIR pela conta do analista, e os DOIS PAPÉIS do superadmin (14/08)

**O "Ver como analista" deixou de ser leitura.** Sem agir não se dava suporte nenhum.

**Autoria dupla:** `parcela_historico.executado_por` (ALTER de 14/08). `analista_id` é o
**dono**, `executado_por` é **quem clicou**, e fica **NULO quando são a mesma pessoa** — nulo
quer dizer "foi ele mesmo", e o que importa achar é a linha em que os dois diferem.

⚠️ **O `fetch` do `index.html` deixou de BLOQUEAR e passou a CARIMBAR**, trocando DOIS campos:
`analista_id = alvo().id` e `executado_por = U.id`. Trocar só um gravaria a baixa na
produtividade errada. É num ponto só porque são **56 chamadas de escrita** no arquivo.

**10 ações liberadas · 4 travas ficam:** estornar · devolver TR · solicitar devolução ·
decidir no C.I. Não são "leitura" — são decisões **sobre** o trabalho dele. Há teste que falha
se aparecer uma quinta.

**Os dois papéis:** `usuarios.papel_ativo` + tabela `papel_historico`.
`analista` (padrão ao entrar, **14 itens somem do menu**) · `tecnico` (tudo, e o único que
age por outro). O reset ao entrar é do SERVIDOR.

⚠️ **UMA REGRA SÓ, dos dois lados: `perfilEfetivo`.** No papel analista o superadmin **é**
analista em toda parte — 10 pontos no servidor, e o menu recebe o usuário já com o perfil
efetivo. Resolve sozinho o ponto que passaria batido: as **seis rotas de "coordenador OU
superadmin"**, onde tirar só o `superadmin` da lista não bastaria, porque ele não é
coordenador de ninguém.

⚠️ **Quatro rotas liam o `perfil` do CORPO** — excluir usuário, excluir no repositório e os
dois estornos. Passaram a ler do banco.

**Provado contra o Postgres, os dois revertidos:** autoria dupla 11/11 (dono 18 + executor 4
gravados; analista mandando `executado_por` → 403) e papel 14/14 (no papel analista a busca
global e a prévia da devolução → 403; depois da troca, respondem).

### 👁 "Ver como analista" — o botão morto pintado de vivo
O `vcOff()` mandava a opacidade num **segundo atributo `style=`**, e o HTML fica com o
primeiro: os sete botões do modo apareciam com a cor inteira e **não respondiam ao clique**.
Quem pinta agora é o CSS (`.btn-acao:disabled`). **Eles nunca gravaram** — são três travas:
o `disabled`, a conferência dentro das funções, e o `window.fetch` envolvido, que bloqueia
todo não-GET para a API (menos o logout).

A faixa dizia *"no nome dela"* e supunha o gênero de quem estava sendo visto. Agora é
**"no nome deste analista"**.

---

## ⚠️ OS 11 PROCESSOS SGPe QUE FICARAM PENDENTES

**Resolvem pelo lápis, quando alguém tiver o número certo do SGPe.**

**O SGPe responde que NÃO TEM o processo** (6 textos):
```
ADR05 00011020/2017   21 PCs      ADR07 1064/2016      21 PCs
SDR05 001028/2017     21 PCs      SDR13 458/2017       21 PCs
fcee 6291/2024         7 PCs      fcee 7198/2024        1 PC
```

**Nenhuma leitura plausível existe** (4 textos):
```
AR355478172           21 PCs   333 candidatos testados, nenhum confirma
ADR19 0011181.2017    19 PCs   só ADR19 1181/2017 existe — e é de OUTRA TR
ADR 1181/2017         19 PCs   "ADR" sem o número da regional
ER221202154            4 PCs   só na coluna mãe; "ER" fora do mapa de 183
```

**AMBÍGUOS — vários anos confirmam** (2 textos):
```
SCC7537    2 PCs   existe em 2017, 2019, 2020, 2021, 2022, 2023 e 2024
SCC 6579   1 PC    existe em 2020, 2021, 2022, 2023, 2024 e 2025
```

⚠️ **Estes dois quase entraram por engano.** A primeira versão testou UM ano — o da TR —,
confirmou, e ia corrigir como se fosse certeza. **Um candidato só esconde a ambiguidade em
vez de revelá-la.** Link para o processo errado não dá erro na tela: ninguém percebe.

---

## AS LIÇÕES QUE CUSTARAM CARO EM 13/08

**1. Confirmar no SGPe e não gravar no cache deixa o texto certo e a tela SEM LINK.**
Foi o estado em que as correções ficaram até se perceber. O cache é o que faz o link existir.

**2. A conferência de fusão dava alarme falso** na coluna mãe e nos textos já corretos: ela
pergunta se o `processo_pc` da TR já tem aquele valor — e tem, porque é o da própria PC.
Fusão só existe para `processo_pc`, e nunca quando `de` é igual a `para`.

**3. Validação que compara com backup antigo acusa o que rodadas anteriores fizeram de
propósito.** Compare com uma **foto do início da rodada**.

**4. `AT TIME ZONE` sozinho está errado para coluna `timestamp` que guarda UTC.** Mostrou
03:31 às 21:31. O certo são dois passos:
`(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`.

**5. Um `kill` pode não pegar.** Uma rodada que mandei parar seguiu até o fim e só notificou
depois. Não causou dano porque era dry-run, mas foi sorte de sequência. **Confirme que o
processo morreu antes de seguir.**

---

## COMO TESTAR

```bash
npm run teste     # 16 suítes, sem rede e sem banco
node --check server.js lib/*.js
```

⚠️ **Antes de publicar, rode contra o banco.** Foi o que pegou todos os defeitos de 10–13/08,
inclusive a trava do C.I. que nunca disparava — invisível para o dublê.

⚠️ **Nunca teste função que abre a própria transação de dentro de outra** (regra 11).

## O QUE ESTÁ NO AR

`sigpc-api` e `sigpc-gt` — `main` e `feature/baixa-por-parcial` iguais nos dois.
**Produção roda da `feature` na API; o GitHub Pages publica da `main`.** Publique nas duas.

## BACKUPS DE 12–13/08 — não apagar

```
_backup_parcial_num_20260805     ← o GABARITO dos números do SIGEF
_backup_parcial_num_20260813     ← antes da renumeração
_backup_parcela_historico_20260813
_backup_processo_pc_20260813     ← antes da correção dos processos
_backup_processo_20260813b       ← antes da rodada final
```

## ⚠️ O QUE O RICHARD IA TESTAR NA TELA (13/08, fim da manhã)

Ele ficou de abrir os três primeiros e avisar o que encontrasse. **Se este chat é novo,
pergunte o resultado antes de mexer nessas telas.**

1. **Assumir uma TR** — a mais usada, e reescrita em 13/08. A TR **inteira** tem de aparecer
   na Minha Planilha, não parte dela. No erro o modal fica aberto com o motivo.
2. **Devolver a TR ao estoque** — ✅ **ELE TESTOU, E FUNCIONOU.** Há duas devoluções reais no
   histórico: `2020TR001601` e `2020TR001599`, ambas com motivo "TESTE DO SISTEMA", 2 PCs
   cada. As duas estão livres no estoque — se ele quiser desfazer, é só reassumir.
3. **O lápis do processo SGPe** — em 11 telas; âmbar onde não há link.
4. **A busca global** — nunca aberta. É a tela mais nova.
5. **Modo manutenção** — ficou para o **fim do expediente**: ligar derruba a equipe na hora.

Faltam também, com menos risco: o cabeçalho do cartão ("assumida em" + ✨ NOVA) e a seta do
indicador de online (fechar pelo botão, clicando fora e com Esc).

**E o que entrou depois, à tarde — nada disso foi clicado por uma pessoa:**

6. **Os três passos da parcial.** O caso direto é o do **Rafael**: `2020TR001230` e
   `2021TR000777`. A faixa verde tem de **cobrar** "falta encaminhar ao Controle Interno", e o
   botão azul ao lado tem de estar **ativo**. Se ele encaminhar, a parcela pula para o passo 3
   — seria **o primeiro encaminhamento feito pela tela na história do sistema**.
7. **A etiqueta `🏛 N sem C.I.`** no cabeçalho da TR, na lista. 550 TRs a têm.
8. **O detalhe da TR ("Ver PCs")** — o "Enviar ao CI" agora aparece nas PCs **baixadas**, e o
   `title` avisa que vai a parcela inteira.
9. **"Ver como analista"** — os botões nascem apagados **de verdade** agora.
10. **O modal do limite atingido** — faixa `#C62828`, o "Assumir" sai da tela, o pedido vira
    botão de largura total. ⚠️ **O print nunca chegou** — se ele mandar, ajustar só `limiteAviso`.
11. **⚠️ Solicitar devolução, ponta a ponta.** O botão no cartão, o modal dos seis motivos, e
    a fila em Aprovações. **O caminho do MOTIVO 1 — a transferência direta — só foi provado
    por unidade**: os dois ciclos reais usaram o motivo 4, que vai ao estoque. Para exercitar
    o 1 é preciso indicar alguém com cadastro ativo.
12. **A etiqueta `🏛 N sem C.I.`** — 550 TRs a têm.
13. **⚠️ Os dois papéis.** Entre normalmente: você nasce **analista**, e as telas de
    coordenação e superadmin **não estão lá**. A caixa fica no pé do menu → "🛠 Virar técnico
    do sistema" → o menu cresce e a faixa azul aparece no topo.
14. **⚠️ Agir pela conta de um analista** (só no papel técnico). Confira no console do
    navegador a linha `[agir como] POST /parcela/... · dono X · executor 4` a cada escrita —
    se ela não aparecer, o carimbo não pegou. E confira no histórico da parcela que o
    trabalho ficou no nome dele.

---

## ⚠️ O QUE AINDA NÃO CHEGOU

O **print do mockup** e o **modelo do documento em PDF** que o Richard ia colar na pasta.
Procurados nos dois repositórios em 13/08: não estão lá. O layout do encaminhamento seguiu a
especificação escrita dele e o cabeçalho do relatório CGE. **Quando o modelo chegar, ajustar
SÓ o documento** () — a busca e o card não mudam.

---

## O QUE FALTA

- [ ] **Os 11 processos SGPe** acima — pelo lápis, com o número do SGPe em mãos.
- [ ] **`ZZ TESTE TRAVA`** continua entrando no sistema. Se não é conta de teste, olhar.
- [ ] **A fusão de parcelas** está implementada e testada por unidade, mas **nunca foi
      exercitada contra o banco** — não há hoje correção que a dispare.
- [ ] **Scheila (49)** e **Eduardo (52)** — sem CPF, não entram. Eduardo também inativo.
- [ ] **A sua senha** ainda é a antiga, agora em bcrypt. Esteve pública por meses.
- [ ] **A camada de autorização** continua sendo o buraco de fundo: quem montar um pedido
      HTTP e se declarar coordenador passa. Preparação e manutenção são cortina, não tranca.
- [ ] **11,3 MB por tela** — seis telas ainda baixam o acervo inteiro para filtrar no cliente.

### O que ficou parado esperando o Richard

- [x] ~~Solicitar devolução de TR pelo analista~~ — **PRONTO em 13/08.** Ver a seção própria
      acima. Falta só **clicar na tela**.
- [ ] **3 PCs FINAIS com `parcial_num = '1'`** — `2021TR001689` (Grazielly), `2021TR002133`
      (Richard) e `2023TR000048` (Elisandra). A FINAL ficou agrupada junto da parcial 1, e
      como toda rota grava por `WHERE tr = ... AND parcial_num = ...`, **um parecer na parcial
      1 dessas três baixaria a FINAL junto**. É correção de DADO, não de código.

### O time de agentes está pronto na gaveta
`.claude/agents/` tem os quatro — `orquestrador`, `coder`, `qa-banco`, `revisor` — e o fluxo
está em `TIME_AGENTES.md`. **Nada foi ativado.** As três regras do Richard (13/08) estão no
`CLAUDE.md` e repetidas dentro do prompt de cada um: nenhum agente escreve no banco, nenhum
decide regra de negócio, nenhum publica.
