# SIGPC-API — ESTADO EM 13/08/2026

Cole no início do chat novo. Este arquivo é o que basta para retomar.

---

## ⚠️ O SISTEMA ESTÁ ABERTO

Modo preparação **desligado**. Modo manutenção **desligado**. A equipe trabalha.

**Os dois interruptores ficam em Configurações**, em abas separadas. Se ligar a manutenção,
lembre: **ninguém além do superadmin entra** — nem coordenador, nem o Controle Interno.

---

## O QUE FICOU PRONTO EM 12–13/08

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
