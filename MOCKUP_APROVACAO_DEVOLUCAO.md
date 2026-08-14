# Mockup — fila de aprovação dos pedidos de devolução

**Onde:** menu → **Aprovações**, onde já vive a fila de "vaga extra". Uma aba nova ao lado.
Coordenador vê só o **grupo dele**; superadmin vê **todos**. A guarda é do servidor.

---

## A tela

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Aprovações                                                                        │
│  ┌──────────────────┬─────────────────────────┐                                    │
│  │ Vagas extras (3) │ Devoluções de TR (2) ●  │   ← aba nova, com o contador       │
│  └──────────────────┴─────────────────────────┘                                    │
│                                                                                    │
│  [ Pendentes (2) ]  [ Todas ]                                                      │
│                                                                                    │
│ ┌────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 2020TR000612 · APAE DE GUARAMIRIM              ⏳ PENDENTE · há 2 h            │ │
│ │ ─────────────────────────────────────────────────────────────────────────────  │ │
│ │ Rafael  (Grupo 3)                                                              │ │
│ │                                                                                │ │
│ │  Motivo   1. Já estava em análise por outro analista antes de 01/08/2026       │ │
│ │           trabalho iniciado na planilha, antes do sistema                      │ │
│ │                                                                                │ │
│ │  ⚠️ Quem já analisava:  MARISA GONÇALVES  (id 31, Grupo 3)                     │ │
│ │     ── A TR NÃO volta para ela sozinha. Aprovar manda ao ESTOQUE. ──           │ │
│ │                                                                                │ │
│ │  "Assumi a TR sem saber que a Marisa já tinha 6 parciais analisadas na         │ │
│ │   planilha dela desde junho. Refazer seria trabalho dobrado."                  │ │
│ │                                                                                │ │
│ │  ┌──────────────┬──────────────┬───────────────┬──────────────────┐            │ │
│ │  │ 12 PCs na TR │ 9 voltam     │ 3 ficam       │ 0 no C.I.        │            │ │
│ │  │              │ ao estoque   │ baixadas      │                  │            │ │
│ │  └──────────────┴──────────────┴───────────────┴──────────────────┘            │ │
│ │   ↑ os números do PEDIDO (foto de 2h atrás) · CONFERIDO AGORA: iguais ✓        │ │
│ │                                                                                │ │
│ │  Motivo da decisão *  (o analista recebe este texto no sino)                   │ │
│ │  ┌───────────────────────────────────────────────────────────────────────────┐ │ │
│ │  │                                                                           │ │ │
│ │  └───────────────────────────────────────────────────────────────────────────┘ │ │
│ │                                          [ ✕ Recusar ]   [ ✓ Aprovar e devolver ] │
│ └────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                    │
│ ┌────────────────────────────────────────────────────────────────────────────────┐ │
│ │ 2021TR001747 · APAE DE BLUMENAU                ⏳ PENDENTE · há 1 dia          │ │
│ │ Juliana  (Grupo 3)                                                             │ │
│ │  Motivo   4. Afastamento ou férias                                             │ │
│ │  "Férias de 30 dias a partir de 20/08. Não termino as 4 parciais que faltam."  │ │
│ │  ┌──────────────┬──────────────┬───────────────┬──────────────────┐            │ │
│ │  │ 7 PCs na TR  │ 4 voltam     │ 3 ficam       │ 0 no C.I.        │            │ │
│ │  └──────────────┴──────────────┴───────────────┴──────────────────┘            │ │
│ │  ...                                                                           │ │
│ └────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## O cartão bloqueado — quando o C.I. entrou DEPOIS do pedido

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ 2021TR002087 · APAE DE JOINVILLE                 ⏳ PENDENTE · há 3 dias           │
│ Higor  (Grupo 1)                                                                   │
│  Motivo   2. Impedimento ou suspeição                                              │
│  "..."                                                                             │
│                                                                                    │
│  ╔══════════════════════════════════════════════════════════════════════════════╗  │
│  ║ 🏛 NÃO DÁ PARA APROVAR AGORA                                                 ║  │
│  ║ 1 PC está no ciclo do Controle Interno. Resolva essa PC antes de devolver a  ║  │
│  ║ TR — devolver agora deixaria a resposta do C.I. sem dono.                    ║  │
│  ║                                                                              ║  │
│  ║ Isso mudou DEPOIS do pedido: quando ele pediu, não havia PC no C.I.          ║  │
│  ╚══════════════════════════════════════════════════════════════════════════════╝  │
│                                                                                    │
│  Motivo da decisão *                                                               │
│  ┌────────────────────────────────────────────────────────────────────────────┐    │
│  └────────────────────────────────────────────────────────────────────────────┘    │
│                                       [ ✕ Recusar ]   [ ✓ Aprovar ] ← CINZA        │
│                                          ↑ ativo         "1 PC no Controle Interno"│
└────────────────────────────────────────────────────────────────────────────────────┘
```

⚠️ **Recusar continua ativo.** O bloqueio é para devolver, não para responder — deixar o
pedido pendente para sempre é pior do que recusar com o motivo escrito.

---

## O cartão decidido (aba "Todas")

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ 2020TR000666 · APAE DE RIO DO SUL                ✓ APROVADA · 13/08 às 16:40       │
│ Valderi  (Grupo 2)  ·  decidida por Zadir T. Machado Ferreira                      │
│  Motivo   3. Falta de documentação no processo                                     │
│  "..."                                                                             │
│  Resposta: "De acordo. Vou redistribuir na reunião de quinta."                     │
│  → 8 PCs voltaram ao estoque · 4 baixadas continuaram com o Valderi                │
└────────────────────────────────────────────────────────────────────────────────────┘
```

