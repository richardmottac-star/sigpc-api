# MODO MANUTENÇÃO — mockup para aprovação

**Nada implementado. Nada gravado.** Este arquivo é o desenho; a implementação espera sua ordem.

---

## 1. Manutenção ≠ preparação

Reaproveito a estrutura (tabela `config_sistema`, rota `PATCH /config_sistema`, o polling de
60 s, a aba em Configurações). A **regra** é outra:

| | preparação | **manutenção** |
|---|---|---|
| o analista **entra**? | sim | **não** |
| onde ele para | tela restrita, com Meu Perfil | **tela de login**, com o recado |
| quem é isento | superadmin **e coordenador** | **só superadmin** |
| C.I. | barrado (efeito colateral) | **barrado de propósito** |
| quem já está dentro | vira tela restrita | **cai a sessão** |
| efeito no "online" | nenhum | **zera na hora** |
| para que serve | equipe não mexer antes da hora | **janela segura de escrita** |

⚠️ Os dois interruptores são **independentes**. Ligar manutenção não mexe em preparação.
Se os dois estiverem ligados, manutenção vence (é a mais restritiva).

---

## 2. As telas

### 2.1 Configurações → aba nova "Modo manutenção"

```
┌─ Configurações ─────────────────────────────────────────────────────────┐
│  Limite de TRs  │  Modo preparação  │ ▎Modo manutenção                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  ✅ Sistema ABERTO                    [ Entrar em manutenção ]    │  │
│  │                                                                   │  │
│  │  Todos usam o sistema normalmente.                                │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─ Mensagem que aparece no login ───────────────────────────────────┐  │
│  │  Máximo de 400 caracteres.                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │ Estamos ajustando a numeração das parciais. O sistema volta │  │  │
│  │  │ em cerca de 15 minutos. Nenhum trabalho seu será perdido.   │  │  │
│  │  └─────────────────────────────────────────────────────────────┘  │  │
│  │                                            [ ✓ Salvar mensagem ]  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  O que acontece quando você liga:                                       │
│  · 9 pessoas online agora são DESLOGADAS na hora — a sessão cai;        │
│  · quem tentar entrar vê a sua mensagem e não passa do login;           │
│  · você continua entrando normalmente;                                  │
│  · ao desligar, todos voltam a entrar sem você fazer mais nada.         │
└─────────────────────────────────────────────────────────────────────────┘
```

Ligado, o cartão de cima troca de cor e de texto:

```
  ┌───────────────────────────────────────────────────────────────────┐
  │  🔒 EM MANUTENÇÃO — desde 12/08 21:52          [ Reabrir agora ]  │
  │                                                                   │
  │  Ninguém além de você entra. 0 pessoas online.                    │
  │  Ligado por Richard Motta Coelho.                                 │
  └───────────────────────────────────────────────────────────────────┘
```

⚠️ O **"0 pessoas online"** é lido de verdade, do `GET /usuarios/online` — é a confirmação
visual de que a janela abriu. Se aparecer número diferente de zero, algo não funcionou e
você vê na hora, em vez de descobrir pelo `janela_livre.js`.

### 2.2 Quem tenta entrar

```
┌──────────────────────────── SIGPC-GT ───────────────────────────────┐
│                                                                     │
│                              🔒                                     │
│                                                                     │
│                    Sistema em manutenção                            │
│                                                                     │
│      Estamos ajustando a numeração das parciais. O sistema          │
│      volta em cerca de 15 minutos. Nenhum trabalho seu será         │
│      perdido.                                                       │
│                                                                     │
│      ┌───────────────────────────────────────────────────────┐      │
│      │  CPF     [ ___________ ]                              │      │
│      │  Senha   [ ___________ ]        [ Entrar ]            │      │
│      └───────────────────────────────────────────────────────┘      │
│                                                                     │
│      Esta tela sai sozinha quando o sistema voltar.                 │
└─────────────────────────────────────────────────────────────────────┘
```

O formulário **continua na tela** — é assim que você entra. Quem não é superadmin digita,
clica e recebe a recusa do servidor com a sua mensagem. Esconder o formulário trancaria
você para fora junto.

