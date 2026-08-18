// CAMINHO: sigpc-api/migracao_correcoes_20260818.js
//
// A MIGRAÇÃO DAS QUATRO FRENTES DE 18/08/2026. PADRÃO = DRY-RUN.
//
//   A) corrigir a situação de uma parcial      C) cadastrar PC
//   B) puxar de volta do Controle Interno      D) solicitar correção ao coordenador
//
// São QUATRO passos, numa transação só:
//
//   1. prestacoes_contas.baixado_por     (int)  — QUEM baixou
//   2. prestacoes_contas.enviado_ci_por  (int)  — QUEM encaminhou ao C.I.
//   3. tabela solicitacao_correcao              — a fila do coordenador (frente D)
//   4. backfill de 1 e 2 a partir de parcela_historico
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ POR QUE AS DUAS COLUNAS PRECISAM EXISTIR
//
// A regra de A é "o analista corrige sozinho se a baixa foi DELE", e a de B é "ele desfaz o
// encaminhamento que ELE MESMO fez". Nenhuma das duas era computável: medido em 18/08/2026,
// `prestacoes_contas` não tem coluna nenhuma de autoria de baixa nem de encaminhamento.
// `analista_id` é o DONO ATUAL da PC, que é outra pergunta — a PC troca de mãos.
// `registrado_por` é nome em texto livre, sem id e sem FK, e está nulo em 3.260 das baixadas.
//
// ⚠️ O BACKFILL NÃO INVENTA AUTORIA. Ele só copia o que `parcela_historico` JÁ registrou, e
// só quando a linha de histórico cai a menos de 5 minutos do carimbo da própria PC
// (`data_baixa` / `dt_envio_ci`). Sem essa janela, um `parecer` gravado hoje seria creditado
// a uma baixa da recarga de agosto, porque as duas casam em (tr, parcial_num).
//
// Medido: **234 baixadas** e **926 no C.I.** têm autor recuperável. As outras ficam NULAS, e
// nulo aqui quer dizer "não há autoria registrada" — que é exatamente o caso 3 da regra de A
// ("não tem autoria registrada → o analista corrige sozinho"). Preencher com o dono atual
// pareceria mais completo e seria um chute com cara de dado.
//
// ⚠️ SEM FOREIGN KEY nas duas colunas, pelo mesmo motivo do `parcela_historico.executado_por`:
// existe `DELETE /usuarios/:id`, e uma FK faria a exclusão de um cadastro falhar por causa de
// uma linha de trilha. Trilha não trava cadastro.
//
// ⚠️ `ADD COLUMN IF NOT EXISTS` — armadilha 2. `CREATE TABLE IF NOT EXISTS` NÃO altera tabela
// existente, então coluna nova nunca entra por ali.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ A CHAVE DA `solicitacao_correcao` É `codigo_pc`, NUNCA `parcial_num`.
//
// Decisão do Richard, 18/08/2026: "nunca use parcial_num como chave". O motivo está medido —
// a PC final aparece com QUATRO grafias de `parcial_num` no banco ('FINAL' 986, 'Final' 39,
// 'final' 1 e '1' em 5 casos), e nesses 5 uma chave por parcial_num arrastaria a parcial 1
// junto com a final. `codigo_pc` é `UNIQUE` na tabela e não tem esse problema.
//
//   node migracao_correcoes_20260818.js              dry-run
//   node migracao_correcoes_20260818.js --gravar     grava

const fs = require('fs');
const { Pool } = require('pg');

