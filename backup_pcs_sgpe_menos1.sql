-- ============================================================
-- BACKUP DAS 79 PCs COM processo_pc = '-1'
-- Proposto em 12/08/2026. NÃO EXECUTADO: aguarda autorização.
--
-- Confirmado com a analista em 12/08: na 2020TR000637 o SIGEF tem 19 parciais.
-- O sistema mostrava 21 = 20 parciais reais + 1 PC final contada como parcial.
-- Das 20, a parcial 23 (PC 2021PC001882, com processo_pc = '-1') NÃO existe no SIGEF.
-- 20 − 1 = 19. Fecha exatamente.
-- ============================================================
--
-- ⚠️ ESTE ARQUIVO NÃO APAGA NADA. Ele só copia. A exclusão é outra decisão, depois da
-- conferência dos analistas — a lista foi para eles em `pcs_sgpe_-1.csv`.
--
-- ------------------------------------------------------------
-- POR QUE UMA TABELA, E NÃO UM ARQUIVO
-- ------------------------------------------------------------
-- Um CSV exportado se perde, envelhece e não volta sozinho. Uma tabela no mesmo banco
-- volta com um INSERT ... SELECT, e é a mesma transação que apagou. Em 06/08 o backup do
-- UPDATE do grupo A foi prometido e não existia quando foi procurado — não repetir.
--
-- `CREATE TABLE ... AS SELECT *` copia a estrutura junto, então nenhuma coluna nova de
-- `prestacoes_contas` precisa ser prevista aqui.

CREATE TABLE IF NOT EXISTS _backup_sgpe_menos1_20260812 AS
SELECT *, NOW() AS _copiado_em
  FROM prestacoes_contas
 WHERE processo_pc = '-1';

-- ------------------------------------------------------------
-- CONFERÊNCIA — rode logo depois. Tem de dar 79 dos dois lados.
-- ------------------------------------------------------------
SELECT (SELECT COUNT(*) FROM _backup_sgpe_menos1_20260812)               AS no_backup,
       (SELECT COUNT(*) FROM prestacoes_contas WHERE processo_pc = '-1') AS na_origem;

-- Nenhuma pode ter ficado de fora: esta consulta tem de devolver ZERO linhas.
SELECT p.codigo_pc
  FROM prestacoes_contas p
 WHERE p.processo_pc = '-1'
   AND NOT EXISTS (SELECT 1 FROM _backup_sgpe_menos1_20260812 b
                    WHERE b.codigo_pc = p.codigo_pc);

-- E o backup não pode ter trazido nada além: também ZERO linhas.
SELECT b.codigo_pc
  FROM _backup_sgpe_menos1_20260812 b
 WHERE NOT EXISTS (SELECT 1 FROM prestacoes_contas p
                    WHERE p.codigo_pc = b.codigo_pc AND p.processo_pc = '-1');

-- Conferência do que mais importa: a PC que a Perla baixou hoje.
SELECT codigo_pc, tr, analista_nome, baixada, data_baixa, parecer_tipo, valor
  FROM _backup_sgpe_menos1_20260812
 WHERE codigo_pc = '2021PC002854';

-- Retrato do que está guardado, para conferir contra o levantamento:
--   79 PCs · 50 TRs · 27 analistas (22 sem analista) · R$ 2.518.618,36
SELECT COUNT(*) pcs, COUNT(DISTINCT tr) trs,
       COUNT(*) FILTER (WHERE baixada) baixadas,
       COUNT(*) FILTER (WHERE analista_id IS NULL) sem_analista,
       SUM(valor::numeric) valor_total
  FROM _backup_sgpe_menos1_20260812;

-- ============================================================
-- COMO VOLTAR, se um dia for preciso
-- ============================================================
-- A coluna `_copiado_em` é do backup e não existe em `prestacoes_contas` — por isso a
-- restauração nomeia as colunas em vez de usar `SELECT *`:
--
--   INSERT INTO prestacoes_contas
--   SELECT (b).* FROM (
--     SELECT b #= hstore('_copiado_em', NULL) AS b FROM _backup_sgpe_menos1_20260812 b) x;
--
-- Se `hstore` não estiver disponível, o caminho simples e sem extensão:
--
--   INSERT INTO prestacoes_contas
--   SELECT * FROM _backup_sgpe_menos1_20260812;   -- e então remover a coluna extra antes
--
-- ⚠️ NA HORA DE APAGAR, o DELETE tem de ser por LISTA EXPLÍCITA de `codigo_pc`, lida deste
-- backup — nunca por `WHERE processo_pc = '-1'`. É a regra 12 do CLAUDE.md, escrita depois
-- de um WHERE derivado transformar 7 linhas em 14.639:
--
--   DELETE FROM prestacoes_contas
--    WHERE codigo_pc = ANY(ARRAY(SELECT codigo_pc FROM _backup_sgpe_menos1_20260812));
--
-- E antes disso: a PC 2021PC002854 (Perla, baixada hoje, R$ 33.917,72) precisa de decisão
-- própria. Ela não sai no atacado.

-- ============================================================
-- DESFAZER O BACKUP
-- ============================================================
--   DROP TABLE IF EXISTS _backup_sgpe_menos1_20260812;
--
-- Só faça isso depois de as 79 estarem resolvidas — enquanto houver dúvida, a tabela é o
-- único lugar onde as linhas originais existem.
