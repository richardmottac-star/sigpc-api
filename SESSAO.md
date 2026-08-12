# SIGPC-API — ESTADO EM 12/08/2026

Cole no início do chat novo. Este arquivo é o que basta para retomar.

---

## ⚠️ O SISTEMA ESTÁ ABERTO

**O modo preparação foi DESLIGADO em 12/08** — a equipe trabalha normalmente. O
interruptor continua em Configurações → Modo preparação, e ligá-lo de novo devolve todos
os analistas à tela restrita em até 1 minuto, sem ninguém recarregar nada.

⚠️ Se ligar de novo, lembre: **os três técnicos do Controle Interno também são barrados**.
Só superadmin e coordenador são isentos (`ISENTOS`, em `lib/preparacao.js`).

## ESTADO DO BANCO — medido em 12/08 ao fim do dia

| | |
|---|---|
| usuários | **53** · **51 conseguem entrar** · 0 aguardando aprovação |
| perfis | 46 analista · 3 coordenador · **3 controle_interno** · 1 superadmin |
| senhas | **17 ainda provisórias** — as demais já foram trocadas |
| **sem CPF** | **2** — ids **49 Scheila** e **52 Eduardo** (este também inativo) |
| PCs | 14.652 · 3.619 baixadas · 13 no Controle Interno |
| fila do CI | 13 PCs `na_fila`, em 6 encaminhamentos · `ci_mensagem` vazia |

**A fila de aprovação está VAZIA.** Sete autocadastros foram resolvidos hoje: **cinco
mesclagens** (Franciani→12, Marlene→46, Ana Letícia→23, Daniela→11, Aline→7, Marisa→17,
Miriam→30 — sete, na verdade), **duas rejeições** (Graciane 70 e Marlene 71, com CPF
inválido) e **duas aprovações** (Ana Claudia 22 e Elisandra 24, que não tinham duplicata e
estavam presas desde 14/06).

⚠️ **Os dois que faltam não dependem de código:**
- **Scheila (49)** — sem CPF. Resolve pelo Primeiro Acesso, como sete colegas fizeram, ou
  você insere direto como fez com a Nayara.
- **Eduardo (52)** — sem CPF **e inativo**. Precisa das duas decisões.

---

---

## ⚠️ O `parcial_num` NÃO É O NÚMERO DA PARCIAL DO SIGEF (13/08/2026)

**Conferido no SIGEF pela analista, nas duas TRs:**

| TR | SIGEF | nosso sistema |
|---|---|---|
| 2020TR000637 | **1 a 19, contínuo** | 20 parciais, lacunas em 6, 7, 8, 16, 18, indo até **25** |
| 2020TR000704 | **1 a 57, contínuo** | 57 parciais, **sem a 1** e sem a 30, indo até **59** |

### De onde veio o número — está escrito no próprio script

`backfill_parcial_num.js`, de 05/08, no cabeçalho:

> *"a numeração atribuída aqui NÃO vem da planilha do analista; é derivada de `parcela_seq`.
> Pode divergir do número que o analista conhece."*

O campo tem **duas origens**:

1. **As baixadas** receberam número na recarga de 05/08, vindo da planilha.
2. **As pendentes** foram numeradas por esse backfill, que — nas palavras do próprio código —
   numera *"continuando a partir do maior número já existente naquele TR"*.

**É isso que produz as lacunas e os números acima do total.** A parcela que não tinha PC
baixada ficou sem número na recarga e depois recebeu 20, 21, 22… em vez do número real.

**Prova:** as parciais acima do total do SIGEF são **todas não baixadas** — 9 de 9 na 637,
2 de 2 na 704.

### O que está certo, e o que está errado

| | |
|---|---|
| **A CONTAGEM está certa** | agrupar por `parcial_num` ou por `processo_pc` dá o mesmo em **1.552 das 1.554 TRs** |
| **A NUMERAÇÃO está errada** | **60 TRs** têm `parcial_num` acima do total de parciais |
| 704 | 57 grupos = 57 do SIGEF ✓ — só os rótulos estão trocados |
| 637 | 20 grupos ≠ 19 do SIGEF — sobra uma, e é a do `processo_pc = '-1'` |

### `parcela_seq` não é o número da parcial

É sequência **por PC**, não por parcela: 1..44 na 637 (que tem 19 parcelas) e 1..83 na 704
(57 parcelas). Limpa, sem lacuna e sem repetição — mas conta outra coisa.

**O que ela serve:** dar a ORDEM. Renumerar os grupos por `parcela_seq` produziria 1..N
contínuo, que é a forma do SIGEF.

### A regra que o backfill assumiu, e que se confirma