const GRAVAR = process.argv.includes('--gravar');
const ARQ_REVERSAO = `reverter_migracao_correcoes_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const nl = (t) => console.log(t ?? '');

// ── 1 e 2: as duas colunas de autoria ────────────────────────────────────────
const DDL_COLUNAS = [
  `ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS baixado_por integer`,
  `ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS enviado_ci_por integer`,
];

// ── 3: a fila do coordenador ─────────────────────────────────────────────────
//
// ⚠️ TABELA SEPARADA DA `solicitacao_devolucao`, e o motivo é o mesmo que separou aquela da
// `solicitacao_vaga`: sete consultas de `lib/limite-tr.js` leem `solicitacao_vaga` sem filtro
// nenhum, e `SQL_LISTAR` da devolução traria pedidos de correção para a fila errada, com
// `pcs_voltam` sem sentido. Pior: o índice `idx_sd_um_pendente_por_tr` é por TR, e um pedido
// de correção bloquearia um pedido de DEVOLUÇÃO da mesma TR, em silêncio.
const DDL_TABELA = `
  CREATE TABLE IF NOT EXISTS solicitacao_correcao (
    id                serial PRIMARY KEY,
    analista_id       integer NOT NULL REFERENCES usuarios(id),
    codigo_pc         text    NOT NULL,
    tr                text    NOT NULL,
    setorial_id       text    NOT NULL DEFAULT 'FCEE',
    acao              text    NOT NULL,
    situacao_destino  text,
    motivo            text    NOT NULL,
    -- a foto do que a tela prometeu, como na solicitacao_devolucao
    pcs_afetadas      integer NOT NULL DEFAULT 0,
    autor_original_id integer,
    status            text    NOT NULL DEFAULT 'pendente',
    decidido_por      integer REFERENCES usuarios(id),
    decidido_em       timestamp,
    motivo_decisao    text,
    criado_em         timestamp NOT NULL DEFAULT now(),

    CONSTRAINT sc_acao_valida CHECK (acao IN ('corrigir_situacao', 'puxar_ci')),
    CONSTRAINT sc_status_valido CHECK (status IN ('pendente', 'aprovada', 'negada', 'cancelada')),
    CONSTRAINT sc_motivo_preenchido CHECK (btrim(motivo) <> ''),
    -- espelha o sd_decisao_tem_motivo: decidir sem escrever o porquê é o que fazia a
    -- parcial mudar de estado sem explicação para quem pediu.
    CONSTRAINT sc_decisao_tem_motivo CHECK (
      status IN ('pendente', 'cancelada')
      OR (motivo_decisao IS NOT NULL AND btrim(motivo_decisao) <> '')),
    -- corrigir situação SEM destino não é pedido nenhum: é "mude para alguma coisa".
    CONSTRAINT sc_destino_na_correcao CHECK (
      acao <> 'corrigir_situacao' OR (situacao_destino IS NOT NULL AND btrim(situacao_destino) <> ''))
  )`;

// ⚠️ UM PENDENTE POR (codigo_pc, acao). É o índice que segura dois cliques — a conferência
// da rota não seguraria, e foi assim que a `solicitacao_devolucao` resolveu o mesmo problema.
// Por (codigo_pc, acao) e não só por codigo_pc: pedir correção de situação e pedir a volta do
// C.I. são pedidos diferentes sobre a mesma PC, e podem coexistir.
const DDL_INDICES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_um_pendente
     ON solicitacao_correcao (codigo_pc, acao) WHERE status = 'pendente'`,
  `CREATE INDEX IF NOT EXISTS idx_sc_fila ON solicitacao_correcao (status, criado_em)`,
  `CREATE INDEX IF NOT EXISTS idx_sc_analista ON solicitacao_correcao (analista_id, criado_em DESC)`,
];

// ── 4: o backfill, a partir do que a trilha JÁ registrou ─────────────────────
//
// ⚠️ A JANELA DE 5 MINUTOS É O QUE FAZ ISTO SER LEITURA E NÃO CHUTE. `parcela_historico` é
// chaveado por (tr, parcial_num): sem a janela, um `parecer` de hoje casaria com uma baixa da
// recarga de 05/08 na mesma parcela, e o autor de hoje seria carimbado numa baixa que não é
// dele. Com a janela, 8 casos de colisão medidos em 18/08 ficam de fora, corretamente.

const BACKFILL_BAIXA = `
  UPDATE prestacoes_contas p
     SET baixado_por = a.autor
    FROM (
      SELECT p2.codigo_pc, h.analista_id AS autor
        FROM prestacoes_contas p2
        JOIN LATERAL (
          SELECT h.analista_id FROM parcela_historico h
           WHERE h.tr = p2.tr AND h.parcial_num = p2.parcial_num
             AND h.setorial_id = p2.setorial_id AND h.evento = 'parecer'
             AND h.criado_em BETWEEN p2.data_baixa - interval '5 min'
                                 AND p2.data_baixa + interval '5 min'
           ORDER BY h.criado_em LIMIT 1) h ON true
       WHERE p2.baixada = true AND p2.data_baixa IS NOT NULL AND h.analista_id IS NOT NULL
    ) a
   WHERE p.codigo_pc = a.codigo_pc AND p.baixado_por IS NULL
   RETURNING p.codigo_pc`;