### 2.3 Quem já estava dentro

Sem susto e sem tela branca:

```
   ┌─────────────────────────────────────────────────────┐
   │  🔒  O sistema entrou em manutenção                 │
   │                                                     │
   │  A sua sessão foi encerrada. Nada do que você       │
   │  gravou foi perdido.                                │
   │                                                     │
   │  Estamos ajustando a numeração das parciais.        │
   │  O sistema volta em cerca de 15 minutos.            │
   │                                                     │
   │                                    [ Entendi ]      │
   └─────────────────────────────────────────────────────┘
```

Ao fechar, cai na tela de login (2.2).

---

## 3. Como o "desloga na hora" funciona de verdade

São **três** mecanismos, e os três são necessários. Isto é o miolo do desenho.

### (a) O carimbo — `sessao_fim = clock_timestamp()`

Ligar o modo grava, em todos que não são superadmin:

```sql
UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE perfil <> 'superadmin'
```

Como "online" é `ultimo_acesso >= agora−30min AND (sessao_fim IS NULL OR sessao_fim <
ultimo_acesso)`, o carimbo derruba todo mundo **na mesma transação em que o modo liga**.

⚠️ `clock_timestamp()`, não `NOW()` — mesma armadilha do logout de 12/08: o `NOW()` é o
instante da transação, e carimbos iguais fariam `sessao_fim < ultimo_acesso` não valer.

### (b) A trava do heartbeat — **sem isto, (a) não segura**

Este é o ponto que quase passou batido.

O navegador de cada analista roda `onlineCarregar()` **de 5 em 5 minutos**, e a primeira
coisa que ela faz é `PATCH /usuarios/:id` com `ultimo_acesso = agora`. Ou seja: o carimbo de
(a) dura até o próximo heartbeat de qualquer aba aberta. Aí `ultimo_acesso` volta a ser maior
que `sessao_fim` e **a pessoa reaparece online** — e o `janela_livre.js` volta a dizer
OCUPADO, sem ninguém ter feito nada.

Então `PATCH /usuarios/:id` passa a **recusar quem não é superadmin** enquanto o modo estiver
ligado. Com a rota fechada, o carimbo não se desfaz e o zero é estável.

### (c) A queda da sessão — o polling que já existe

O `prepIniciar()` já consulta `GET /config_sistema` de 60 em 60 s. Passa a ler também o modo
manutenção; ao vê-lo ligado, mostra o aviso 2.3 e chama `sair()` — que já avisa o servidor e
limpa o `localStorage`.

**Proponho baixar esse polling de 60 s para 20 s.** Custa três vezes mais uma chamada que
devolve uma linha, e encurta de 1 min para 20 s a janela em que alguém ainda está clicando.

**Somando:** o online zera no instante do `UPDATE` (a), fica zerado porque o heartbeat não
passa (b), e a tela some do lado do analista em até 20 s (c).

⚠️ **O `POST /usuarios/logout` nunca é barrado.** Se a rota de sair recusasse, `sair()`
falharia justo quando é mais necessária. Mesma exceção que o modo "ver como" já abre.

---

## 4. Onde entra a recusa

| ponto | o que muda |
|---|---|
| `lib/auth.js` → `podeEntrar` | recebe o modo; recusa quem não é superadmin com a sua mensagem |
| `POST /usuarios/login` | passa o modo para `podeEntrar` |
| `PATCH /usuarios/:id` | recusa não-superadmin (é o heartbeat — item 3b) |
| `barrouPreparacao` → vira `barrouModo` | as rotas de trabalho recusam também em manutenção |
| `POST /usuarios/logout` | **nunca barra** |
| `GET /config_sistema` | passa a devolver `modo_manutencao` e `mensagem_manutencao` |

⚠️ **Continua sendo cortina, não tranca** — igual à preparação. Quem montar um pedido HTTP à
mão passa, porque o sistema ainda não tem camada de autorização. Para o que você quer — uma
janela em que ninguém está trabalhando pela tela — a cortina basta. **Não confundir com
controle de acesso**, e é por isso que o `janela_livre.js` continua sendo a conferência final
antes de gravar.