---

## As sete decisões de tela, e o porquê de cada uma

1. **Aba nova, e não uma fila misturada.** São duas conversas diferentes: uma dá TR,
   a outra tira. Misturar faria o coordenador aprovar no automático.

2. **O motivo aparece com o NÚMERO** (1 a 6), na mesma ordem do modal do analista. Quem decide
   muitas vezes passa a reconhecer pelo número — e o 1 é o que exige atenção.

3. **⚠️ "Quem já analisava" ganha destaque, com o aviso de que a TR NÃO vai para ela.**
   Este é o ponto onde a tela pode enganar. O sistema **não** transfere: aprovar manda ao
   **estoque**, e quem estava com ela precisa **assumir** de novo. Se a intenção era devolver
   para a Marisa, alguém tem de fazer isso — a tela diz isso na cara, senão a TR fica no
   estoque e ninguém percebe.

4. **Os quatro números vêm do PEDIDO — e são reconferidos AGORA.** A linha
   `CONFERIDO AGORA: iguais ✓` (ou `mudou: eram 9, agora são 7`) existe porque entre o pedido
   e a decisão o analista continua trabalhando: ele pode ter baixado mais parciais. Sem essa
   linha, o coordenador aprovaria olhando um número velho.

5. **O motivo da decisão é obrigatório nas DUAS**, e o campo diz *"o analista recebe este
   texto no sino"* — para ninguém escrever "ok".

6. **Aprovar diz "Aprovar e devolver".** O botão anuncia que a TR sai da planilha do analista
   na hora, não que "marca como aprovado".

7. **⚠️ Nada de aprovar em lote.** Uma decisão por vez, com motivo escrito por vez. Um botão
   "aprovar todos" produziria dez avisos com o mesmo texto genérico — e é justamente o texto
   que faz o analista entender.

---

## O que já está pronto por trás

- `GET /solicitacao_devolucao?usuario_id=N&status=pendente` — **o recorte é do servidor**:
  analista vê só os dele, coordenador só os do grupo, superadmin todos.
- `PATCH /solicitacao_devolucao/:id` — decide e, se aprovada, **devolve na mesma transação**,
  reconferindo o C.I. antes. Avisa o analista pelo sino com o motivo escrito.
- A trava de duas decisões simultâneas é o `WHERE status = 'pendente'` do UPDATE: quem chegar
  em segundo lugar leva 409, não escreve por cima.
