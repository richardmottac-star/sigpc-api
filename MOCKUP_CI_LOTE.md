# Mockup — encaminhar ao C.I. em lote

**16/08/2026.** Nada implementado. Isto é para você aprovar ou mudar antes.

**O problema:** `enviarAoCI(tr, parcialNum)` recebe uma parcela por vez, com um `moConfirm`
cada. A **Geisa clicaria 63 vezes**; a Perla, 77. E são **764 parcelas** em 41 analistas.

---

## 1. O cabeçalho da TR — onde nasce a seleção

Hoje:

```
▾ 2020TR000646   APAE DE ITAIÓPOLIS   [🏛 7 sem C.I.]  [✨ NOVA]  🗒️
```

Proposto — a etiqueta âmbar **vira o gatilho**, e some quando não há nada a selecionar:

```
▾ 2020TR000646   APAE DE ITAIÓPOLIS   [🏛 7 sem C.I. · selecionar]  [✨ NOVA]  🗒️
                                       └─ clique marca as 7 de uma vez
```

⚠️ **A etiqueta já existe e já conta certo** (`semCi`, contando as baixadas sem C.I. da TR).
Ela só ganha um `onclick`. Não é elemento novo — é o que já está lá passando a fazer algo,
que é o oposto de acrescentar mais um controle na tela.

---

## 2. O cartão da parcela — checkbox SÓ no passo 2

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ☐  [PARCIAL 1]  3 PCs · R$ 12.934,55  [Parecer Regular]                      │
│                                    [Salvar situação] [Registrar parecer · 3] │
│  🏛 Passo 2 de 3 · baixada em 30/06/2026 · parecer: Parecer Regular          │
│     FALTA ENCAMINHAR AO CONTROLE INTERNO            [🏛 Encaminhar ao CI]    │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────────┐
│    [PARCIAL 4]  2 PCs · R$ 3.334,47   [Em análise]        ← passo 1: SEM caixa│
├──────────────────────────────────────────────────────────────────────────────┤
│    [PARCIAL 9]  2 PCs · R$ 2.326,61                       ← passo 3: SEM caixa│
│  🏛 Passo 3 de 3 · No Controle Interno desde 14/08/2026                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

⚠️ **A caixa só existe em `pPasso(pa) === 2`.** No passo 1 não há o que encaminhar (sem
parecer, e o servidor recusa com `'CI exige parecer prévio'`); no passo 3 já foi. Desenhar
uma caixa desabilitada nos outros dois seria pior — é a armadilha 15: *botão que aceita
clique e não responde é pior que botão cinza*. Aqui nem cinza: **não existe**.

⚠️ **E a caixa não substitui o botão individual.** Quem quer encaminhar uma só continua
clicando no `[🏛 Encaminhar ao CI]` de sempre. O lote é atalho, não caminho novo.

---

## 3. A barra que aparece quando há seleção

Fixa no rodapé, só enquanto houver algo marcado:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ☑ 7 parciais selecionadas · 17 PCs · R$ 45.281,00                           │
│                              [limpar seleção]   [🏛 Encaminhar as 7 ao C.I.] │
└──────────────────────────────────────────────────────────────────────────────┘
```

⚠️ **O número de PCs aparece junto do de parciais, de propósito.** O encaminhamento vai a
parcela INTEIRA — quem marca 7 parcelas manda 17 PCs, e o `CLAUDE.md` registra que há parcela
com 7 PCs. Mostrar só "7 parciais" esconderia o tamanho do que está sendo feito.

⚠️ **A seleção é por TR e morre ao trocar de tela.** Selecionar em três TRs diferentes e
mandar tudo junto seria uma transação atravessando TRs sem que a pessoa veja o conjunto.

---

## 4. A confirmação — uma só, com a lista

```
┌─ Encaminhar 7 parciais ao Controle Interno ─────────────────────────────────┐
│                                                                              │
│  2020TR000646 · APAE DE ITAIÓPOLIS                                           │
│                                                                              │
│     parcial 1  ·  3 PCs  ·  R$ 12.934,55                                     │
│     parcial 2  ·  2 PCs  ·  R$  2.234,38                                     │
│     parcial 3  ·  2 PCs  ·  R$  2.234,38                                     │
│     ... e mais 4                                                             │
│                                    ─────────────────────────────────────     │
│                                       7 parciais · 17 PCs · R$ 45.281,00     │
│                                                                              │
│  Vai a parcela INTEIRA, não só as PCs que você vê.                           │
│  A sua baixa NÃO é desfeita — continua contando na sua produtividade, e o    │
│  retorno do C.I. também não a cancela.                                       │
│                                                                              │
│                                       [Voltar]  [Encaminhar as 7]            │
└──────────────────────────────────────────────────────────────────────────────┘
```

⚠️ **Uma confirmação, não sete.** Sete modais com o mesmo texto é o oposto do que o aviso
serve — é a mesma razão pela qual **não há aprovar em lote** nos pedidos de devolução
(armadilha 20). A diferença: lá cada pedido tem um motivo escrito, que se perderia; aqui o
ato é idêntico em todas, e o que importa é ver o conjunto antes.

---

## 5. A rota — `POST /parcela/ci_lote`

```
POST /parcela/ci_lote
{
  tr: '2020TR000646',
  parciais: ['1','2','3','5','8','11','14'],     // lista EXPLÍCITA (regra 12)
  analista_id: 31,
  setorial_id: 'FCEE'
}
```

**Resposta:**

```json
{ "data": {
    "tr": "2020TR000646",
    "encaminhadas": ["1","2","3","5","8","11","14"],
    "pcs": 17,
    "recusadas": []
  }, "count": 7, "error": null }
