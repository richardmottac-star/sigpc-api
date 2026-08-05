// Gera o CSV das parciais nao casadas, por analista, com o motivo apurado no banco.
// Somente leitura. NAO COMMITAR.
const fs = require('fs')
const path = require('path')

const SAIDA = 'C:/Users/Richard/AppData/Local/Temp/claude/C--Users-Richard-sigpc-api/8d9d7ad3-70d9-4241-9d4f-0e681b336ab3/scratchpad'
const ENTRADA = path.join(SAIDA, 'nao_casados.csv')

const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normTR = (s) => semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, '')

// mesma normalizacao da recarga, ja com a correcao do ano de 2 digitos
function normSGPE(s) {
  const t = semAcento(s).toUpperCase().trim().replace(/\/\s*(\d{2})\s*$/, (m, yy) => '/20' + yy)
  return t.replace(/[^A-Z]/g, '') + t.replace(/[^0-9]/g, '').replace(/^0+/, '')
}

function lerCSV(f) {
  const l = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  return l.map(x => (x.match(/"(?:[^"]|"")*"/g) || []).map(c => c.slice(1, -1).replace(/""/g, '"')))
}
const escCSV = (linhas) => '\uFEFF' + linhas.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n')

;(async () => {
  const linhas = lerCSV(ENTRADA)
  const dados = linhas.slice(1).map(r => ({
    grupo: r[0], analista: r[1], tr: r[2], sgpeBruto: r[3], parcial: r[4],
    numPcs: parseInt(r[5], 10) || 0, situacao: r[6]
  }))

  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

  const { rows } = await pool.query(`
    SELECT tr,
           regexp_replace(upper(processo_pc),'[^A-Z]','','g')
           || regexp_replace(regexp_replace(processo_pc,'[^0-9]','','g'),'^0+','') AS sgpe_norm,
           COUNT(*)::int AS qtd
    FROM prestacoes_contas WHERE setorial_id='FCEE' GROUP BY 1,2
  `)
  const trPcs = new Map()      // TR -> total de PCs
  const porSGPE = new Map()    // sgpe -> Set(TR)
  for (const r of rows) {
    const tr = normTR(r.tr)
    trPcs.set(tr, (trPcs.get(tr) || 0) + r.qtd)
    if (!porSGPE.has(r.sgpe_norm)) porSGPE.set(r.sgpe_norm, new Set())
    porSGPE.get(r.sgpe_norm).add(tr)
  }

  for (const d of dados) {
    const tr = normTR(d.tr)
    const sg = d.sgpeBruto === '(sem sgpe)' ? null : normSGPE(d.sgpeBruto)
    d.pcsNoTr = trPcs.has(tr) ? trPcs.get(tr) : 0
    if (!sg) {
      d.motivo = 'SGPE ausente na Planilha1'
      d.detalhe = 'a parcial nao tem processo SGPE preenchido'
    } else if (!trPcs.has(tr)) {
      d.motivo = 'TR nao existe no banco'
      d.detalhe = ''
    } else if (porSGPE.has(sg)) {
      const outros = [...porSGPE.get(sg)]
      d.motivo = 'processo existe em outro TR'
      d.detalhe = 'no banco esta em: ' + outros.join(', ') + (outros.length > 1 ? ' (ambiguo, nao recuperado)' : '')
    } else {
      d.motivo = 'processo nao existe no banco'
      d.detalhe = `o TR existe e tem ${d.pcsNoTr} PCs, mas nenhuma com esse SGPE`
    }
  }

  // total por analista, para ordenar do maior para o menor
  const totalAnalista = new Map()
  for (const d of dados) {
    const k = d.grupo + '|' + d.analista
    totalAnalista.set(k, (totalAnalista.get(k) || 0) + d.numPcs)
  }

  dados.sort((a, b) => {
    const ka = a.grupo + '|' + a.analista, kb = b.grupo + '|' + b.analista
    if (a.grupo !== b.grupo) return a.grupo.localeCompare(b.grupo)
    const ta = totalAnalista.get(ka), tb = totalAnalista.get(kb)
    if (ta !== tb) return tb - ta
    if (a.analista !== b.analista) return a.analista.localeCompare(b.analista)
    if (a.tr !== b.tr) return a.tr.localeCompare(b.tr)
    const pa = parseInt(a.parcial, 10), pb = parseInt(b.parcial, 10)
    if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb
    return String(a.parcial).localeCompare(String(b.parcial))
  })

  // ── CSV detalhado ────────────────────────────────────────────────
  const det = [['grupo', 'analista', 'pcs_pendentes_do_analista', 'tr', 'processo_sgpe', 'parcial',
                'num_pcs', 'situacao', 'motivo', 'detalhe', 'pcs_do_tr_no_banco']]
  for (const d of dados) {
    det.push([d.grupo, d.analista, totalAnalista.get(d.grupo + '|' + d.analista), d.tr, d.sgpeBruto,
              d.parcial, d.numPcs, d.situacao, d.motivo, d.detalhe, d.pcsNoTr])
  }
  const camDet = path.join(SAIDA, 'nao_casados_por_analista.csv')
  fs.writeFileSync(camDet, escCSV(det), 'utf8')

  // ── CSV resumo ───────────────────────────────────────────────────
  const resumo = new Map()
  for (const d of dados) {
    const k = d.grupo + '|' + d.analista
    if (!resumo.has(k)) resumo.set(k, { grupo: d.grupo, analista: d.analista, parciais: 0, pcs: 0, trs: new Set(), motivos: new Map() })
    const r = resumo.get(k)
    r.parciais++; r.pcs += d.numPcs; r.trs.add(d.tr)
    r.motivos.set(d.motivo, (r.motivos.get(d.motivo) || 0) + 1)
  }
  const res = [['grupo', 'analista', 'parciais_pendentes', 'pcs_pendentes', 'trs_envolvidos', 'motivos']]
  const ord = [...resumo.values()].sort((a, b) => a.grupo.localeCompare(b.grupo) || b.pcs - a.pcs)
  for (const r of ord) {
    res.push([r.grupo, r.analista, r.parciais, r.pcs, [...r.trs].join(' '),
              [...r.motivos.entries()].map(([m, n]) => `${m} (${n})`).join(' | ')])
  }
  const camRes = path.join(SAIDA, 'nao_casados_resumo_analista.csv')
  fs.writeFileSync(camRes, escCSV(res), 'utf8')

  // ── console ──────────────────────────────────────────────────────
  console.log('='.repeat(78))
  console.log('PARCIAIS NAO CASADAS — POR ANALISTA')
  console.log('='.repeat(78))
  console.log(`total: ${dados.length} parciais | ${dados.reduce((s, d) => s + d.numPcs, 0)} PCs\n`)
  console.log('GRP  ANALISTA           PARCIAIS   PCs   MOTIVO PREDOMINANTE')
  for (const r of ord) {
    const top = [...r.motivos.entries()].sort((a, b) => b[1] - a[1])[0]
    console.log(`${r.grupo}   ${r.analista.padEnd(18).slice(0, 18)} ${String(r.parciais).padStart(8)} ${String(r.pcs).padStart(5)}   ${top[0]} (${top[1]})`)
  }

  console.log('\nmotivos no total:')
  const glob = new Map()
  for (const d of dados) glob.set(d.motivo, (glob.get(d.motivo) || 0) + d.numPcs)
  for (const [m, n] of [...glob.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)} PCs  ${m}`)

  console.log(`\nCSV detalhado : ${camDet}`)
  console.log(`CSV resumo    : ${camRes}`)

  await pool.end()
})().catch(e => { console.error('\nERRO: ' + e.message); process.exit(1) })
