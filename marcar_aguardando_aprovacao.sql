-- ============================================================
-- MARCAR TODOS COMO "AGUARDANDO APROVAÇÃO"
-- Escrito em 12/08/2026 a pedido do Richard. **NÃO EXECUTADO.**
-- Rode só quando decidir — de preferência com a reunião já começando.
-- ============================================================
--
-- O QUE ISTO FAZ
--
-- `aguardando_aprovacao = true` **bloqueia o login na hora**. Conferido em produção hoje:
-- com a marca ligada, a resposta é "Seu cadastro está aguardando aprovação."
--
-- Ou seja: no instante em que você rodar isto, **ninguém entra no sistema** até ser
-- liberado no Painel ADMIN. É esse o efeito que você quer — mas é bom que esteja escrito.
--
-- ------------------------------------------------------------
-- ⚠️ A LINHA QUE NÃO PODE FALTAR: `id <> 4`
-- ------------------------------------------------------------
-- Se você se marcar, **você não entra — e não há quem te aprove.** O único caminho de volta
-- seria o console do Railway. O `id <> 4` está no WHERE por isso, e não é opcional.
--
-- ⚠️ E o `id <> 57`: o ZZ TESTE TRAVA é a conta da demonstração. Marcado, ele não entra, e
-- a demonstração do primeiro acesso morre junto. Se você QUISER demonstrar também a
-- aprovação, tire o `AND id <> 57`.

-- ------------------------------------------------------------
-- ANTES — quem seria marcado (só conta, não altera nada)
-- ------------------------------------------------------------
SELECT COUNT(*) AS marcaria,
       COUNT(*) FILTER (WHERE perfil = 'analista')    AS analistas,
       COUNT(*) FILTER (WHERE perfil = 'coordenador') AS coordenadores
  FROM usuarios
 WHERE id <> 4 AND id <> 57 AND aguardando_aprovacao = false;

-- ------------------------------------------------------------
-- O UPDATE
-- ------------------------------------------------------------
UPDATE usuarios
   SET aguardando_aprovacao = true
 WHERE id <> 4          -- você, que vai aprovar
   AND id <> 57;        -- a conta da demonstração

-- Mexe SÓ em `aguardando_aprovacao`. Não toca em `ativo`, `aprovado`, `grupo` nem senha —
-- quanto menos campo mudar, mais simples é desfazer se a reunião virar.

-- ------------------------------------------------------------
-- CONFERÊNCIA — rode depois
-- ------------------------------------------------------------
SELECT aguardando_aprovacao, COUNT(*) AS quantos
  FROM usuarios GROUP BY 1 ORDER BY 1;

-- Você e o ZZ TESTE têm de aparecer como `false`:
SELECT id, nome, aguardando_aprovacao FROM usuarios WHERE id IN (4, 57);

-- ============================================================
-- DESFAZER — libera todo mundo de uma vez
-- ============================================================
-- Se a reunião não terminar, ou se precisar abortar no meio:
--
--   UPDATE usuarios SET aguardando_aprovacao = false;
--
-- Isso devolve o acesso a quem já tinha. **Não** mexe em quem estava inativo antes
-- (Eduardo, id 52) — inativo continua inativo, que é outro bloqueio.

-- ============================================================
-- ⚠️ TRÊS COISAS QUE VÃO ACONTECER, E É MELHOR SABER ANTES
-- ============================================================
--
-- 1. APROVAR ATIVA. O `PATCH /usuarios/:id/aprovar` faz
--    `ativo = true, aprovado = true, aguardando_aprovacao = false`.
--    Então aprovar em bloco **ativa o Eduardo (id 52)**, que hoje está inativo de
--    propósito. Se ele não deve entrar, não o marque — ou não o selecione na hora.
--
-- 2. O GRUPO É PRESERVADO. A aprovação em bloco manda corpo vazio, e a rota só mexe em
--    `grupo` quando ele vem escrito. Conferido em produção hoje: grupo antes = grupo
--    depois. Ninguém perde o grupo por ser aprovado em bloco.
--
-- 3. OS DEZ QUE JÁ NÃO ENTRAVAM CONTINUAM NÃO ENTRANDO. Nove estão sem CPF (o login é por
--    CPF), a Grazielly está sem senha e o Eduardo está inativo. Aprovar não resolve
--    nenhum dos três problemas — resolve só o bloqueio de aprovação.