**Uma parcial = (tr, processo_pc).** O SGPe é o identificador da parcela; as várias PCs de
uma parcela compartilham o mesmo processo. Agrupar por SGPe dá o mesmo número que agrupar
por `parcial_num` em 1.552 TRs — os dois caminhos concordam.

### O que NÃO fazer

⚠️ **Não apagar a "parcial 51" da 704.** Ela é a PC `2020PC000474`, `parcela_seq = 1` — a
primeira PC da TR, que deveria ser a parcial 1. Apagá-la apagaria a parcial 1.

⚠️ **Não confiar no `parcial_num` para conversar com o analista.** Ele não é o número que
está no SIGEF. Enquanto não for renumerado, a referência é o **processo SGPe**.

⚠️ **E isto põe em dúvida a leitura das 79 PCs com `processo_pc = '-1'`.** Se `parcial_num`
veio errado, um campo ruim não prova linha inventada. A conferência dos analistas contra o
SIGEF passa a ser indispensável — ver `pcs_sgpe_-1.csv`.

### O caminho, quando for a hora

Renumerar `parcial_num` por TR, na ordem de `parcela_seq`, agrupando por `processo_pc`:
1..N contínuo. Resolve os rótulos das 60 TRs. **Não resolve** a PC a mais da 637, que é
outro problema (dado, não numeração).

⚠️ Existe backup da numeração anterior: `_backup_parcial_num_20260805`.

## O QUE FOI FEITO EM 12/08

### Controle Interno virou perfil, com fila, conversa e duas saídas
`ci_mensagem` (conversa por PC) + `ci_situacao`/`ci_rodada`/`ci_encerrado_em`/`ci_encerrado_por`.
Rotas `GET /ci/fila`, `GET /ci/mensagens`, `POST /ci/decidir`, `POST /ci/responder`.

- **`enviado_ci` continua sustentando a baixa**; `ci_situacao` diz onde está no ciclo. Antes
  uma coluna só respondia as duas perguntas, e devolver apagava a passagem pelo CI.
- **A baixa nunca é tocada** em nenhum caminho — há teste que lê o código e falha se um
  UPDATE do ciclo mencionar `baixada`, `data_baixa` ou `enviado_ci`.
- **A rodada sobe só na devolução**, e vai no `ref_id` da notificação: sem ela a segunda
  volta não avisaria ninguém (lição do `num_diligencia`).
- **Uma notificação por parcela**, não por PC — a parcela de 7 PCs mandaria 7 avisos iguais.

### Três técnicos criados
ids **62 Marcia Terezinha Miranda · 63 Atemilson Bispo dos Santos · 64 Sirene Wolf dos
Santos**. Perfil `controle_interno`, FCEE, sem grupo, `meta_mensal = 0`, senha `Sigpc@2026`
provisória.

### Duplicidade de cadastro
`lib/duplicata.js` + `GET /usuarios/pendentes` + `POST /usuarios/mesclar`.
Primeiro Acesso passou a **recusar CPF que já existe**, em qualquer estado.

**Quatro mesclagens feitas** (o cadastro antigo é o que fica, sempre):

| novo | → antigo | copiado |
|---|---|---|
| 65 Franciani Mary Daniel Pereira | **12 Franciani** (111 PCs) | CPF, e-mail, telefone |
| 60 Marlene Teodoro Ramos da Silva | **46 Marlene** (48 PCs) | CPF, e-mail, telefone |
| 61 Ana Letícia Wloch de Oliveira | **23 Ana Leticia** (147 PCs) | CPF, e-mail, telefone |
| 66 Daniela Tavares Fiorentin | **11 Daniela** (200 PCs) | CPF, e-mail, telefone |

**Duas aprovações:** **22 Ana Claudia** (106 PCs) e **24 Elisandra** (210 PCs) — estavam
presas na fila desde 14/06 e não tinham duplicata.

### Menu em três blocos, e o Online agora no cabeçalho
Ver o `CLAUDE.md`. `SB_BLOCOS` + `SB_ITENS` no `index.html` são a fonte única.

### Modo "VER COMO" — só superadmin
Enxergar o sistema com os dados de um analista, em leitura. Minha Planilha, Meus pedidos,
Produtividade e Dashboard passam a mostrar os dados dele.

⚠️ **A garantia não é o botão cinza — é a trava no `fetch`.** `U.id` alimenta leitura e
escrita com a mesma sintaxe, em 59 caminhos de escrita; desabilitar botão a botão erra um, e
o que errar grava uma baixa no nome de outro. Como o `db.from()` também sai por `fetch`,
existe um ponto só: com o modo ligado, **nada que não seja GET sai do navegador**. A única
exceção é o `logout`.

⚠️ **`U` nunca é trocado.** O alvo vive em `_verComo`, e `alvo()` só é chamado nas LEITURAS.

