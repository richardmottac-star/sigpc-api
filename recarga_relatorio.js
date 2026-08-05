// ETAPA 4 — relatorio final pos-COMMIT. Somente leitura.
const XLSX = require('xlsx')
const fs = require('fs')
const path = require('path')

const SAIDA = 'C:/Users/Richard/AppData/Local/Temp/claude/C--Users-Richard-sigpc-api/8d9d7ad3-70d9-4241-9d4f-0e681b336ab3/scratchpad'
const GRUPOS = [
  { g: 'G1', n: 1, arq: 'C:/Users/Richard/Downloads/GRUPO 1 - Nayara (9).xlsx',  gabarito: 1538 },
  { g: 'G2', n: 2, arq: 'C:/Users/Richard/Downloads/GRUPO 2 - Zadir (7).xlsx',   gabarito: 1899 },
  { g: 'G3', n: 3, arq: 'C:/Users/Richard/Downloads/GRUPO_3__GUSTAVO__2_.xlsx',  gabarito: 888  }
]

const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normCab   = (s) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function acharCol(cab, cands) {
  const norm = cab.map(c => normCab(c))
  for (const c of cands) { const i = norm.indexOf(normCab(c)); if (i >= 0) return i }
  for (const c of cands) { const a = normCab(c); const i = norm.findIndex(x => x && x.includes(a)); if (i >= 0) return i }
  throw new Error('coluna nao encontrada: ' + cands.join(' | '))
}

const gabarito = new Map()   // nome normalizado -> {nome, grupo, pcs}
for (const G of GRUPOS) {
  const wb = XLSX.readFile(G.arq, { cellDates: true })
  const l = XLSX.utils.sheet_to_json(wb.Sheets['Monitoramento'], { header: 1, defval: null, blankrows: false })
  const cab = (l[0] || []).map(c => (c == null ? '' : String(c)))
  const iS = acharCol(cab, ['SERVIDOR'])
  const iB = acharCol(cab, ['PCs Baixadas (4)=(3)+(2)', 'PCs Baixadas'])
  for (const r of l.slice(1)) {
    const nome = String(r[iS] == null ? '' : r[iS]).trim()
    if (!nome || /^total/i.test(nome)) continue
    const v = parseInt(String(r[iB] == null ? '' : r[iB]).replace(/[^0-9-]/g, ''), 10)
    gabarito.set(normCab(nome), { nome, grupo: G.n, pcs: Number.isFinite(v) ? v : 0 })
  }
}

;(async () => {
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

  // agrupa por analista_id (armadilha 1) e rotula com usuarios.nome, nao com analista_nome
  const { rows } = await pool.query(`
    SELECT p.analista_id, u.nome AS nome, MAX(p.grupo) AS grupo,
           COUNT(*) FILTER (WHERE p.baixada)::int AS baixadas
    FROM prestacoes_contas p JOIN usuarios u ON u.id = p.analista_id
    WHERE p.setorial_id='FCEE'
    GROUP BY 1,2 ORDER BY 3,2
  `)
  // o gabarito usa nome curto; usuarios pode ter o nome completo -> casa por prefixo
  const banco = new Map()
  for (const r of rows) {
    let k = normCab(r.nome)
    if (!gabarito.has(k)) {
      const alt = [...gabarito.keys()].filter(g => k.startsWith(g + ' '))
      if (alt.length === 1) k = alt[0]
    }
    const a = banco.get(k) || { nome: r.nome, grupo: r.grupo, baixadas: 0 }
    a.baixadas += r.baixadas
    if (r.grupo != null) a.grupo = r.grupo
    banco.set(k, a)
  }

  console.log('='.repeat(74))
  console.log('RELATORIO FINAL — RECARGA POR PARCIAL (pos-COMMIT)')
  console.log('='.repeat(74))

  const linhas = [['grupo', 'analista', 'gabarito_monitoramento', 'baixadas_no_sistema', 'diferenca']]
  const nomes = new Set([...gabarito.keys(), ...banco.keys()])
  const porGrupo = {}

  for (const G of GRUPOS) {
    console.log(`\n--- ${G.g} ---`)
    console.log('  ANALISTA               GABARITO   SISTEMA    DIF')
    let sg = 0, ss = 0
    const doGrupo = [...nomes].filter(k => (gabarito.get(k)?.grupo ?? banco.get(k)?.grupo) === G.n)
    for (const k of doGrupo.sort()) {
      const gv = gabarito.get(k)?.pcs ?? null
      const bv = banco.get(k)?.baixadas ?? 0
      const nm = gabarito.get(k)?.nome || banco.get(k)?.nome || k
      sg += gv || 0; ss += bv
      const dif = gv === null ? '' : gv - bv
      linhas.push([G.n, nm, gv === null ? '' : gv, bv, dif])
      const marca = gv !== null && Math.abs(gv - bv) > 0 ? '  <<' : ''
      console.log(`  ${nm.padEnd(22).slice(0, 22)} ${String(gv === null ? '—' : gv).padStart(8)}  ${String(bv).padStart(8)}  ${String(dif).padStart(5)}${marca}`)
    }
    console.log('  ' + '-'.repeat(52))
    console.log(`  ${'TOTAL'.padEnd(22)} ${String(sg).padStart(8)}  ${String(ss).padStart(8)}  ${String(sg - ss).padStart(5)}`)
    porGrupo[G.g] = { gab: G.gabarito, monit: sg, sistema: ss }
  }

  console.log('\n' + '='.repeat(74))
  console.log('RESUMO POR GRUPO')
  console.log('='.repeat(74))
  console.log('GRUPO   GABARITO   SISTEMA    DIF     %')
  let tg = 0, ts = 0
  for (const G of GRUPOS) {
    const v = porGrupo[G.g]
    tg += v.gab; ts += v.sistema
    const d = v.gab - v.sistema
    console.log(`${G.g}      ${String(v.gab).padStart(8)}   ${String(v.sistema).padStart(7)}  ${String(d).padStart(5)}   ${(d / v.gab * 100).toFixed(1)}%`)
  }
  console.log('-'.repeat(46))
  console.log(`TOTAL  ${String(tg).padStart(8)}   ${String(ts).padStart(7)}  ${String(tg - ts).padStart(5)}   ${((tg - ts) / tg * 100).toFixed(1)}%`)

  const cam = path.join(SAIDA, 'relatorio_final.csv')
  fs.writeFileSync(cam, '\uFEFF' + linhas.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'utf8')
  console.log(`\nCSV: ${cam}`)

  await pool.end()
})().catch(e => { console.error('\nERRO: ' + e.message); process.exit(1) })