```

### O que ela faz, e o que NÃO faz

| | |
|---|---|
| **UMA transação** para as N parcelas | rede caindo no meio não deixa metade feita |
| carrega as PCs com `FOR UPDATE` | mesma `carregarParcela` das outras cinco rotas |
| **mesmas travas, por parcela** | sem parecer → recusa · já encaminhada → recusa · **só `baixada = true`** |
| `resolverAutoria` | o dono e o executor, contra o perfil lido no BANCO |
| `barrouPreparacao` | igual às outras |
| **uma linha de `parcela_historico` por parcela** | o histórico é chaveado por `(tr, parcial_num)`; uma linha só para as sete não apareceria em seis delas |
| **NÃO toca** `baixada`, `data_baixa`, `parecer_tipo`, `valor` | é a trava que já existe, e há teste que falha se um UPDATE do ciclo mencionar essas colunas |

### ⚠️ A decisão que eu preciso que você confirme: parcela recusada derruba o lote?

Duas opções, e elas dão resultados diferentes:

**(a) TUDO OU NADA** — uma parcela sem parecer aborta as sete, com a lista do porquê.
*A favor:* a pessoa vê o conjunto que confirmou acontecer inteiro, ou nada.
*Contra:* uma parcela problemática trava as outras seis, e ela reclica.

**(b) PASSA O QUE PODE** — encaminha as boas e devolve `recusadas: [{parcial, motivo}]`.
*A favor:* nada trava; a tela mostra "6 encaminhadas, 1 recusada: parcial 5 exige parecer".
*Contra:* o resultado difere do que foi confirmado no modal.

**Eu faria a (a)**, e o motivo é a tela: as parcelas oferecidas para seleção **já são só as do
passo 2**, então uma recusa significa que o estado mudou embaixo da pessoa — outro analista
mexeu, ou a tela está velha. Nesse caso parar e recarregar é mais honesto que encaminhar seis
e explicar depois. Mas se você achar que trava demais na prática, a (b) é uma linha diferente.

### O que NÃO vou fazer

- **Nada de laço de `fetch` no navegador.** É a armadilha 16 do `sigpc-gt` — *"a tela não
  conta, não decide e não itera"* —, e três lugares caíram nela em 12–13/08.
- **Nada de selecionar entre TRs diferentes.**
- **Nada de encaminhar quem está no passo 1 ou 3**, nem com a caixa nem pela rota.

### Testes que vêm junto

- a rota é transacional e usa lista explícita de parciais;
- recusa sem parecer, recusa já encaminhada, recusa não baixada;
- grava **N** linhas de histórico para N parcelas, não uma;
- não menciona `baixada`/`data_baixa`/`parecer_tipo` no UPDATE (o teste que já existe);
- na tela: a caixa aparece **só** no passo 2, a barra some com a seleção vazia, e o contador
  de PCs bate com a soma das parcelas marcadas.