Além da trava, **onze funções recusam na origem** (`planNovaAnotacao`, `pAbrirSit`,
`pAbrirPar`, `pEstornar`, `pRespondeu`, `pEnviarCI`, `pCiResponder`, `salvarAnotacao`,
`excluirAnotacao`, `ciDecidir`, `assumirTR`) — senão o modal abre, a pessoa preenche, clica,
e só então descobre. E o menu encolhe: só o bloco do analista, **sem Estoque e sem Estornar**,
que existem para agir e não mostram dado de ninguém.

### Quem está online sabe de logout
Coluna `sessao_fim`. Online = esteve ativo em 30 min **e** não encerrou depois disso.
⚠️ O logout usa `clock_timestamp()`, não `NOW()`: o `NOW()` é o instante da **transação**, e
com ele os dois carimbos saíam iguais — a pessoa ficava fora da lista mesmo tendo voltado.

---

## AS QUATRO ARMADILHAS QUE CUSTARAM CARO HOJE

Todas viraram teste. As duas primeiras viraram regra no `CLAUDE.md` (11 e 12).

**1. Testar contra o banco real função que gerencia a própria transação.**
O `COMMIT` interno confirma a transação externa e o `ROLLBACK` não desfaz nada. Gravou 7 PCs
como `encerrado` e 14 mensagens em produção. Restaurado.

**2. `WHERE` de reversão por condição derivada.**
Reverter com `ci_rodada <> 1` pegou as 14.639 PCs que tinham o padrão `0`. **De 7 linhas para
14.639.** Sempre por lista explícita de chaves, capturada antes.

**3. Ordem de rota no Express.**
`/usuarios/pendentes` foi declarada depois de `/usuarios/:id` e caía nela com id
`"pendentes"` → `invalid input syntax for type integer` → **HTTP 500 em produção**. O dublê
não pega: **dublê não roteia**.

**4. `UNIQUE (cpf)` e a ordem da mesclagem.**
Copiar o CPF para a conta antiga antes de apagar a nova deixa as duas com o mesmo CPF por um
instante → `duplicate key`. **Apaga primeiro, copia depois.** O dublê não pega: dublê não tem
restrição de unicidade.

**A lição comum às quatro:** o dublê de banco valida a forma, não a realidade. O que pegou
todas foi rodar contra o Postgres — ou, no caso da rota, subir o Express de verdade.

---

## O QUE FALTA, E DE QUEM DEPENDE

### Depende de você
- [ ] **Scheila (49)** — sem CPF, não entra. Primeiro Acesso ou inserção direta.
- [ ] **Eduardo (52)** — sem CPF **e** inativo. Duas decisões.
- [ ] **A sua senha** ainda é `704342`, agora em bcrypt. Esteve pública por meses; troque em
      Meu Perfil.
- [ ] **Se religar o modo preparação**, decidir se o Controle Interno fica isento.
- [x] ~~Fila de aprovação~~ — **vazia**. Sete mesclagens, duas rejeições, duas aprovações.
- [x] ~~Grazielly e Nayara~~ — resolvidas: senha e CPF.

### Não testado em navegador
- [ ] **Modo "ver como"** e **lista de online** — validados por teste e pelo arquivo servido,
      não clicando. O Richard achou três defeitos testando na tela em 12/08, todos
      corrigidos; é sinal de que vale abrir as telas.

### Técnico
- [ ] **A camada de autorização** continua sendo o buraco de fundo: quem montar um pedido
      HTTP e se declarar coordenador passa. O modo preparação é cortina, não tranca.
- [ ] **11,3 MB por tela** — a compressão resolveu o transporte (−96%), mas seis telas ainda
      baixam o acervo inteiro para filtrar no cliente.
- [ ] `GET /notificacao?destinatario_id=X` não confere se quem pede é o X.
- [ ] `POST /notificacao` com `alvo:'analista'` escapa da conferência de grupo.

---

## COMO TESTAR

```bash
npm run teste     # 11 suítes, 481 testes, sem rede e sem banco
node --check server.js lib/*.js
```

⚠️ **Antes de publicar, rode contra o banco** — foi o que pegou os oito defeitos de 10–12/08,
todos invisíveis para o dublê.

⚠️ **Nunca teste função que abre a própria transação de dentro de outra** (regra 11).

## O QUE ESTÁ NO AR

`sigpc-api dcb7680` · `sigpc-gt` — `main` e `feature/baixa-por-parcial` iguais nos dois.
**Produção roda da `feature`**; publicar só na `main` não publica.

⚠️ **O Railway travou um deploy hoje** e ficou 15 min servindo a versão anterior. Não era o
código — o redeploy pelo painel resolveu. Se `GET /ci/fila` voltar 404, é isso.
