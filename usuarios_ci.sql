-- ============================================================
-- OS TRÊS TÉCNICOS DO CONTROLE INTERNO — FCEE
-- Proposto em 12/08/2026. NÃO EXECUTADO: aguarda autorização.
-- ============================================================
--
-- Perfil `controle_interno`, setorial FCEE, sem grupo.
-- Senha provisória `Sigpc@2026`, com `senha_provisoria = true`.
--
-- ⚠️ A SENHA VAI EM TEXTO PURO, E ISSO É INTENCIONAL AQUI.
--
-- `lib/auth.js` aceita os dois formatos e CONVERTE no primeiro login que a provar (é o que
-- está migrando as 47 senhas antigas). Somado a `senha_provisoria = true`, o caminho é:
--
--     1. a pessoa entra com Sigpc@2026
--     2. o login converte para bcrypt na hora
--     3. a tela de troca obrigatória exige uma senha nova, que não pode ser Sigpc@2026
--
-- Ou seja: o texto puro vive por exatamente um login, e `GET /usuarios` já não devolve
-- senha nenhuma desde 11/08. Se preferir nascer em bcrypt, diga que eu gero os três hashes.
--
-- ⚠️ SEM E-MAIL, de propósito — você disse que eles preenchem no Primeiro Acesso. O campo
-- aceita NULL e a tela Meu Perfil é o lugar onde isso entra.
--
-- ⚠️ `aprovado`/`aguardando_aprovacao`: nascem prontos para entrar (aprovado = true,
-- aguardando = false). Se o `marcar_aguardando_aprovacao.sql` já tiver rodado quando você
-- criar estes três, eles NÃO são afetados — aquele UPDATE já passou.

-- ------------------------------------------------------------
-- ANTES — confere que nenhum dos três CPFs já existe
-- ------------------------------------------------------------
SELECT id, nome, cpf, perfil FROM usuarios
 WHERE regexp_replace(cpf, '[^0-9]', '', 'g') IN ('02540463983', '60275634515', '02321833920');
-- Deve devolver ZERO linhas.

-- ------------------------------------------------------------
-- O INSERT
-- ------------------------------------------------------------
INSERT INTO usuarios
  (nome, cpf, senha_hash, perfil, setorial_id, grupo,
   ativo, aprovado, aguardando_aprovacao, senha_provisoria, meta_mensal, criado_em)
VALUES
  ('Marcia Terezinha Miranda',   '025.404.639-83', 'Sigpc@2026', 'controle_interno', 'FCEE', NULL,
   true, true, false, true, 0, NOW()),
  ('Atemilson Bispo dos Santos', '602.756.345-15', 'Sigpc@2026', 'controle_interno', 'FCEE', NULL,
   true, true, false, true, 0, NOW()),
  ('Sirene Wolf dos Santos',     '023.218.339-20', 'Sigpc@2026', 'controle_interno', 'FCEE', NULL,
   true, true, false, true, 0, NOW());

-- `meta_mensal = 0`: eles não têm meta de baixa — não analisam PC, apreciam parecer. Deixar
-- o padrão 10 os faria aparecer com meta nos relatórios de produtividade.

-- ------------------------------------------------------------
-- CONFERÊNCIA — rode depois
-- ------------------------------------------------------------
SELECT id, nome, cpf, perfil, setorial_id, grupo, ativo, senha_provisoria
  FROM usuarios WHERE perfil = 'controle_interno' ORDER BY nome;
-- Devem aparecer os três, ativos, sem grupo, senha_provisoria = true.

-- E o sino do C.I. passa a ter destinatário (antes disto, a resposta do analista não
-- avisava ninguém — ver `POST /ci/responder`):
SELECT COUNT(*) AS tecnicos_ativos FROM usuarios
 WHERE perfil = 'controle_interno' AND ativo = true;

-- ============================================================
-- REVERTER
-- ============================================================
-- Enquanto não tiverem decidido nada, dá para apagar sem deixar órfão:
--
--   DELETE FROM usuarios
--    WHERE perfil = 'controle_interno'
--      AND regexp_replace(cpf, '[^0-9]', '', 'g')
--          IN ('02540463983', '60275634515', '02321833920');
--
-- ⚠️ Lista explícita de CPFs, não `WHERE perfil = 'controle_interno'` sozinho — é a regra
-- 12 do CLAUDE.md, escrita hoje depois de um WHERE derivado transformar 7 linhas em 14.639.
--
-- Depois que decidirem alguma coisa, `ci_encerrado_por` aponta para o id deles. Aí o certo
-- é desativar (`ativo = false`), não apagar.
