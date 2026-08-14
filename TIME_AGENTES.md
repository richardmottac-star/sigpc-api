# Time de agentes do SIGPC-GT — estrutura e fluxo

**Preparado em 13/08/2026. NADA foi ativado.** Os arquivos existem, nenhum agente foi
acionado, nenhum plugin foi instalado, nenhuma permissão foi alterada.

---

## Quem é quem

| Papel | Quem | Escreve código? | Toca o banco? | Publica? |
|---|---|---|---|---|
| **TEAM LEAD** | **eu (esta sessão)** | sim | **só com sua ordem** | **sim** |
| orquestrador | `.claude/agents/orquestrador.md` | não | não | não |
| coder | `.claude/agents/coder.md` | sim | **não** | não |
| qa-banco (o "Q4") | `.claude/agents/qa-banco.md` | só o teste | **só leitura** | não |
| revisor | `.claude/agents/revisor.md` | não | não | não |

**Só o TEAM LEAD fala com você e só o TEAM LEAD publica.** Os quatro devolvem relatório para
mim; eu junto, decido o que vira correção e o que vira pendência, e levo a você o que for
decisão sua. Você não passa a conversar com quatro agentes — continua conversando com um.

---

## O fluxo de uma frente

```
   VOCÊ pede a frente
          │
          ▼
 ┌──────────────────┐
 │  orquestrador    │  quebra em tarefas · lista os SELECTs · separa
 │  (planeja)       │  o que É decisão sua do que não é
 └────────┬─────────┘
          │
          ▼
   ⏸  TEAM LEAD leva a VOCÊ:  mockup + as perguntas de regra + toda escrita no banco
          │                    ── esta é a ÚNICA parada obrigatória ──
          ▼  (aprovado)
 ┌──────────────────┐
 │  coder  ×N       │  em paralelo quando tocam arquivos diferentes;
 │  (implementa)    │  em série quando tocam o index.html
 └────────┬─────────┘
          ▼
 ┌──────────────────┐
 │  qa-banco        │  sobe o Express de verdade, prova contra o Postgres
 │  (prova)         │  ⚠️ FALHA aqui volta para o coder, não segue
 └────────┬─────────┘
          ▼
 ┌──────────────────┐
 │  revisor         │  diff × as 25 armadilhas × as decisões já tomadas
 └────────┬─────────┘
          ▼
   TEAM LEAD publica nas duas branches dos dois repos e reporta em bloco
```

**Por que o `qa-banco` vem antes do `revisor`:** o revisor lê o diff; o qa-banco descobre o
que o diff não conta. A trava do Controle Interno que **nunca disparava** estava impecável no
diff — só o banco contou que todas as 13 PCs do C.I. são baixadas.

---

## As travas escritas dentro de cada agente

Não são conselho, estão no prompt de cada um:

1. **Nenhum agente escreve no banco.** `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE` continuam
   exigindo sua ordem expressa. Se a tarefa exigir escrita, o agente **para e devolve o
   comando** para eu levar a você.
2. **Nenhum agente publica.** Sem `commit`, sem `push`, sem `merge`. Eles deixam a árvore
   suja; quem publica sou eu, depois da revisão.
3. **Nenhum agente decide regra de negócio.** Buraco na especificação vira pergunta de volta,
   não escolha silenciosa — uma escolha do coder viraria regra do sistema sem ninguém decidir.
4. **Regra 11 e regra 12 no prompt do qa-banco**, com o estrago de cada uma: as 7 PCs gravadas
   em produção por um teste que parecia isolado, e as 7 linhas que viraram 14.639.
5. **O sistema está aberto**: o qa-banco roda `janela_livre.js` antes de qualquer coisa que
   possa atrapalhar quem está na tela.

---

## Duas decisões suas

### 1. O orquestrador: agente ou script determinístico?