⚠️ **Na dúvida, o sistema ABRE** (falha aberta), como na preparação. Se o `config_sistema`
não puder ser lido, o modo fica desligado. Parece contraintuitivo aqui, mas: se o banco não
responde, ninguém escreve nada mesmo — e falhar fechado trancaria 53 pessoas fora por causa
de uma oscilação de rede.

---

## 5. O que precisa de autorização

### 5.1 Colunas novas — DDL

```sql
-- Duas colunas em config_sistema. Aditivo, idempotente, nada destrutivo.
-- A tabela tem UMA linha (CHECK (id = 1)).
ALTER TABLE config_sistema
  ADD COLUMN IF NOT EXISTS modo_manutencao     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mensagem_manutencao TEXT;

-- Conferência
SELECT id, modo_preparacao, modo_manutencao, mensagem_manutencao FROM config_sistema;
```

**Por que coluna nova e não reaproveitar `mensagem`:** são dois textos diferentes, e você vai
querer os dois guardados. Reaproveitar faria ligar manutenção apagar o recado da preparação.

⚠️ `ADD COLUMN IF NOT EXISTS`, não `CREATE TABLE IF NOT EXISTS` — este não altera tabela que
já existe (armadilha 2 do `CLAUDE.md`).

⚠️ **`NOT NULL DEFAULT false` significa que criar as colunas NÃO tranca ninguém.** O sistema
continua exatamente como está até você ligar o interruptor.

Vai também para `garantirTabelaConfigSistema()`, que roda a cada partida do Railway — então
**publicar já cria**. O SQL acima é só se você quiser criar antes.

### 5.2 A escrita em `usuarios` — em tempo de execução

Ligar o modo grava `sessao_fim` em até 52 linhas de `usuarios`:

```sql
UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE perfil <> 'superadmin'
```

Não é migração: acontece toda vez que você clicar em "Entrar em manutenção". Preciso da sua
autorização porque é escrita em `usuarios`.

**É reversível sozinho e não perde nada.** `sessao_fim` só serve para a lista de online;
quem entra de novo tem `ultimo_acesso > sessao_fim` e volta à lista naturalmente. Desligar o
modo não precisa desfazer carimbo nenhum.

⚠️ `WHERE perfil <> 'superadmin'` — condição derivada, não lista explícita. A regra 12 do
`CLAUDE.md` fala de **reversão**, e esta escrita não tem reversão a fazer: o valor novo é o
mesmo para todos e o estado se cura no próximo login. Se você preferir lista explícita
mesmo assim, eu capturo os ids antes e uso `= ANY($1)`. Diga.

---

## 6. Arquivos

| arquivo | o que |
|---|---|
| `lib/manutencao.js` | **novo** — a regra, isolada, testável (espelha `lib/preparacao.js`) |
| `lib/auth.js` | `podeEntrar` passa a receber o modo |
| `server.js` | `config_sistema` (GET/PATCH), login, `PATCH /usuarios/:id`, `barrouModo`, `garantirTabelaConfigSistema` |
| `index.html` | aba nova, tela de login, aviso 2.3, polling 60 s → 20 s |
| `teste_manutencao.js` | **novo** — dublê |
| `janela_livre.js` | passa a mostrar "modo manutenção: LIGADO" na foto |

---

## 7. O que eu recomendo decidir antes

1. **Coordenadores entram durante a manutenção?** Meu desenho diz **não** — só superadmin.
   É o que você pediu ("todos ... e o CI são deslogados"), e é o que faz a janela ser
   confiável: coordenador com a tela aberta escreve tanto quanto analista.
2. **Polling de 60 s → 20 s.** Recomendo. Se preferir manter 60 s, o efeito é só demorar
   mais para a tela do analista cair — o online já terá zerado pelo item 3(a)+(b).
3. **Aviso antes de derrubar?** Dá para mandar um recado pelo sino 5 min antes. **Não
   incluí** — é frente nova e você quer isto antes de renumerar. Fica anotado.
