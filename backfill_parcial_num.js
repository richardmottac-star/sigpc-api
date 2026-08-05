// Backfill de parcial_num nas PCs PENDENTES (as baixadas ja tem, vindas da recarga).
// Uma parcial = (tr, processo_pc). Verificado: nas 2.125 chaves ja numeradas,
// nenhuma tem mais de um parcial_num — a relacao e' funcional.
//
// PADRAO = DRY-RUN. So grava com --gravar.
// ATENCAO: a numeracao atribuida aqui NAO vem da planilha do analista; e' derivada
// de parcela_seq. Pode divergir do numero que o analista conhece. Ver relatorio.
const GRAVAR = process.argv.includes('--gravar')
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

;(async () => {
  const cli = await pool.connect()
  try {
    await cli.query('BEGIN')

    // toda PC 'final' recebe FINAL, como ja fez a recarga
    const fin = await cli.query(`
      UPDATE prestacoes_contas SET parcial_num='FINAL'
       WHERE setorial_id='FCEE' AND tipo='final' AND parcial_num IS NULL
    `)

    // Passo 1: se o processo ja tem numero (veio de uma PC irma baixada), as
    // pendentes do MESMO processo herdam esse numero. Sem isso o mesmo SGPE
    // ganharia dois parcial_num e a parcial juntaria processos diferentes.
    const herd = await cli.query(`
      WITH ja AS (
        SELECT tr, processo_pc, MIN(parcial_num) AS num
          FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND parcial_num IS NOT NULL AND processo_pc IS NOT NULL
         GROUP BY 1,2
      )
      UPDATE prestacoes_contas p
         SET parcial_num = ja.num, atualizado_em = NOW()
        FROM ja
       WHERE p.setorial_id='FCEE' AND p.parcial_num IS NULL
         AND p.tr = ja.tr AND p.processo_pc = ja.processo_pc
    `)
    console.log(`PCs que herdaram o numero do proprio processo: ${herd.rowCount}`)

    // Passo 2: numera os processos que continuam sem numero, por TR, continuando
    // a partir do maior numero ja existente naquele TR — nao renumera as baixadas.
    const upd = await cli.query(`
      WITH base AS (
        SELECT tr, processo_pc, MIN(parcela_seq) AS ordem
          FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND parcial_num IS NULL AND tipo <> 'final'
         GROUP BY tr, processo_pc
      ),
      maxtr AS (
        -- o ::int vai DENTRO do MAX: em texto, '9' > '17' e a numeracao colidiria
        SELECT tr, COALESCE(MAX(NULLIF(regexp_replace(parcial_num,'[^0-9]','','g'),'')::int), 0) AS maxnum
          FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND parcial_num IS NOT NULL
         GROUP BY tr
      ),
      numerado AS (
        SELECT b.tr, b.processo_pc,
               COALESCE(m.maxnum,0) + ROW_NUMBER() OVER (PARTITION BY b.tr ORDER BY b.ordem, b.processo_pc) AS novo
          FROM base b LEFT JOIN maxtr m ON m.tr = b.tr
      )
      UPDATE prestacoes_contas p
         SET parcial_num = n.novo::text, atualizado_em = NOW()
        FROM numerado n
       WHERE p.setorial_id='FCEE' AND p.parcial_num IS NULL
         AND p.tr = n.tr AND p.processo_pc IS NOT DISTINCT FROM n.processo_pc
    `)

    const { rows: chk } = await cli.query(`
      SELECT COUNT(*) FILTER (WHERE parcial_num IS NULL)::int sem,
             COUNT(*)::int total,
             COUNT(DISTINCT (tr||'|'||COALESCE(parcial_num,'?')))::int parciais
        FROM prestacoes_contas WHERE setorial_id='FCEE'
    `)
    // uma parcial nunca deve juntar processos SGPE diferentes
    const { rows: conf } = await cli.query(`
      SELECT COUNT(*)::int chaves_com_mais_de_um_processo FROM (
        SELECT tr, parcial_num FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND parcial_num IS NOT NULL
         GROUP BY 1,2 HAVING COUNT(DISTINCT processo_pc) > 1) t
    `)

    console.log(`PCs 'final' numeradas como FINAL : ${fin.rowCount}`)
    console.log(`PCs pendentes numeradas          : ${upd.rowCount}`)
    console.log(`\nrestam sem parcial_num          : ${chk[0].sem} de ${chk[0].total}`)
    console.log(`parciais distintas (tr|num)      : ${chk[0].parciais}`)
    console.log(`parciais juntando >1 SGPE        : ${conf[0].chaves_com_mais_de_um_processo}  (eram 5 antes)`)

    if (GRAVAR) { await cli.query('COMMIT'); console.log('\n>> COMMIT.') }
    else        { await cli.query('ROLLBACK'); console.log('\n>> DRY-RUN: ROLLBACK. Rode com --gravar para aplicar.') }
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch {}
    console.error('ERRO — ROLLBACK: ' + e.message)
    process.exitCode = 1
  } finally {
    cli.release(); await pool.end()
  }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1) })
