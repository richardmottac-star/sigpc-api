const { Pool } = require('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
})

// Sem --commit: roda tudo dentro da transação, mostra antes/depois e dá ROLLBACK (preview).
// Com --commit: mesma coisa, mas dá COMMIT no final.
const COMMIT = process.argv.includes('--commit')

const WHERE_ESTOQUE = `tecnico_nome = 'Richard' AND assumido_em >= '2026-07-18'`
const WHERE_PLANILHA = `analista = 'Richard' AND atualizado_em >= '2026-07-18'`

async function run() {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')

    const antesEst = await c.query(`SELECT COUNT(*) FROM estoque WHERE ${WHERE_ESTOQUE}`)
    const antesPl = await c.query(`SELECT COUNT(*) FROM planilha_analista WHERE ${WHERE_PLANILHA}`)
    console.log('--- ANTES ---')
    console.log('estoque a reverter: ' + antesEst.rows[0].count)
    console.log('planilha_analista a remover: ' + antesPl.rows[0].count)

    const updEst = await c.query(`
      UPDATE estoque
      SET status = 'livre', tecnico_nome = NULL, tecnico_id = NULL, assumido_em = NULL,
          atualizado_em = NOW()
      WHERE ${WHERE_ESTOQUE}`)

    const delPl = await c.query(`DELETE FROM planilha_analista WHERE ${WHERE_PLANILHA}`)

    const depoisEst = await c.query(`SELECT COUNT(*) FROM estoque WHERE ${WHERE_ESTOQUE}`)
    const depoisPl = await c.query(`SELECT COUNT(*) FROM planilha_analista WHERE ${WHERE_PLANILHA}`)
    console.log('--- DEPOIS (dentro da transação) ---')
    console.log('estoque atualizados: ' + updEst.rowCount + ' | ainda batendo no filtro: ' + depoisEst.rows[0].count)
    console.log('planilha_analista removidos: ' + delPl.rowCount + ' | ainda batendo no filtro: ' + depoisPl.rows[0].count)

    if (COMMIT) {
      await c.query('COMMIT')
      console.log('>>> COMMIT aplicado. Alterações persistidas.')
    } else {
      await c.query('ROLLBACK')
      console.log('>>> PREVIEW apenas — ROLLBACK aplicado. Nenhuma alteração foi persistida.')
      console.log('>>> Para aplicar de verdade: node desfazer_assuncoes.js --commit')
    }
  } catch (e) {
    await c.query('ROLLBACK')
    console.error('ERRO, rollback executado:', e.message)
  } finally {
    c.release(); await pool.end()
  }
}
run()
