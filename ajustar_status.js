const { Pool } = require('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
})

async function run() {
  const c = await pool.connect()
  try {
    const upd = await c.query(`
      UPDATE prestacoes_contas
      SET status = CASE
        WHEN baixada = true THEN 'baixada'
        WHEN analista_nome IS NULL THEN 'livre'
        WHEN situacao_origem ILIKE '%diligência%' OR situacao_origem ILIKE '%diligencia%' THEN 'diligencia'
        WHEN situacao_origem ILIKE '%reanálise%' OR situacao_origem ILIKE '%reanalise%' THEN 'reanalise'
        ELSE 'analise'
      END,
      atualizado_em = NOW()`)
    console.log('Linhas atualizadas: ' + upd.rowCount)

    const r = await c.query(`
      SELECT status, COUNT(*) n FROM prestacoes_contas GROUP BY status ORDER BY status`)
    console.table(r.rows)
  } finally {
    c.release(); await pool.end()
  }
}
run()
