-- ═══════════════════════════════════════════════════════════════════════════
--  solicitacao_devolucao — o analista PEDE a devolução da TR. Ele não devolve.
--  Especificação do Richard, 13/08/2026.  ⚠️ NÃO EXECUTADO — aguarda autorização.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- POR QUE UMA TABELA NOVA, E NÃO UMA COLUNA `tipo` NA `solicitacao_vaga`
-- Sete consultas de `lib/limite-tr.js` leem a `solicitacao_vaga` SEM filtro nenhum. Um
-- pedido de devolução gravado lá seria lido como pedido de vaga:
--   · `contarVagasExtras`  → aprovado vira +1 no limite de quem pediu para DEVOLVER;
--   · `reservaPendente`    → pendente RESERVA no Estoque a TR que ele quer largar,
--                            com a tag "Fulano pediu esta TR";
--   · `expirarPendentes`   → em 3 dias vira 'expirada' e notifica "a TR voltou ao estoque";
--   · `consumirVagaExtra`  → o próximo "Assumir" consome a devolução como autorização.
-- Nenhum desses dá erro. Tabela separada faz `limite-tr.js` continuar sem saber que isto
-- existe — que é exatamente o que se quer.
--
-- ⚠️ A TR CONTINUA CONTANDO NO LIMITE ENQUANTO O PEDIDO ESTÁ PENDENTE (decisão do Richard).
-- Isso é automático e é o motivo de não haver nada a fazer aqui: o pedido NÃO toca em
-- `prestacoes_contas.analista_id`. A TR só sai da contagem quando a aprovação a devolve.
-- Se o pendente já liberasse a vaga, qualquer um abriria vaga só pedindo devolução.
--
-- ⚠️ A BAIXA NUNCA É TOCADA, aqui nem na aprovação. Parcial baixada permanece no nome de
-- quem baixou — a devolução usa a MESMA `lib/devolucao.js` do superadmin.

BEGIN;

CREATE TABLE IF NOT EXISTS solicitacao_devolucao (
  id                 SERIAL PRIMARY KEY,

  -- quem pede, e o que pede.  A devolução é da TR INTEIRA, nunca de uma parcial.
  analista_id        INTEGER      NOT NULL REFERENCES usuarios(id),
  tr                 VARCHAR(20)  NOT NULL,
  setorial_id        VARCHAR(20)  NOT NULL DEFAULT 'FCEE',

  -- ⚠️ CÓDIGO, não o rótulo. O rótulo do motivo 1 carrega uma DATA ("antes de 01/08/2026"),
  -- e rótulo com data é reescrito mais cedo ou mais tarde: um CHECK sobre o texto passaria a
  -- recusar as linhas antigas. O texto que a pessoa lê mora em `lib/devolucao-pedido.js`.
  motivo             TEXT         NOT NULL,
  justificativa      TEXT         NOT NULL,

  -- Motivo 1 — quem já analisava.  ⚠️ Guarda o ID, não só o nome (armadilha 1: nome curto
  -- x nome completo; filtrar por nome já custou caro). O nome livre existe para quem NÃO
  -- está em `usuarios` — é o caso da Caroline, que tem meta vigente e não tem cadastro.
  indicado_id        INTEGER      REFERENCES usuarios(id),
  indicado_nome      TEXT,

  -- A FOTO DO QUE FOI PROMETIDO NA TELA, no instante do pedido. Depois da decisão estes
  -- números mudam, e o que ficou registrado é o que ele viu antes de confirmar.
  pcs_total          INTEGER      NOT NULL DEFAULT 0,
  pcs_voltam         INTEGER      NOT NULL DEFAULT 0,
  pcs_ficam_baixadas INTEGER      NOT NULL DEFAULT 0,

  status             TEXT         NOT NULL DEFAULT 'pendente',

  -- quem decidiu, e POR ESCRITO.  O analista é avisado pelo sino com este texto, aprovada
  -- ou recusada — decisão do Richard. Decisão sem motivo escrito é o que fazia a TR sumir
  -- da planilha sem explicação.
  decidido_por       INTEGER      REFERENCES usuarios(id),
  decidido_em        TIMESTAMP,
  motivo_decisao     TEXT,

  criado_em          TIMESTAMP    NOT NULL DEFAULT NOW(),

  CONSTRAINT sd_motivo_valido CHECK (motivo IN (
    'analise_anterior',      -- 1. Já estava em análise por outro analista antes de 01/08/2026
    'impedimento',           -- 2. Impedimento ou suspeição
    'falta_documentacao',    -- 3. Falta de documentação no processo
    'afastamento',           -- 4. Afastamento ou férias
    'redistribuicao',        -- 5. Redistribuição pedida pela coordenação
    'outro'                  -- 6. Outro
  )),

  CONSTRAINT sd_status_valido CHECK (status IN ('pendente','aprovada','negada','cancelada')),

  -- A justificativa é obrigatória em TODOS os motivos.
  CONSTRAINT sd_justificativa_preenchida CHECK (btrim(justificativa) <> ''),

  -- ⚠️ NO MOTIVO 1, "QUEM JÁ ANALISAVA" É OBRIGATÓRIO. Sem ele a TR volta ao estoque para
  -- qualquer um pegar, quando deveria ir para quem já estava com ela. A trava é do banco
  -- porque a da tela é contornável.
  CONSTRAINT sd_indicado_no_motivo_1 CHECK (
    motivo <> 'analise_anterior'
    OR indicado_id IS NOT NULL
    OR (indicado_nome IS NOT NULL AND btrim(indicado_nome) <> '')
  ),

  -- Decidida SEMPRE tem motivo escrito. 'cancelada' é o próprio analista desistindo.
  CONSTRAINT sd_decisao_tem_motivo CHECK (
    status IN ('pendente','cancelada')
    OR (motivo_decisao IS NOT NULL AND btrim(motivo_decisao) <> '')
  )
);

-- ⚠️ UM PEDIDO PENDENTE POR TR, e a garantia é do BANCO. Dois cliques no botão, ou a mesma
-- TR pedida duas vezes, gerariam duas linhas e duas decisões — e a segunda decidiria sobre
-- uma TR que já voltou ao estoque. Índice PARCIAL: o analista pode pedir de novo depois de
-- uma recusa, e o histórico das recusadas fica inteiro.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sd_um_pendente_por_tr
  ON solicitacao_devolucao (tr, setorial_id)
  WHERE status = 'pendente';

-- A fila da coordenação lê por status e ordena por chegada.
CREATE INDEX IF NOT EXISTS idx_sd_fila
  ON solicitacao_devolucao (status, criado_em);

-- "Meus pedidos" do analista.
CREATE INDEX IF NOT EXISTS idx_sd_analista
  ON solicitacao_devolucao (analista_id, criado_em DESC);

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- CONFERÊNCIA (rodar depois, sem gravar):
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'solicitacao_devolucao' ORDER BY ordinal_position;
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint WHERE conrelid = 'solicitacao_devolucao'::regclass;
--
-- PARA DESFAZER (só se a tabela estiver vazia):
--   DROP TABLE solicitacao_devolucao;
-- ═══════════════════════════════════════════════════════════════════════════
