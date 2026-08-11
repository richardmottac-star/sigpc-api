-- ============================================================
-- TROCA OBRIGATÓRIA DE SENHA — marcação inicial
-- Proposto em 11/08/2026, véspera da abertura aos 47 analistas.
-- NÃO executado: aguarda autorização do Richard.
--
-- Conferido contra o banco em 11/08 dentro de BEGIN/ROLLBACK: roda, e marca 49 usuários.
-- ============================================================
--
-- POR QUE ISTO EXISTE
--
--   49 das 50 senhas do banco estão em TEXTO PURO.
--   44 pessoas compartilham UMA senha.
--   2 usam algo do tipo '123456'.
--   E até hoje `GET /usuarios` devolvia todas elas a quem pedisse, sem credencial nenhuma.
--
-- Como os CPFs circulam internamente, qualquer analista entrava como qualquer colega só
-- digitando o CPF do outro — sem precisar de nenhuma falha técnica. Enquanto isso valer,
-- `registrado_por` não prova a autoria de baixa nenhuma.
--
-- ------------------------------------------------------------
-- A COLUNA JÁ É CRIADA SOZINHA NO BOOT
-- ------------------------------------------------------------
-- `garantirColunasUsuarios()` (server.js) roda este ALTER a cada partida do Railway. Está
-- repetido aqui só para o caso de você querer rodar ANTES de publicar. É idempotente.

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS senha_provisoria BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- ANTES: quem seria marcado (só conta, não altera nada)
-- ------------------------------------------------------------
SELECT COUNT(*) FILTER (WHERE senha_hash IS NOT NULL AND senha_hash NOT LIKE '$2%') AS marcaria,
       COUNT(*) FILTER (WHERE senha_hash LIKE '$2%')                                AS ja_em_hash,
       COUNT(*) FILTER (WHERE senha_hash IS NULL)                                   AS sem_senha,
       COUNT(*)                                                                     AS total
  FROM usuarios;

-- ------------------------------------------------------------
-- O UPDATE
-- ------------------------------------------------------------
-- O critério é TODA SENHA EM TEXTO PURO, e não só as 44 repetidas.
--
-- Marcar só as repetidas deixaria de fora as 5 que são únicas — e essas também estiveram
-- públicas em `GET /usuarios` durante todo o tempo em que a rota existiu. Senha que já foi
-- lida por qualquer um não é mais senha, repetida ou não.
--
-- `NOT LIKE '$2%'` é o teste de "ainda não é hash bcrypt". Quem já entrou depois da
-- publicação teve a senha convertida no login e não é tocado aqui.

UPDATE usuarios
   SET senha_provisoria = true
 WHERE senha_hash IS NOT NULL
   AND senha_hash NOT LIKE '$2%';

-- ⚠️ ISTO INCLUI VOCÊ (id 4) E O ZZ TESTE TRAVA (id 57).
--
-- Ou seja: no primeiro login de amanhã, os dois caem na tela de troca de senha. Para o
-- ZZ TESTE isso é até bom na demonstração — a reunião vê exatamente o que os 47 vão ver.
-- Se preferir que a conta de demonstração entre direto, rode também:
--
--     UPDATE usuarios SET senha_provisoria = false WHERE id = 57;
--
-- E se quiser ficar de fora você mesmo, troque o 57 por 4. Não recomendo: sua senha
-- ('704342', seis dígitos) esteve pública como as outras.

-- ------------------------------------------------------------
-- CONFERÊNCIA — rode depois
-- ------------------------------------------------------------
SELECT senha_provisoria, COUNT(*) AS quantos
  FROM usuarios
 GROUP BY senha_provisoria
 ORDER BY senha_provisoria;

-- Quem entra amanhã e cai na troca (deve casar com o número acima):
SELECT COUNT(*) AS entram_e_trocam
  FROM usuarios
 WHERE ativo = true
   AND aguardando_aprovacao = false
   AND cpf IS NOT NULL AND btrim(cpf) <> ''
   AND senha_provisoria = true;

-- ============================================================
-- REVERTER
-- ============================================================
-- Desfaz a marcação. NÃO desfaz senha já trocada por alguém — isso é irreversível de
-- propósito, e é o objetivo.
--
--   UPDATE usuarios SET senha_provisoria = false;
--
-- A coluna em si pode ficar: sem marcação, ela não faz nada.
-- Para tirar mesmo (e aí é preciso remover o ALTER de `garantirColunasUsuarios` antes,
-- senão o próximo boot a recria):
--
--   ALTER TABLE usuarios DROP COLUMN IF EXISTS senha_provisoria;
