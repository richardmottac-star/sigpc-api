# Frente 2 — troca de papel: o DDL e o efeito no Quadro 2

> Medido em 14/08/2026. **Nada executado.** O `ALTER` e o `CREATE TABLE` estão abaixo para
> você aprovar.

---

## ⚠️ PRIMEIRO: você JÁ CONTA no Quadro 2 do relatório CGE

O código do relatório inclui o superadmin quando ele tem PCs:

```js
if(u.perfil === 'analista') usuariosPorId[u.id] = u
else if(u.perfil === 'superadmin' && analistaIdsComPC.has(String(u.id))) usuariosPorId[u.id] = u
```

E você tem **meta vigente**: `metas_analistas` id 43, "Richard", grupo 3, **meta 88**, período
Nov/2025 a Abr/2026.

**Quem exclui você é a `contaProdutividade`** — e ela alimenta **outras três telas**:
Produtividade, Gestão Grupo e o Board. **Não o relatório da CGE.**

Então a frase "o relatório do 3º trimestre foi entregue comigo fora" precisa ser conferida
antes de eu mexer: ou o relatório saiu de uma versão anterior a essa linha, ou o que você viu
sem você foi a **tela de Produtividade**, não o Quadro 2. **É a única coisa que eu não
consigo medir daqui** — o PDF entregue está com você.

---

## O efeito, com e sem você

| | **com você** | **sem você** | diferença |
|---|---|---|---|
| servidores no quadro | **44** | 43 | +1 |
| PCs baixadas | **3.731** | 3.704 | **+27** |
| meta somada (46 metas vigentes) | 5.068 | 4.980 | +88 |
| **% da meta** | **73,6 %** | **74,4 %** | **−0,8 p.p.** |

**As suas 27 baixas são todas feitas no sistema** — nenhuma de carga histórica.

⚠️ **Incluir você BAIXA o percentual do grupo**, de 74,4 % para 73,6 %: a sua meta (88) pesa
mais do que as suas baixas (27). Não é argumento contra — é o número que a CGE vai ler, e é
melhor você saber antes.

⚠️ **E a série do 3º trimestre:** se o relatório entregue tinha 43 servidores e 3.704 baixas,
passar para 44 e 3.731 muda um número já protocolado. Duas saídas, e a escolha é sua:

- **(A) contar daqui pra frente**, deixando o histórico como foi entregue;
- **(B) recontar tudo**, e explicar a diferença no próximo relatório.

---

## O `ALTER` e o `CREATE TABLE` — para aprovar

```sql
BEGIN;

-- 1. O papel ativo. Nasce 'analista' para TODO MUNDO: para quem não é superadmin a coluna
--    nunca muda, e é o padrão que você pediu ao entrar.
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS papel_ativo TEXT NOT NULL DEFAULT 'analista';

-- ⚠️ O CHECK aceita só os dois papéis. Um terceiro valor entrando por engano faria a guarda
--    do servidor cair no ramo errado — e o ramo errado aqui é o que dá acesso a tudo.
ALTER TABLE usuarios
  ADD CONSTRAINT usuarios_papel_ativo_valido
  CHECK (papel_ativo IN ('analista', 'tecnico'));

-- 2. O registro de cada troca. Tabela própria: `parcela_historico` é por TR/parcela, e uma
--    troca de papel não tem TR.
CREATE TABLE IF NOT EXISTS papel_historico (
  id          SERIAL PRIMARY KEY,
  usuario_id  INTEGER NOT NULL,
  papel       TEXT    NOT NULL,
  origem      TEXT,                      -- 'login' | 'troca' | 'logout'
  criado_em   TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT ph_papel_valido CHECK (papel IN ('analista', 'tecnico'))
);

CREATE INDEX IF NOT EXISTS idx_ph_usuario ON papel_historico (usuario_id, criado_em DESC);

COMMIT;
```

**Cinco decisões que tomei, e o porquê:**

1. **`papel_ativo` em `usuarios`, não uma tabela de sessão.** A guarda precisa ler o papel a
   cada requisição, e o servidor já lê `usuarios` por id em toda rota que confere perfil.
2. **`NOT NULL DEFAULT 'analista'`** — os 53 cadastros nascem no papel analista, e para os 52
   que não são superadmin a coluna nunca muda. **Padrão ao entrar: analista**, como você pediu.
3. **`'tecnico'` sem acento** — é valor de banco, não texto de tela. O rótulo com acento fica
   no front.
4. **`CHECK` nos dois valores.** Um terceiro valor entrando por engano faria a guarda cair no
   ramo errado, e o ramo errado aqui é o que abre tudo.
5. **`papel_historico` SEM foreign key**, pelo mesmo motivo da `executado_por`: existe
   `DELETE /usuarios/:id`, e trilha não deve travar cadastro.

⚠️ **O `origem` (`login`/`troca`/`logout`) não estava no seu pedido.** Serve para diferenciar
"entrou e ficou no padrão" de "trocou de propósito" — sem ele, toda entrada no sistema vira
uma linha igual à de uma troca deliberada, e a trilha perde o que você quis registrar. Se
preferir sem, é só dizer.

---

## O que preciso de você

1. **Rodo o `ALTER` e o `CREATE TABLE`?**
2. **A série do Quadro 2: (A) daqui pra frente ou (B) recontar tudo?**
3. **Confere no PDF do 3º trimestre** se você aparece na lista — o código diz que sim, e é o
   único ponto que não dá para medir daqui.
