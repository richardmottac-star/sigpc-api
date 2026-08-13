// CAMINHO: sigpc-api/renumerar_parcial_num.js
//
// RENUMERA parcial_num para bater com o SIGEF.  PADRAO = DRY-RUN. So grava com --gravar.
//
// ⚠️ NAO e' o caminho que estava escrito no SESSAO.md ("renumerar tudo por parcela_seq").
// Aquele caminho foi MEDIDO em 13/08 contra o gabarito e REPROVADO: reescrevia 592 parcelas
// (1.017 PCs, 67 TRs) cujo rotulo veio da planilha do analista — ou seja, do SIGEF.
// Entre elas a propria 2020TR000704, onde 44 dos 48 rotulos conferidos mudariam.
// A ordem de parcela_seq NAO e' a ordem do SIGEF.
//
// O CAMINHO CERTO — preservar e preencher a lacuna:
//   1. O rotulo que veio da planilha (backup de 05/08, numerico) e' o numero do SIGEF. FICA.
//   2. Para cada TR: N = numero de parcelas = COUNT(DISTINCT processo_pc) entre as nao-finais.
//   3. Os numeros livres de 1..N (os que nenhuma planilha usou) vao para as parcelas sem
//      rotulo, na ordem de parcela_seq.
//   4. O grupo processo_pc = '-1' vai por ULTIMO na fila. Ele e' dado duvidoso (79 PCs, ver
//      pcs_sgpe_-1.csv); nao pode empurrar parcela legitima para o numero errado. Foi isso
//      que colocou a SCC 00010835/2023 da 637 no 16 — entre a 15 e a 17, onde o SGPe manda.
//
// RESULTADO MEDIDO: 1.545 das 1.554 TRs ficam 1..N contiguo.
//   2020TR000704 -> 1..57  (SIGEF: 1..57) ✓  com os 48 rotulos da planilha intactos
//   2020TR000637 -> 1..20  (SIGEF: 1..19)    a sobra e' o grupo '-1', que e' problema de
//                                            DADO, nao de numeracao — fica no 20, isolado.
//
// AS 9 TRs QUE SOBRAM NAO SAO PROBLEMA DE NUMERACAO:
//   7 tem rotulo de planilha ACIMA do total de parcelas (623, 638, 681, 718, 722, 809, 2385,
//     967) — o SIGEF tem parcela que a nossa base nao tem. Falta DADO.
//   2 tem o mesmo SGPe escrito de dois jeitos (791: 'SCC 4813/2024' e 'SCC 00004813/2024';
//     967: 'SCC15029/2022' e 'SCC 00015029/2022') — falta NORMALIZAR o SGPe.
//   Nas 9, a TR e' deixada EXATAMENTE COMO ESTA. Renumerar sem o dado inventaria rotulo.
//
// ⚠️ NAO TOCA em baixada, data_baixa, enviado_ci, parecer_tipo, parecer_ci, valor, status,
//    analista_id nem ci_*. O UPDATE mexe em parcial_num e atualizado_em. So.
// ⚠️ NAO TOCA nas PCs tipo='final' (parcial_num FINAL/Final/final).  A final nao e' parcial.
// ⚠️ Reversao por LISTA EXPLICITA de chaves (regra 12), capturada ANTES da escrita.

const GRAVAR   = process.argv.includes('--gravar')
const FORCAR   = process.argv.includes('--forcar') // ignora a trava de janela. Use com motivo.
const TAB_BK   = '_backup_parcial_num_20260813'   // backup da numeracao de HOJE, 13/08
const TAB_REF  = '_backup_parcial_num_20260805'   // rotulos da planilha (pre-backfill)
const TAB_HIST = '_backup_parcela_historico_20260813'

const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

