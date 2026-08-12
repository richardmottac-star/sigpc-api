# SIGPC-API — ESTADO EM 12/08/2026

Cole no início do chat novo. Este arquivo é o que basta para retomar.

---

## ⚠️ O QUE ESTÁ LIGADO AGORA, E O QUE ISSO IMPEDE

**O MODO PREPARAÇÃO ESTÁ LIGADO.** Enquanto estiver, **nenhum analista trabalha** — eles
entram, trocam a senha e param numa tela restrita com o Meu Perfil.

⚠️ **Os três técnicos do Controle Interno TAMBÉM ESTÃO BARRADOS.** Só superadmin e
coordenador são isentos (`ISENTOS` em `lib/preparacao.js`). Se eles forem começar, ou você
desliga o modo em Configurações → Modo preparação, ou se acrescenta `controle_interno` à
lista de isentos. **Decisão pendente.**

Desligar abre o sistema para todos de uma vez, e quem estiver com a tela aberta entra
sozinho em até 1 minuto.

---

## ESTADO DO BANCO — medido em 12/08 ao fim do dia

| | |
|---|---|
| usuários | **54** · 52 ativos · **1 aguardando aprovação** |
| perfis | 47 analista · 3 coordenador · **3 controle_interno** · 1 superadmin |
| senhas | 24 em bcrypt · **30 ainda provisórias** |
| **sem CPF** | **7** — ids 5 Nayara, 7 Aline, 11 Daniela, 17 Marisa, 30 Miriam, 49 Scheila, 52 Eduardo |
| PCs | 14.652 · 3.619 baixadas · 13 no Controle Interno |
| fila do CI | 13 PCs `na_fila`, em 6 encaminhamentos · `ci_mensagem` vazia |

**O pendente é o id 66, Daniela Tavares Fiorentin** — autocadastro com aviso FORTE de
duplicidade contra a **id 11 Daniela (200 PCs, 167 baixas)**. **Não mesclei**: você
autorizou três mesclagens e esta apareceu depois. O botão está na fila, testado.

---

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

**Três mesclagens feitas** (o cadastro antigo é o que fica, sempre):

| novo | → antigo | copiado |
|---|---|---|
| 65 Franciani Mary Daniel Pereira | **12 Franciani** (111 PCs) | CPF, e-mail, telefone |
| 60 Marlene Teodoro Ramos da Silva | **46 Marlene** (48 PCs) | CPF, e-mail, telefone |
| 61 Ana Letícia Wloch de Oliveira | **23 Ana Leticia** (147 PCs) | CPF, e-mail, telefone |

**Duas aprovações:** **22 Ana Claudia** (106 PCs) e **24 Elisandra** (210 PCs) — estavam
presas na fila desde 14/06 e não tinham duplicata.

### Menu em três blocos, e o Online agora no cabeçalho
Ver o `CLAUDE.md`. `SB_BLOCOS` + `SB_ITENS` no `index.html` são a fonte única.

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
- [ ] **Modo preparação x Controle Interno** — desligar o modo, ou isentar o perfil.
- [ ] **A Daniela (66)** — mesclar em 11 ou aprovar como conta nova.
- [ ] **7 usuários sem CPF** não conseguem entrar (o login é por CPF). A Franciani, a Marlene
      e a Ana Letícia resolveram pelo Primeiro Acesso — os outros podem fazer igual.
- [ ] **Eduardo (52)** — inativo. Entra ou não?
- [ ] **A sua senha** ainda é `704342`, agora em bcrypt. Esteve pública por meses; troque em
      Meu Perfil.

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
