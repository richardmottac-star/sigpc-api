// Backfill de parcial_num nas PCs PENDENTES (as baixadas ja tem, vindas da recarga).
//
// ═════════════════════════════════════════════════════════════════════════════════════════
// ⚠️⚠️ NAO RODE ESTE SCRIPT DE NOVO. O METODO DELE FOI REFUTADO EM 16/08/2026.
//
// O cabecalho dizia: "Uma parcial = (tr, processo_pc). Verificado: nas 2.125 chaves ja
// numeradas, nenhuma tem mais de um parcial_num — a relacao e' funcional."
//
// ⚠️ ERA VERDADE SOBRE O BANCO, E FALSO SOBRE O SIGEF. O "verificado" olhou o dado de saida
// da propria migracao e chamou o padrao dele de regra. Medido depois no estoque oficial da
// CGE, por dois agentes cegos um ao outro:
//     um processo com varias parcelas ..... 113 pares · 78 TRs · 465 PCs
//     uma parcela com varios processos .....  81 pares · 55 TRs · 268 PCs
// A relacao e' N:N nos DOIS sentidos. Ver a armadilha 16 do CLAUDE.md.
//
// Consequencia: o `herd` (linha ~75) herda o numero pelo `processo_pc`, ou seja, da UM numero
// por processo — o mesmo colapso da recarga de 05/08. E a numeracao que ele inventa para o
// resto vem de `parcela_seq`, caminho MEDIDO E REPROVADO em 13/08 (armadilha 16-C).
//
// O SUCESSOR e' o `renumerar_sigef.js`, que le o numero da CGE em vez de deduzi-lo do
// processo. O que fica AQUI e' historia.
// ═════════════════════════════════════════════════════════════════════════════════════════
//
// PADRAO = DRY-RUN. So grava com --gravar.
// ATENCAO: a numeracao atribuida aqui NAO vem da planilha do analista; e' derivada
// de parcela_seq. Pode divergir do numero que o analista conhece. Ver relatorio.
const GRAVAR = process.argv.includes('--gravar')
const TAB_BACKUP = '_backup_parcial_num_20260805'
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

;(async () => {
  const cli = await pool.connect()
  try {
    await cli.query('BEGIN')

    // Backup do estado anterior, para reverter depois do commit se precisar.
    await cli.query(`
      CREATE TABLE IF NOT EXISTS ${TAB_BACKUP} AS
      SELECT id, parcial_num FROM prestacoes_contas WHERE setorial_id='FCEE'
    `)
    const { rows: bk } = await cli.query(`SELECT COUNT(*)::int n FROM ${TAB_BACKUP}`)
    console.log(`backup ${TAB_BACKUP}: ${bk[0].n} linhas\n`)

    // ⚠️ "uma parcial nunca deve juntar processos SGPE diferentes" — era o que o check
    // abaixo exigia, abortando com mais de 5. O estoque da CGE mede 81 chaves nessa situacao
    // (55 TRs, 268 PCs): juntar processos e' o dado NORMAL, nao defeito, e o `<= 5` mandaria
    // ROLLBACK para sempre. Virou comparacao antes/depois — a rodada so' precisa provar que
    // nao AUMENTOU o que encontrou. Medido ANTES de escrever, por isso esta aqui em cima.
    const contarMultiProc = async () => (await cli.query(`
      SELECT COUNT(*)::int n FROM (
        SELECT tr, parcial_num FROM prestacoes_contas
         WHERE setorial_id='FCEE' AND parcial_num IS NOT NULL
         GROUP BY 1,2 HAVING COUNT(DISTINCT processo_pc) > 1) t
    `)).rows[0].n
    const multiProcAntes = await contarMultiProc()

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
    const multiProcDepois = await contarMultiProc()

    // TRAVA PRINCIPAL: a numeracao das baixadas veio da planilha do analista.
    // Se qualquer baixada for renumerada, a produtividade deixa de bater — aborta.
    const { rows: alt } = await cli.query(`
      SELECT COUNT(*)::int renumeradas FROM prestacoes_contas p
        JOIN ${TAB_BACKUP} b ON b.id = p.id
       WHERE p.setorial_id='FCEE' AND p.baixada
         AND b.parcial_num IS NOT NULL
         AND p.parcial_num IS DISTINCT FROM b.parcial_num
    `)
    // Nenhuma PC que ja tinha numero pode ter sido alterada, baixada ou nao.
    const { rows: alt2 } = await cli.query(`
      SELECT COUNT(*)::int alteradas FROM prestacoes_contas p
        JOIN ${TAB_BACKUP} b ON b.id = p.id
       WHERE p.setorial_id='FCEE'
         AND b.parcial_num IS NOT NULL
         AND p.parcial_num IS DISTINCT FROM b.parcial_num
    `)

    console.log(`PCs que herdaram o numero do processo : ${herd.rowCount}`)
    console.log(`PCs 'final' numeradas como FINAL      : ${fin.rowCount}`)
    console.log(`PCs pendentes numeradas               : ${upd.rowCount}`)
    console.log(`   total numerado                     : ${herd.rowCount + fin.rowCount + upd.rowCount}`)

    console.log('\n── VALIDACAO ──────────────────────────────────────')
    const checks = [
      ['PCs sem parcial_num == 0',                chk[0].sem === 0,                                 `${chk[0].sem} de ${chk[0].total}`],
      ['baixadas renumeradas == 0',               alt[0].renumeradas === 0,                         `${alt[0].renumeradas}`],
      ['PCs ja numeradas alteradas == 0',         alt2[0].alteradas === 0,                          `${alt2[0].alteradas}`],
      ['parciais juntando >1 SGPE nao aumentou',  multiProcDepois <= multiProcAntes,                `${multiProcAntes} -> ${multiProcDepois}`]
    ]
    let falhou = false
    for (const [nome, ok, valor] of checks) {
      if (!ok) falhou = true
      console.log(`   ${ok ? 'OK  ' : 'FALHA'}  ${nome.padEnd(50)} ${valor}`)
    }
    console.log(`\nparciais distintas (tr|num)           : ${chk[0].parciais}`)

    if (falhou)       { await cli.query('ROLLBACK'); console.log('\n>> VALIDACAO FALHOU: ROLLBACK. Nada gravado.'); process.exitCode = 2 }
    else if (GRAVAR)  { await cli.query('COMMIT');   console.log('\n>> COMMIT.'); console.log(`\nPara reverter:\n  UPDATE prestacoes_contas p SET parcial_num=b.parcial_num\n    FROM ${TAB_BACKUP} b WHERE b.id=p.id;`) }
    else              { await cli.query('ROLLBACK'); console.log('\n>> DRY-RUN: ROLLBACK. Rode com --gravar para aplicar.') }
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch {}
    console.error('ERRO — ROLLBACK: ' + e.message)
    process.exitCode = 1
  } finally {
    cli.release(); await pool.end()
  }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1) })