const BACKFILL_CI = `
  UPDATE prestacoes_contas p
     SET enviado_ci_por = a.autor
    FROM (
      SELECT p2.codigo_pc, h.analista_id AS autor
        FROM prestacoes_contas p2
        JOIN LATERAL (
          SELECT h.analista_id FROM parcela_historico h
           WHERE h.tr = p2.tr AND h.parcial_num = p2.parcial_num
             AND h.setorial_id = p2.setorial_id AND h.evento = 'ci'
             AND h.criado_em BETWEEN p2.dt_envio_ci - interval '5 min'
                                 AND p2.dt_envio_ci + interval '5 min'
           ORDER BY h.criado_em LIMIT 1) h ON true
       WHERE p2.enviado_ci = true AND p2.dt_envio_ci IS NOT NULL AND h.analista_id IS NOT NULL
    ) a
   WHERE p.codigo_pc = a.codigo_pc AND p.enviado_ci_por IS NULL
   RETURNING p.codigo_pc`;

// Os totais que NADA disto pode mover. Se qualquer um mexer, é ROLLBACK.
const SEL_TOTAIS = `
  SELECT COUNT(*)::int                                              AS pcs,
         COUNT(*) FILTER (WHERE baixada)::int                       AS baixadas,
         COUNT(*) FILTER (WHERE enviado_ci)::int                    AS no_ci,
         COUNT(*) FILTER (WHERE estornada)::int                     AS estornadas,
         COUNT(*) FILTER (WHERE tipo = 'final')::int                AS finais,
         COALESCE(SUM(valor), 0)::text                              AS soma_valor
    FROM prestacoes_contas`;

