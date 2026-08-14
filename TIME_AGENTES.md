# Time de agentes do SIGPC-GT — estrutura e fluxo

**Preparado em 13/08/2026. NADA foi ativado.** Os arquivos existem, nenhum agente foi
acionado, nenhum plugin foi instalado, nenhuma permissão foi alterada.

---

## Quem é quem

| Papel | Quem | Escreve código? | Toca o banco? | Publica? |
|---|---|---|---|---|
| **TEAM LEAD** | **eu (esta sessão)** | sim | **só com sua ordem** | **só com sua ordem** |
| orquestrador | `.claude/agents/orquestrador.md` | não | **só `SELECT`** | não |
| coder | `.claude/agents/coder.md` | sim | **só `SELECT`** | não |
| qa-banco (o "Q4") | `.claude/agents/qa-banco.md` | só o teste | **só `SELECT`** | não |
| revisor | `.claude/agents/revisor.md` | não | **só `SELECT`** | não |

## As três regras (você, 13/08/2026)

Gravadas no `CLAUDE.md` dos dois repositórios **e** repetidas dentro do prompt de cada
agente — para não dependerem de o `CLAUDE.md` ter sido lido.

1. **NENHUM agente escreve no banco.** `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE` passam por
   você, **com o comando na tela antes**. `SELECT` e teste rodam livres.
2. **NENHUM agente decide regra de negócio.** Regra → para e pergunta. Técnica → resolve e
   segue. *Muda o que o sistema faz para o analista → regra; muda só como o código está
   escrito → técnica.*
3. **NENHUM agente publica.** `git commit` e `git push` são seus.

O orquestrador tem mais duas, só dele: **não abre frente que você não pediu** (o que ele
enxergar vira linha em Pendências, não tarefa) e **não gera sugestão enquanto espera decisão
sua** — parada é parada.

> **Sobre a regra 3, para não haver mal-entendido:** eu paro de publicar por conta própria.
> Quando a frente fechar, eu monto o commit, mostro a mensagem e os arquivos, e **espero você
> mandar** — do mesmo jeito que já faço com escrita no banco. Se você quis dizer que vai
> digitar `git push` você mesmo, é só falar e eu passo a entregar o comando pronto sem rodar.

**Só o TEAM LEAD fala com você, e a publicação é sua.** Os quatro devolvem relatório para
mim; eu junto, decido o que vira correção e o que vira pendência, e levo a você o que for
decisão sua. Você não passa a conversar com quatro agentes — continua conversando com um.

---

## O fluxo de uma frente — quem chama quem

**Ninguém chama ninguém a não ser eu.** Os quatro não conversam entre si e não se acionam:
cada um recebe tarefa do TEAM LEAD e devolve relatório para o TEAM LEAD. Não há agente
chamando agente — é o que impede uma cadeia de decisões que ninguém acompanhou.

```
  ┌─ VOCÊ pede a frente ────────────────────────────────────────────┐
  │                                                                 │
  ▼                                                                 │
① TEAM LEAD chama o  ORQUESTRADOR                                   │
     devolve: tarefas · os SELECTs a rodar antes · o que é          │
     decisão SUA · o que corre em paralelo · o mockup necessário    │
  │                                                                 │
  ▼                                                                 │
② TEAM LEAD roda os SELECTs (livres) e monta o mockup               │
  │                                                                 │
  ▼                                                                 │
⏸  PARADA 1 — obrigatória, sempre ─────────────────────────────────►│
     mockup + perguntas de REGRA + todo comando de escrita no banco │
     Enquanto você não responde: o orquestrador NÃO sugere nada     │
  │                                                            ◄────┘
  ▼ (você aprova)
③ TEAM LEAD chama o  CODER  ×N
     paralelo quando tocam arquivos diferentes
     ⚠️ SÉRIE quando tocam o index.html — é um arquivo só, de 11 MB,
        e duas edições simultâneas nele se atropelam
     devolve: código + testes + node --check + o que NÃO fez e por quê
  │
  ├──► achou decisão de REGRA no meio? ──► ⏸ PARADA 2 (só se acontecer)
  ├──► precisa de escrita no banco?    ──► ⏸ PARADA 3 (só se acontecer)
  │
  ▼
④ TEAM LEAD chama o  QA-BANCO
     sobe o Express de verdade, prova contra o Postgres, só leitura
     ⚠️ FALHA volta para o coder (③). Não segue com falha aberta.
  │
  ▼
⑤ TEAM LEAD chama o  REVISOR
     diff × as 25 armadilhas × as decisões já registradas
  │
  ▼
⑥ TEAM LEAD junta tudo e monta o commit — ⏸ PARADA 4: espera sua ordem
     e reporta em bloco: o que entrou, o que ficou pendente, o que
     ninguém conseguiu provar
```

**Por que o `qa-banco` vem antes do `revisor`:** o revisor lê o diff; o qa-banco descobre o
que o diff não conta. A trava do Controle Interno que **nunca disparava** estava impecável no
diff — só o banco contou que todas as 13 PCs do C.I. são baixadas.

### Onde ele para para te perguntar — as quatro paradas

| | quando | o que chega até você |
|---|---|---|
| **1** | **sempre**, antes de escrever a primeira linha | mockup de tela nova · as perguntas de regra · todo comando de escrita no banco que a frente vá precisar |
| **2** | só se aparecer | decisão de regra que o orquestrador não previu — o coder para no meio e devolve a pergunta |
| **3** | só se aparecer | escrita no banco que ninguém tinha visto — com o comando na tela, o que ele muda e quantas linhas |
| **4** | **sempre**, no fim | o commit montado, esperando sua ordem para publicar |

Fora dessas quatro, ele não te interrompe. Decisão técnica ele resolve e reporta depois —
é o método de 12/08, e é o motivo de existir a parada 1: **junta-se tudo o que é seu num
lugar só**, em vez de espalhar perguntas pelo dia.

### O que acontece quando o revisor reprova

O revisor **não corrige**. Ele devolve achados ordenados por gravidade, e eu classifico cada
um em **quatro destinos**:

| destino | quando | o que acontece |
|---|---|---|
| **volta ao coder** | defeito de código | corrige → **refaz o ④ qa-banco**, não só o revisor. Correção é código novo, e código novo não provado é como o defeito entrou |
| **vira pergunta sua** | o achado é de **regra**, não de código | ⏸ para. Ex.: "a trava nunca dispara" pode significar que o código está errado **ou** que a regra é outra — quem decide é você |
| **vira pendência** | é real, mas fora do escopo da frente | entra no `CLAUDE.md`, com data e motivo. **Não vira frente nova sozinho** |
| **falso positivo** | o revisor não conhecia a decisão | eu registro **por escrito o porquê** no `CLAUDE.md`. Falso positivo descartado em silêncio volta na próxima revisão |

⚠️ **Limite de duas voltas.** Se o mesmo ponto reprovar pela terceira vez, eu **paro e te
levo o caso** em vez de tentar de novo. Laço de correção que não converge quase nunca é
código ruim — é especificação errada, e insistir só queima tempo e token.

⚠️ **Reprovação do qa-banco (④) é diferente de reprovação do revisor (⑤).** A do qa-banco é
fato medido — volta ao coder direto, sem discussão. A do revisor é leitura de código, e pode
ser falso positivo; ela passa pela minha classificação antes de virar trabalho.

⚠️ **Nada é publicado com achado aberto.** Se sobrar algo sem destino, a frente não fecha:
ela chega até você com o achado descrito, e você decide se publica assim mesmo.

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
