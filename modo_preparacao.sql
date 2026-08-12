-- ============================================================
-- MODO PREPARAÇÃO — tabela de configuração do sistema
-- Proposto em 12/08/2026. NÃO EXECUTADO: aguarda autorização.
-- Idempotente. Não altera nenhuma tabela existente.
-- ============================================================
--
-- Conferido contra o banco em 12/08 dentro de BEGIN/ROLLBACK, 17 conferências: o CREATE
-- roda, a linha nasce desligada, o CHECK recusa uma segunda linha, ligar e desligar
-- funcionam, e o bloqueio barra analista real e deixa passar coordenadora e superadmin.
-- Depois do ROLLBACK a tabela não existia — nada foi criado.
--
-- ------------------------------------------------------------
-- VOCÊ PROVAVELMENTE NÃO PRECISA RODAR ISTO À MÃO
-- ------------------------------------------------------------
-- `garantirTabelaConfigSistema()` (server.js) roda estes dois comandos a cada partida do
-- Railway, como já faz com `sgpe_processo_ref` e `preferencia_tr`. Ou seja: **basta
-- publicar** e a tabela nasce sozinha.
--
-- Este arquivo existe porque você pediu para ver o comando antes, e para o caso de querer
-- criar a tabela ANTES de publicar.
--
-- ⚠️ A LINHA NASCE COM O MODO **DESLIGADO**. Criar a tabela não tranca ninguém: o sistema
-- continua exatamente como está até você ligar o interruptor em Configurações.

CREATE TABLE IF NOT EXISTS config_sistema (
  id                  INTEGER   PRIMARY KEY DEFAULT 1,
  modo_preparacao     BOOLEAN   NOT NULL DEFAULT false,
  mensagem            TEXT,
  atualizado_por      INTEGER,
  atualizado_por_nome TEXT,
  atualizado_em       TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Uma linha só, garantida pelo banco. Sem isto, um INSERT distraído criaria uma segunda
  -- configuração e metade do sistema leria uma, metade a outra — sem ninguém notar.
  CONSTRAINT config_sistema_linha_unica CHECK (id = 1)
);

-- A linha 1 é o registro. Sem ela o PATCH não teria o que atualizar, e a tela ficaria
-- ligando um interruptor que não existe.
INSERT INTO config_sistema (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------
-- CONFERÊNCIA — rode depois; deve devolver uma linha, desligada
-- ------------------------------------------------------------
SELECT id, modo_preparacao, mensagem, atualizado_por_nome, atualizado_em
  FROM config_sistema;

-- ============================================================
-- LIGAR E DESLIGAR — pela TELA, não por aqui
-- ============================================================
-- Configurações → aba "Modo preparação". É para isso que ela existe: você liga de manhã e
-- desliga à tarde sem depender de mim e sem abrir o console do Railway.
--
-- O SQL equivalente, só para emergência (se a tela estiver fora do ar):
--
--   UPDATE config_sistema SET modo_preparacao = true  WHERE id = 1;   -- liga
--   UPDATE config_sistema SET modo_preparacao = false WHERE id = 1;   -- abre para todos
--
-- Quem já está com o sistema aberto é alcançado em até 1 minuto, sem recarregar a página —
-- vale para os dois sentidos.

-- ============================================================
-- REVERTER
-- ============================================================
-- Desligar basta (é o UPDATE acima). Para tirar a tabela mesmo, remova antes a chamada
-- `garantirTabelaConfigSistema` do server.js — senão o próximo boot a recria:
--
--   DROP TABLE IF EXISTS config_sistema;
