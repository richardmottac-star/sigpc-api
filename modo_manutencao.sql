-- ============================================================
-- MODO MANUTENÇÃO — colunas em config_sistema
-- Autorizado pelo Richard em 12/08/2026. Aditivo e idempotente.
-- ============================================================
--
-- ⚠️ ADD COLUMN IF NOT EXISTS, e não CREATE TABLE IF NOT EXISTS: este último NÃO altera
-- tabela que já existe (armadilha 2 do CLAUDE.md). A config_sistema já existe desde 12/08.
--
-- ⚠️ AS COLUNAS NASCEM DESLIGADAS. Criá-las não tranca ninguém — o sistema continua
-- exatamente como está até o interruptor ser ligado em Configurações → Modo manutenção.
--
-- `garantirTabelaConfigSistema()` (server.js) roda isto a cada partida do Railway, então
-- basta publicar. Este arquivo existe para o caso de querer criar antes, e como registro.

ALTER TABLE config_sistema
  ADD COLUMN IF NOT EXISTS modo_manutencao     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mensagem_manutencao TEXT;

-- ------------------------------------------------------------
-- CONFERÊNCIA — deve devolver uma linha, com manutenção FALSE
-- ------------------------------------------------------------
SELECT id, modo_preparacao, modo_manutencao, mensagem_manutencao FROM config_sistema;

-- ============================================================
-- LIGAR E DESLIGAR — pela TELA
-- ============================================================
-- Configurações → aba "Modo manutenção".
--
-- ⚠️ Ligar pelo SQL cru NÃO derruba ninguém: quem derruba é o carimbo em `usuarios`, que a
-- rota faz na mesma transação. O equivalente completo, só para emergência:
--
--   BEGIN;
--   UPDATE config_sistema SET modo_manutencao = true WHERE id = 1;
--   UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE perfil <> 'superadmin';
--   COMMIT;
--
-- Para reabrir basta o primeiro, com false. O carimbo não precisa ser desfeito: quem entra
-- de novo passa a ter ultimo_acesso > sessao_fim e volta à lista de online sozinho.

-- ============================================================
-- REVERTER as colunas
-- ============================================================
-- Desligar o modo basta. Para remover mesmo, tire antes as duas linhas de
-- `garantirTabelaConfigSistema` no server.js, senão o próximo boot as recria:
--
--   ALTER TABLE config_sistema DROP COLUMN IF EXISTS modo_manutencao,
--                              DROP COLUMN IF EXISTS mensagem_manutencao;