Preparei o agente (`orquestrador.md`), mas **recomendo o script**. O histórico deste projeto
é inteiro de armadilhas que só verificação determinística pegou — um agente que "lembra" de
chamar o qa-banco às vezes esquece; um script chama sempre, na ordem, e não tem opinião.

| | agente `orquestrador` | script (ferramenta `Workflow`) |
|---|---|---|
| decide a ordem | o modelo, a cada vez | fixa, escrita no script |
| pula uma etapa | pode | **não pode** |
| bom para | frente nova, formato desconhecido | frente repetida (rota + lib + tela + prova) |

**Minha recomendação:** os dois, cada um no seu lugar. O agente planeja a frente nova; o
script executa o ciclo repetido `coder → qa-banco → revisor`, que é sempre o mesmo. Se você
preferir só um, fique com o script.

> ⚠️ O script custa mais tokens do que uma sessão normal — ele roda vários agentes de uma vez.
> Vale para frente grande, não para ajuste de uma linha.

### 2. A permissão de escrita no banco

Hoje o `.claude/settings.local.json` tem `Bash(*)` liberado e a `DATABASE_URL` **com a senha
em texto puro** dentro dele. O arquivo está no `.gitignore` — nada vazou para o GitHub. Mas
**qualquer agente que eu acione herda essa permissão**, e a trava contra escrita hoje é só o
texto do prompt dele.

Proposta (não apliquei, é decisão sua) — acrescentar ao mesmo arquivo:

```json
"deny": [
  "Bash(*psql*)",
  "Bash(*--gravar*)",
  "Bash(*migracao_senhas*)"
]
```

Isso não atrapalha o trabalho normal: a escrita que você autoriza continua passando por mim,
e eu peço a permissão na hora. O que ele impede é o agente gravar sozinho por engano.

> A senha em texto puro no arquivo eu deixaria como está por enquanto — trocá-la agora
> derruba o Railway e a equipe está na tela.

---

## Plugins — o que vale e o que não vale

O marketplace `claude-plugins-official` está instalado e **zero plugins ativos**. Passei a
lista inteira. Recomendo **um**:

- ✅ **`pr-review-toolkit`** — traz o `silent-failure-hunter`, que caça exatamente a doença
  deste projeto: o caminho que falha em silêncio. Foi o que aconteceu com o `origem='MANUAL'`
  que o job apagaria sem ninguém reclamar. Traz também `code-reviewer` e `comment-analyzer`.

Não recomendo agora:

- ❌ **`feature-dev`, `code-simplifier`** — o `coder` e o `revisor` já cobrem, e em português,
  com as armadilhas daqui dentro. Agente genérico não sabe que `parcial_num` não é o número
  do SIGEF.
- ❌ **`claude-security`** — o buraco de segurança real deste projeto (senha em texto puro na
  rota) já foi fechado em 11/08 e tem teste que falha se voltar.
- ❌ **`playwright`** (externo) — clicaria as cinco telas que ninguém clicou ainda. É
  tentador, mas ele clica em **produção**, com a equipe dentro. Fica para quando houver
  ambiente de teste.

---

## Como ativar, quando você mandar

1. `/agents` mostra os quatro. Nada mais é preciso — arquivo em `.claude/agents/` já vale.
2. O `pr-review-toolkit`, se você quiser, entra pelo `/plugin`.
3. O `deny` acima, se você aprovar, eu acrescento no `settings.local.json`.

**Enquanto você não mandar, nada disso roda.** Os quatro arquivos são texto parado.

---

## O que este time NÃO resolve

- **Não substitui você nas decisões.** As pendências abertas no `CLAUDE.md` — a meta vigente,
  a Caroline sem usuário, o Eduardo inativo, a Aline 67 — continuam esperando você.
- **Não clica na tela.** As cinco telas nunca clicadas por gente (assumir, o lápis, cabeçalho
  do card, indicador de online, busca global) continuam precisando de você na frente do
  navegador.
- **Não deixa mais barato.** Fica mais rápido e pega mais defeito; gasta mais token.