// uma parcela = (tr, processo_pc); sigef = rotulo numerico que a planilha deu, no backup 05/08
const PLANO = `
  WITH par AS (
    SELECT p.tr, p.processo_pc, MIN(p.parcela_seq) AS ordem,
           MIN(r.parcial_num) FILTER (WHERE r.parcial_num ~ '^[0-9]+$') AS sigef
      FROM prestacoes_contas p
      JOIN ${TAB_REF} r ON r.id = p.id
     WHERE p.setorial_id='FCEE' AND p.tipo <> 'final'
     GROUP BY p.tr, p.processo_pc
  ),
  tot AS (SELECT tr, COUNT(*)::int n FROM par GROUP BY tr),
  usados AS (SELECT tr, sigef::int v FROM par WHERE sigef IS NOT NULL),
  -- numeros de 1..N que nenhuma planilha usou
  livres AS (
    SELECT t.tr, g.v, ROW_NUMBER() OVER (PARTITION BY t.tr ORDER BY g.v) AS pos
      FROM tot t CROSS JOIN LATERAL generate_series(1, t.n) AS g(v)
     WHERE NOT EXISTS (SELECT 1 FROM usados u WHERE u.tr=t.tr AND u.v=g.v)
  ),
  -- as parcelas sem rotulo, na ordem de parcela_seq, com o '-1' por ultimo
  semrotulo AS (
    SELECT tr, processo_pc,
           ROW_NUMBER() OVER (PARTITION BY tr
             ORDER BY (processo_pc = '-1') ASC, ordem NULLS LAST, processo_pc) AS pos
      FROM par WHERE sigef IS NULL
  ),
  bruto AS (
    SELECT p.tr, p.processo_pc, COALESCE(p.sigef::int, l.v) AS novo
      FROM par p
      LEFT JOIN semrotulo s ON s.tr = p.tr AND s.processo_pc IS NOT DISTINCT FROM p.processo_pc
      LEFT JOIN livres    l ON l.tr = s.tr AND l.pos = s.pos
  ),
  -- TRAVA: so entram as TRs que fecham 1..N sem furo, sem repetido e sem parcela sem numero.
  -- As outras 9 sao problema de dado; ficam intocadas.
  boas AS (
    SELECT b.tr FROM bruto b JOIN tot t ON t.tr = b.tr
     GROUP BY b.tr, t.n
    HAVING COUNT(*) = t.n AND COUNT(b.novo) = t.n
       AND MIN(b.novo) = 1 AND MAX(b.novo) = t.n AND COUNT(DISTINCT b.novo) = t.n
  )
  SELECT b.tr, b.processo_pc, b.novo FROM bruto b JOIN boas ON boas.tr = b.tr
`

const ALVO = `
  SELECT p.id, p.codigo_pc, p.tr, p.parcial_num AS antes, n.novo::text AS depois
    FROM prestacoes_contas p
    JOIN (${PLANO}) n ON n.tr = p.tr AND n.processo_pc IS NOT DISTINCT FROM p.processo_pc
   WHERE p.setorial_id='FCEE' AND p.tipo <> 'final'
     AND p.parcial_num IS DISTINCT FROM n.novo::text
`

// parcela_historico guarda (tr, parcial_num) em TEXTO, nao codigo_pc. Renumerar sem mexer
// aqui deixa a linha apontando para um numero que passou a ser de OUTRA parcela.
// ⚠️ O mapa tem de ser lido ANTES do UPDATE das PCs: depois, h.parcial_num nao casa mais.
// So entra linha cujo (tr, parcial_num) resolve para UM unico numero novo — nas TRs de SGPe
// ambiguo isso daria dois, e a linha fica como esta.
const MAPA_HIST = `
  SELECT h.id, MIN(n.novo)::int AS novo, h.tr, h.parcial_num AS antes
    FROM parcela_historico h
    JOIN prestacoes_contas p
      ON p.setorial_id = h.setorial_id AND p.tr = h.tr AND p.parcial_num = h.parcial_num
     AND p.tipo <> 'final'
    JOIN (${PLANO}) n
      ON n.tr = p.tr AND n.processo_pc IS NOT DISTINCT FROM p.processo_pc
   GROUP BY h.id, h.tr, h.parcial_num
  HAVING COUNT(DISTINCT n.novo) = 1
     AND MIN(n.novo)::text IS DISTINCT FROM h.parcial_num
`

