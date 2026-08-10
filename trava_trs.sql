-- ============================================================
-- TRAVA DE TRs POR ANALISTA — criação das tabelas
-- Gerado em 10/08/2026. Rodar no Railway (aba Console -> psql,
-- ou aba Query bloco a bloco).
-- Idempotente: pode rodar mais de uma vez sem efeito colateral.
-- Não altera prestacoes_contas nem usuarios.
-- Não trava ninguém: limite_padrao entra NULL = sem limite.
-- ============================================================

-- ------------------------------------------------------------
-- 1. CONFIGURAÇÃO GLOBAL (uma linha só)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config_limite_tr (
  id                  INTEGER   PRIMARY KEY DEFAULT 1,
  limite_padrao       INTEGER,
  liberacao           TEXT      NOT NULL DEFAULT 'tr',
  pedido_ativo        BOOLEAN   NOT NULL DEFAULT true,
  pedido_aprovador    TEXT      NOT NULL DEFAULT 'coordenador',
  atualizado_por      INTEGER,
  atualizado_por_nome TEXT,
  atualizado_em       TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT config_limite_tr_uma_linha CHECK (id = 1),
  CONSTRAINT config_limite_tr_liberacao CHECK (liberacao IN ('tr','parcial')),
  CONSTRAINT config_limite_tr_aprovador CHECK (pedido_aprovador IN ('coordenador','superadmin','qualquer'))
);

-- limite_padrao:    NULL = sem limite (é como entra)
-- liberacao:        'tr' = vaga livre quando a TR inteira baixa
--                   'parcial' = vaga livre na primeira parcial baixada
-- pedido_aprovador: quem decide o pedido de vaga extra

INSERT INTO config_limite_tr (id, limite_padrao) VALUES (1, NULL)
  ON CONFLICT (id) DO NOTHING;


-- ------------------------------------------------------------
-- 2. EXCEÇÕES POR ANALISTA
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS limite_tr_excecao (
  analista_id    INTEGER   PRIMARY KEY,
  limite         INTEGER,
  observacao     TEXT,
  atualizado_por INTEGER,
  atualizado_em  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- limite: NULL = sem limite para esta pessoa
--         0    = bloqueado, não pega TR nenhuma
--         N    = limite próprio, sobrepõe o padrão
-- nome e grupo NÃO ficam aqui: saem de usuarios por JOIN em analista_id
-- (armadilha 1 do CLAUDE.md — nunca duplicar nome de analista)


-- ------------------------------------------------------------
-- 3. SOLICITAÇÕES DE VAGA EXTRA
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS solicitacao_vaga (
  id             SERIAL    PRIMARY KEY,
  analista_id    INTEGER   NOT NULL,
  tr             VARCHAR(20),
  justificativa  TEXT      NOT NULL,
  status         TEXT      NOT NULL DEFAULT 'pendente',
  decidido_por   INTEGER,
  decidido_em    TIMESTAMP,
  motivo         TEXT,
  criado_em      TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitacao_vaga_status CHECK (status IN ('pendente','aprovada','negada','usada'))
);

CREATE INDEX IF NOT EXISTS idx_solic_analista ON solicitacao_vaga(analista_id, status);
CREATE INDEX IF NOT EXISTS idx_solic_status   ON solicitacao_vaga(status);

-- status: pendente -> aprovada -> usada     (vaga extra gasta ao assumir a TR)
--         pendente -> negada                (motivo preenchido)
-- o estado 'usada' impede que aprovações virem +1 permanente e acumulem


-- ------------------------------------------------------------
-- 4. CONFERÊNCIA — rode depois, deve devolver 3 tabelas e 1 linha
-- ------------------------------------------------------------
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('config_limite_tr','limite_tr_excecao','solicitacao_vaga')
 ORDER BY table_name;

SELECT id, limite_padrao, liberacao, pedido_ativo, pedido_aprovador
  FROM config_limite_tr;


-- ============================================================
-- REVERTER (se precisar desfazer tudo)
-- ============================================================
-- DROP TABLE IF EXISTS solicitacao_vaga;
-- DROP TABLE IF EXISTS limite_tr_excecao;
-- DROP TABLE IF EXISTS config_limite_tr;
