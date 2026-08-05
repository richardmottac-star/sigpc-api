// T1 — Migracao ADITIVA para baixa por parcial. Nada destrutivo.
// Rode com --dry para ver o que mudaria sem gravar.
// NAO COMMITAR credencial; usa DATABASE_URL do ambiente.
const DRY = process.argv.includes('--dry')
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

;(async () => {
  const cli = await pool.connect()
  try {
    await cli.query('BEGIN')

    // ── colunas novas ────────────────────────────────────────────────
    // enviado_ci e dt_envio_ci JA EXISTEM e ja sao usadas pelo server.js.
    // O prompt pedia "data_envio_ci"; criar seria coluna duplicada, entao
    // reaproveitamos dt_envio_ci. parecer_ci e situacao_atual sao novas.
    await cli.query(`
      ALTER TABLE prestacoes_contas
        ADD COLUMN IF NOT EXISTS enviado_ci     boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS dt_envio_ci    timestamp,
        ADD COLUMN IF NOT EXISTS parecer_ci     text,
        ADD COLUMN IF NOT EXISTS situacao_atual text
    `)

    await cli.query(`
      CREATE TABLE IF NOT EXISTS parcela_historico (
        id serial PRIMARY KEY,
        tr text, parcial_num text, setorial_id text,
        evento text, valor_anterior text, valor_novo text,
        analista_id integer, observacao text,
        criado_em timestamp DEFAULT now()
      )
    `)
    await cli.query(`CREATE INDEX IF NOT EXISTS idx_parcela_hist_tr ON parcela_historico (tr, parcial_num, setorial_id)`)
    await cli.query(`CREATE INDEX IF NOT EXISTS idx_pc_tr_parcial   ON prestacoes_contas (setorial_id, tr, parcial_num)`)

    // ── migracao dos CI historicos ───────────────────────────────────
    // parecer_tipo NUNCA guarda "Encaminhado ao CI" (D2). Move para o campo proprio.
    const { rows: antes } = await cli.query(`
      SELECT parecer_tipo, COUNT(*)::int n
        FROM prestacoes_contas
       WHERE parecer_tipo ILIKE '%controle interno%'
       GROUP BY 1 ORDER BY 2 DESC
    `)
    console.log('CI hoje em parecer_tipo:')
    if (!antes.length) console.log('   (nenhum)')
    antes.forEach(r => console.log(`   ${r.n.toString().padStart(4)}  ${JSON.stringify(r.parecer_tipo)}`))

    const mig = await cli.query(`
      UPDATE prestacoes_contas
         SET enviado_ci   = true,
             dt_envio_ci  = COALESCE(dt_envio_ci, data_baixa, NOW()),
             parecer_tipo = NULL,
             atualizado_em = NOW()
       WHERE parecer_tipo ILIKE '%controle interno%'
       RETURNING codigo_pc
    `)
    console.log(`\nPCs migradas para enviado_ci: ${mig.rowCount}`)

    // registra a migracao no historico, agrupada por parcela
    if (mig.rowCount > 0) {
      await cli.query(`
        INSERT INTO parcela_historico (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, observacao)
        SELECT tr, parcial_num, setorial_id, 'migracao_ci',
               'parecer_tipo = Encaminhado ao Controle Interno', 'enviado_ci = true',
               'T1: CI deixou de ser parecer e virou campo proprio'
          FROM prestacoes_contas
         WHERE codigo_pc = ANY($1)
         GROUP BY tr, parcial_num, setorial_id
      `, [mig.rows.map(r => r.codigo_pc)])
    }

    // ── situacao_atual inicial, derivada do status ───────────────────
    const sit = await cli.query(`
      UPDATE prestacoes_contas
         SET situacao_atual = CASE status
               WHEN 'analise'    THEN 'Em análise'
               WHEN 'diligencia' THEN 'Diligência'
               WHEN 'reanalise'  THEN 'Reanálise'
             END
       WHERE situacao_atual IS NULL
         AND status IN ('analise','diligencia','reanalise')
    `)
    console.log(`situacao_atual preenchida a partir do status: ${sit.rowCount}`)

    // ── conferencias ─────────────────────────────────────────────────
    const { rows: chk } = await cli.query(`
      SELECT COUNT(*) FILTER (WHERE parecer_tipo ILIKE '%controle interno%')::int ci_em_parecer,
             COUNT(*) FILTER (WHERE enviado_ci)::int                              enviado_ci,
             COUNT(*) FILTER (WHERE baixada)::int                                 baixadas,
             COUNT(*) FILTER (WHERE baixada AND parecer_tipo IS NULL)::int         baixada_sem_parecer,
             COUNT(*) FILTER (WHERE parcial_num IS NULL)::int                      sem_parcial_num,
             COUNT(*)::int                                                         total
        FROM prestacoes_contas WHERE setorial_id='FCEE'
    `)
    console.log('\nconferencia (FCEE):', JSON.stringify(chk[0], null, 1))

    const { rows: cols } = await cli.query(`
      SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name='prestacoes_contas'
         AND column_name IN ('enviado_ci','dt_envio_ci','parecer_ci','situacao_atual','parcial_num','tipo')
       ORDER BY column_name
    `)
    console.log('\ncolunas:')
    cols.forEach(c => console.log(`   ${c.column_name.padEnd(16)} ${c.data_type}`))

    if (DRY) { await cli.query('ROLLBACK'); console.log('\n>> DRY-RUN: ROLLBACK. Nada gravado.') }
    else     { await cli.query('COMMIT');   console.log('\n>> COMMIT.') }
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch {}
    console.error('ERRO — ROLLBACK: ' + e.message)
    process.exitCode = 1
  } finally {
    cli.release(); await pool.end()
  }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1) })
