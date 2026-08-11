-- ============================================================
-- FAIXA DE AVISOS — criação da tabela
-- Proposta em 11/08/2026. NÃO executado: aguarda autorização.
-- Idempotente. Não altera nenhuma tabela existente.
-- Não exibe nada sozinha: sem linha, a faixa não aparece.
-- ============================================================

CREATE TABLE IF NOT EXISTS faixa_aviso (
  id            SERIAL    PRIMARY KEY,
  texto         TEXT      NOT NULL,
  escopo        TEXT      NOT NULL DEFAULT 'inicial',
  ativo         BOOLEAN   NOT NULL DEFAULT true,
  inicio        DATE,
  fim           DATE,
  ordem         INTEGER   NOT NULL DEFAULT 0,
  grupo         TEXT,
  autor_id      INTEGER,
  autor_nome    TEXT,
  criado_em     TIMESTAMP NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT faixa_aviso_escopo  CHECK (escopo IN ('inicial','todas','urgente')),
  CONSTRAINT faixa_aviso_texto   CHECK (length(btrim(texto)) > 0),
  -- Impede período invertido no banco, não só na tela: uma faixa com fim antes do início
  -- nunca apareceria, e ninguém entenderia por quê.
  CONSTRAINT faixa_aviso_periodo CHECK (inicio IS NULL OR fim IS NULL OR fim >= inicio)
);

CREATE INDEX IF NOT EXISTS idx_faixa_ativa ON faixa_aviso (ativo, escopo);

-- escopo:  'inicial' = só na tela inicial
--          'todas'   = em todas as telas
--          'urgente' = em todas as telas, com destaque vermelho
--
-- inicio / fim:  DATE, e não TIMESTAMP, de propósito. Período de exibição é dia, não hora —
--                e comparar DATE com a data de Brasília evita o defeito de fuso de 11/08,
--                em que o servidor em UTC achava que amanhã já tinha chegado às 21h.
--                NULL nos dois = sempre visível enquanto `ativo`.
--
-- grupo:   NULL = todos os analistas. '1'/'2'/'3' = só aquele grupo.
--          Coordenador só cria com o próprio grupo; superadmin escolhe.
--          Mesma regra já usada no recado do sino.
--
-- ordem:   menor primeiro, na rotação da faixa.

-- ------------------------------------------------------------
-- CONFERÊNCIA — rode depois; deve devolver a tabela e zero linhas
-- ------------------------------------------------------------
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'faixa_aviso';

SELECT COUNT(*) AS linhas FROM faixa_aviso;

-- ============================================================
-- REVERTER
-- ============================================================
-- DROP TABLE IF EXISTS faixa_aviso;