// ⚠️ NAO GRAVAR COM A EQUIPE NA TELA. Os numeros trocam sob os pes de quem esta com a
// Minha Planilha aberta, e um parecer aberto na "parcela 21" grava na que virou 21.
// Mesma regra de online do sistema: ativo em 30 min E sem logout depois disso.
const ONLINE = `
  SELECT id, nome, perfil, to_char((ultimo_acesso AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS visto
    FROM usuarios
   WHERE ultimo_acesso >= NOW() - INTERVAL '30 minutes'
     AND (sessao_fim IS NULL OR sessao_fim < ultimo_acesso)
   ORDER BY ultimo_acesso DESC
`
// Segunda rede: escrita recente no acervo, mesmo sem sessao aberta.
const ESCRITA_RECENTE = `
  SELECT COUNT(*)::int n, to_char((MAX(atualizado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS ultima
    FROM prestacoes_contas
   WHERE atualizado_em >= NOW() - INTERVAL '30 minutes'
`

;(async () => {
  const cli = await pool.connect()
  try {
    // 0. A TRAVA DE JANELA. Roda ANTES do BEGIN, e so barra quem vai gravar.
    const { rows: online } = await cli.query(ONLINE)
    const { rows: esc }    = await cli.query(ESCRITA_RECENTE)

    // ⚠️ O SUPERADMIN NAO BLOQUEIA — mesma regra do janela_livre.js, e pelo mesmo motivo.
    //
    // O modo manutencao carimba `sessao_fim` em todos MENOS no superadmin, de proposito: e
    // ele quem precisa continuar entrando. So que e' o mesmo que acabou de ligar o modo e
    // esta rodando este script — contando-o, a trava recusaria para sempre, e o modo
    // manutencao nao serviria para nada. Aconteceu de verdade em 12/08, na primeira
    // gravacao: janela_livre disse LIVRE e o script recusou, porque so um dos dois tinha
    // sido corrigido. Os dois criterios TEM de ser o mesmo.
    //
    // Seguro porque quem grava e' ele, sabendo o que faz — e uma escrita real dele ainda
    // aparece em ESCRITA_RECENTE.
    const bloqueiam = online.filter(u => u.perfil !== 'superadmin')
    const admins    = online.filter(u => u.perfil === 'superadmin')

    console.log('── JANELA ────────────────────────────────────────────')
    console.log(`   online agora .......... ${bloqueiam.length}`)
    bloqueiam.forEach(u => console.log(`      ${u.nome} (${u.perfil}) — visto ${u.visto}`))
    admins.forEach(u => console.log(`      ${u.nome} (superadmin — nao bloqueia) — visto ${u.visto}`))
    console.log(`   PCs escritas em 30 min  ${esc[0].n}${esc[0].ultima ? '   ultima: ' + esc[0].ultima : ''}`)
    const ocupado = bloqueiam.length > 0 || esc[0].n > 0
    if (GRAVAR && ocupado && !FORCAR) {
      console.log('\n>> RECUSADO: ha gente trabalhando. Nada gravado.')
      console.log('   Rode `node janela_livre.js` ate dar LIVRE, ou force com --forcar.')
      process.exitCode = 3
      return
    }
    if (!ocupado) console.log('   >> LIVRE')
    else console.log('   >> OCUPADO' + (GRAVAR ? ' — seguindo por --forcar' : ' (dry-run segue; nao grava nada)'))

    await cli.query('BEGIN')

    // 1. AS LISTAS, capturadas ANTES de escrever. Sao elas que fazem o WHERE e a reversao.
    const { rows: hist } = await cli.query(MAPA_HIST)      // <- primeiro: depende do valor VELHO
    const { rows: alvo } = await cli.query(ALVO)
    const codigos = alvo.map(r => r.codigo_pc)
    const histIds = hist.map(r => r.id)
    console.log(`\nPCs a renumerar: ${codigos.length} em ${new Set(alvo.map(r => r.tr)).size} TRs`)
    console.log(`linhas de parcela_historico a realinhar: ${histIds.length}`)
    hist.forEach(h => console.log(`   id=${String(h.id).padStart(3)} ${h.tr}  ${h.antes} -> ${h.novo}`))
    if (!codigos.length) { await cli.query('ROLLBACK'); console.log('Nada a fazer.'); return }

    // 2. O UPDATE das PCs, por lista explicita de chaves.
    const upd = await cli.query(`
      UPDATE prestacoes_contas p
         SET parcial_num = n.novo::text, atualizado_em = NOW()
        FROM (${PLANO}) n
       WHERE p.codigo_pc = ANY($1)
         AND n.tr = p.tr AND n.processo_pc IS NOT DISTINCT FROM p.processo_pc
    `, [codigos])
    console.log(`\nlinhas atualizadas em prestacoes_contas: ${upd.rowCount}`)

    // 3. O UPDATE do historico, pelo mapa capturado no passo 1 — por lista de ids.
    // Backup dentro da transacao: no dry-run o ROLLBACK o descarta junto.
    await cli.query(`DROP TABLE IF EXISTS ${TAB_HIST}`)
    await cli.query(`CREATE TABLE ${TAB_HIST} AS SELECT * FROM parcela_historico`)
    let updHist = { rowCount: 0 }
    if (histIds.length) {
      updHist = await cli.query(`
        UPDATE parcela_historico h
           SET parcial_num = m.novo::text
          FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::int[]) AS novo) m
         WHERE h.id = m.id AND h.id = ANY($1::int[])
      `, [histIds, hist.map(r => r.novo)])
    }
    console.log(`linhas atualizadas em parcela_historico  : ${updHist.rowCount}`)

    // 4. VALIDACAO — tudo tem de passar, senao ROLLBACK.
    const un = async (sql, p) => (await cli.query(sql, p)).rows[0]

    const c1 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN ${TAB_REF} r ON r.id=p.id
                          WHERE p.setorial_id='FCEE' AND p.tipo <> 'final'
                            AND r.parcial_num ~ '^[0-9]+$' AND p.parcial_num IS DISTINCT FROM r.parcial_num`)
    const c2 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN ${TAB_BK} b ON b.id=p.id
                          WHERE p.baixada IS DISTINCT FROM b.baixada`)
    const c3 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN ${TAB_BK} b ON b.id=p.id
                          WHERE p.tipo='final' AND p.parcial_num IS DISTINCT FROM b.parcial_num`)
    const c4 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas p JOIN ${TAB_BK} b ON b.id=p.id
                          WHERE p.parcial_num IS DISTINCT FROM b.parcial_num AND NOT (p.codigo_pc = ANY($1))`, [codigos])
    const c5 = await un(`SELECT COUNT(*)::int n FROM (
                           SELECT tr, processo_pc FROM prestacoes_contas
                            WHERE setorial_id='FCEE' AND tipo <> 'final'
                            GROUP BY 1,2 HAVING COUNT(DISTINCT parcial_num) > 1) t`)
    const c6 = await un(`SELECT COUNT(*)::int n FROM prestacoes_contas WHERE setorial_id='FCEE' AND parcial_num IS NULL`)
    const c7 = await un(`SELECT COUNT(*)::int n FROM (
                           SELECT tr FROM prestacoes_contas
                            WHERE setorial_id='FCEE' AND tipo <> 'final' AND parcial_num ~ '^[0-9]+$'
                            GROUP BY tr
                           HAVING MAX(parcial_num::int) <> COUNT(DISTINCT processo_pc)
                               OR COUNT(DISTINCT parcial_num) <> COUNT(DISTINCT processo_pc)) t`)
    // historico: nenhuma linha pode ficar apontando para parcela que nao existe mais.
    // A 'FINAL' fica de fora — a PC final nao e' parcial e nao foi renumerada.
    const c8 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h
                          WHERE h.parcial_num ~ '^[0-9]+$'
                            AND NOT EXISTS (SELECT 1 FROM prestacoes_contas p
                                             WHERE p.setorial_id=h.setorial_id AND p.tr=h.tr
                                               AND p.parcial_num=h.parcial_num AND p.tipo <> 'final')`)
    // e nenhuma linha fora do mapa pode ter sido tocada
    const c9 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h JOIN ${TAB_HIST} b ON b.id=h.id
                          WHERE h.parcial_num IS DISTINCT FROM b.parcial_num AND NOT (h.id = ANY($1::int[]))`,
                        [histIds.length ? histIds : [-1]])
    // e nada alem de parcial_num pode ter mudado no historico
    const c10 = await un(`SELECT COUNT(*)::int n FROM parcela_historico h JOIN ${TAB_HIST} b ON b.id=h.id
                           WHERE (h.tr, h.setorial_id, h.evento, h.valor_anterior, h.valor_novo,
                                  h.analista_id, h.criado_em) IS DISTINCT FROM
                                 (b.tr, b.setorial_id, b.evento, b.valor_anterior, b.valor_novo,
                                  b.analista_id, b.criado_em)`)

    const checks = [
      ['rotulo da planilha (SIGEF) alterado',        c1.n === 0, c1.n],
      ['baixada alterada',                           c2.n === 0, c2.n],
      ['PC final renumerada',                        c3.n === 0, c3.n],
      ['PC fora da lista alterada',                  c4.n === 0, c4.n],
      ['parcela partida em 2 numeros',               c5.n === 0, c5.n],
      ['PC sem parcial_num',                         c6.n === 0, c6.n],
      ['TRs que NAO fecham 1..N (esperado: 9)',      c7.n === 9, c7.n],
      ['historico apontando para parcela inexistente', c8.n === 0, c8.n],
      ['historico fora do mapa alterado',            c9.n === 0, c9.n],
      ['historico: campo alem de parcial_num mexido', c10.n === 0, c10.n],
    ]
    console.log('\n── VALIDACAO ─────────────────────────────────────────')
    let falhou = false
    for (const [nome, ok, v] of checks) { if (!ok) falhou = true
      console.log(`   ${ok ? 'OK   ' : 'FALHA'}  ${nome.padEnd(40)} ${v}`) }

    console.log('\n── AS DUAS TRs CONFERIDAS ────────────────────────────')
    for (const tr of ['2020TR000637', '2020TR000704']) {
      const { rows } = await cli.query(
        `SELECT DISTINCT parcial_num::int v FROM prestacoes_contas
          WHERE setorial_id='FCEE' AND tr=$1 AND tipo <> 'final' ORDER BY 1`, [tr])
      const v = rows.map(r => r.v)
      console.log(`   ${tr}: ${v[0]}..${v[v.length-1]} · ${v.length} parciais · contiguo=${v.every((x,i)=>x===i+1)}`)
    }

    if (falhou)      { await cli.query('ROLLBACK'); console.log('\n>> VALIDACAO FALHOU: ROLLBACK. Nada gravado.'); process.exitCode = 2 }
    else if (GRAVAR) {
      // A lista de reversao vai para arquivo ANTES do COMMIT — se o terminal fechar,
      // ela continua existindo. Sem ela nao ha reversao por chave explicita.
      require('fs').writeFileSync('reverter_renumeracao_20260813.json', JSON.stringify(
        { quando: new Date().toISOString(), tabela_backup: TAB_BK, tabela_backup_hist: TAB_HIST,
          codigos_pc: codigos, historico_ids: histIds }, null, 1))
      await cli.query('COMMIT')
      console.log('\n>> COMMIT.')
      console.log('   lista de reversao gravada em reverter_renumeracao_20260813.json')
      console.log(`\nPara reverter (lista explicita, regra 12):
  UPDATE prestacoes_contas p SET parcial_num = b.parcial_num
    FROM ${TAB_BK} b WHERE b.id = p.id AND p.codigo_pc = ANY($1);   -- $1 = codigos_pc do JSON
  UPDATE parcela_historico h SET parcial_num = b.parcial_num
    FROM ${TAB_HIST} b WHERE b.id = h.id AND h.id = ANY($2::int[]); -- $2 = historico_ids`) }
    else             { await cli.query('ROLLBACK'); console.log('\n>> DRY-RUN: ROLLBACK. Nada gravado. Rode com --gravar para aplicar.') }
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch {}
    console.error('ERRO — ROLLBACK: ' + e.message); process.exitCode = 1
  } finally { cli.release(); await pool.end() }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1) })