(async () => {
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query("SET LOCAL lock_timeout = '20s'");

    const { rows: [totAntes] } = await cli.query(SEL_TOTAIS);
    nl('── ANTES ─────────────────────────────────────────────────');
    nl(`   ${totAntes.pcs} PCs · ${totAntes.baixadas} baixadas · ${totAntes.no_ci} no C.I.`
      + ` · ${totAntes.estornadas} estornadas · ${totAntes.finais} finais`);

    const existiaCol = (await cli.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'prestacoes_contas' AND column_name IN ('baixado_por','enviado_ci_por')`
    )).rows.map(r => r.column_name);
    const existiaTab = (await cli.query(`SELECT to_regclass('public.solicitacao_correcao') AS t`)).rows[0].t;
    nl(`   colunas de autoria ja existentes: ${existiaCol.length ? existiaCol.join(', ') : 'nenhuma'}`);
    nl(`   solicitacao_correcao ja existe:   ${existiaTab ? 'SIM' : 'nao'}`);

    // ── PASSO 1 e 2 ────────────────────────────────────────────────────────
    nl('\n── PASSO 1-2: colunas de autoria ─────────────────────────');
    for (const sql of DDL_COLUNAS) { await cli.query(sql); nl(`   ${sql.replace(/\s+/g, ' ')}`); }

    // ── PASSO 3 ────────────────────────────────────────────────────────────
    nl('\n── PASSO 3: tabela solicitacao_correcao ──────────────────');
    await cli.query(DDL_TABELA);
    for (const sql of DDL_INDICES) await cli.query(sql);
    const cols = (await cli.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'solicitacao_correcao' ORDER BY ordinal_position`)).rows.map(r => r.column_name);
    const cons = (await cli.query(
      `SELECT conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'solicitacao_correcao' AND con.contype = 'c' ORDER BY conname`)).rows.map(r => r.conname);
    nl(`   ${cols.length} colunas: ${cols.join(', ')}`);
    nl(`   ${cons.length} CHECKs: ${cons.join(', ')}`);

    // ── PASSO 4 ────────────────────────────────────────────────────────────
    nl('\n── PASSO 4: backfill a partir de parcela_historico ───────');
    const { rows: bxA } = await cli.query(BACKFILL_BAIXA);
    const { rows: ciA } = await cli.query(BACKFILL_CI);
    nl(`   baixado_por    preenchido em ${bxA.length} PCs`);
    nl(`   enviado_ci_por preenchido em ${ciA.length} PCs`);

    const { rows: [cob] } = await cli.query(`
      SELECT COUNT(*) FILTER (WHERE baixada AND baixado_por IS NOT NULL)::int AS bx_com,
             COUNT(*) FILTER (WHERE baixada AND baixado_por IS NULL)::int     AS bx_sem,
             COUNT(*) FILTER (WHERE enviado_ci AND enviado_ci_por IS NOT NULL)::int AS ci_com,
             COUNT(*) FILTER (WHERE enviado_ci AND enviado_ci_por IS NULL)::int     AS ci_sem,
             COUNT(*) FILTER (WHERE baixado_por IS NOT NULL AND baixada = false)::int AS bx_em_nao_baixada
        FROM prestacoes_contas`);
    nl(`   cobertura: baixa ${cob.bx_com} com autor / ${cob.bx_sem} sem`);
    nl(`              C.I.  ${cob.ci_com} com autor / ${cob.ci_sem} sem`);

    // ── CONFERÊNCIA DEPOIS DE ESCREVER, NA MESMA TRANSAÇÃO ─────────────────
    const { rows: [totDep] } = await cli.query(SEL_TOTAIS);
    const { rows: [autorValido] } = await cli.query(`
      SELECT COUNT(*)::int AS orfaos FROM prestacoes_contas p
       WHERE (p.baixado_por IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = p.baixado_por))
          OR (p.enviado_ci_por IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = p.enviado_ci_por))`);

    const checks = [
      ['as duas colunas existem',       (await cli.query(`SELECT COUNT(*)::int n FROM information_schema.columns
          WHERE table_name='prestacoes_contas' AND column_name IN ('baixado_por','enviado_ci_por')`)).rows[0].n === 2, '2 colunas'],
      ['solicitacao_correcao existe',   !!(await cli.query(`SELECT to_regclass('public.solicitacao_correcao') t`)).rows[0].t, 'ok'],
      ['os 5 CHECKs entraram',          cons.length === 5, `${cons.length} CHECKs`],
      ['o indice de 1 pendente existe', (await cli.query(`SELECT COUNT(*)::int n FROM pg_indexes
          WHERE tablename='solicitacao_correcao' AND indexname='idx_sc_um_pendente'`)).rows[0].n === 1, 'idx_sc_um_pendente'],
      ['a fila nasce VAZIA',            (await cli.query(`SELECT COUNT(*)::int n FROM solicitacao_correcao`)).rows[0].n === 0, '0 pedidos'],
      ['nenhum autor orfao',            autorValido.orfaos === 0, `${autorValido.orfaos} orfaos`],
      ['baixado_por so em baixada',     cob.bx_em_nao_baixada === 0, `${cob.bx_em_nao_baixada} fora`],
      ['total de PCs nao mudou',        totDep.pcs === totAntes.pcs, `${totAntes.pcs} -> ${totDep.pcs}`],
      ['baixadas nao mudaram',          totDep.baixadas === totAntes.baixadas, `${totAntes.baixadas} -> ${totDep.baixadas}`],
      ['no C.I. nao mudou',             totDep.no_ci === totAntes.no_ci, `${totAntes.no_ci} -> ${totDep.no_ci}`],
      ['estornadas nao mudaram',        totDep.estornadas === totAntes.estornadas, `${totAntes.estornadas} -> ${totDep.estornadas}`],
      ['finais nao mudaram',            totDep.finais === totAntes.finais, `${totAntes.finais} -> ${totDep.finais}`],
      ['a SOMA DOS VALORES nao mudou',  totDep.soma_valor === totAntes.soma_valor, `${totAntes.soma_valor}`],
    ];

    nl('\n── CONFERENCIA DEPOIS DE ESCREVER ────────────────────────');
    let falhou = false;
    for (const [nome, ok, v] of checks) {
      if (!ok) falhou = true;
      nl(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(32)} ${v}`);
    }

    if (falhou) {
      await cli.query('ROLLBACK'); nl('\n>> CONFERENCIA FALHOU: ROLLBACK.'); process.exitCode = 2;
    } else if (GRAVAR) {
      fs.writeFileSync(ARQ_REVERSAO, JSON.stringify({
        quando: new Date().toISOString(),
        // Para desfazer, na ordem: DROP TABLE solicitacao_correcao;
        //                          ALTER TABLE prestacoes_contas DROP COLUMN baixado_por;
        //                          ALTER TABLE prestacoes_contas DROP COLUMN enviado_ci_por;
        desfazer: [
          'DROP TABLE IF EXISTS solicitacao_correcao',
          'ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS baixado_por',
          'ALTER TABLE prestacoes_contas DROP COLUMN IF EXISTS enviado_ci_por',
        ],
        ja_existia: { colunas: existiaCol, tabela: !!existiaTab },
        backfill: { baixado_por: bxA.map(r => r.codigo_pc), enviado_ci_por: ciA.map(r => r.codigo_pc) },
      }, null, 1));
      await cli.query('COMMIT');
      nl('\n>> COMMIT. Gravado.');
      nl(`   Para desfazer: ${ARQ_REVERSAO}`);
    } else {
      await cli.query('ROLLBACK'); nl('\n>> DRY-RUN: ROLLBACK. Nada gravado.');
    }
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    console.error('\nERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
})();
