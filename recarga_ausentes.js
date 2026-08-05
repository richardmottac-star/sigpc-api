// INVESTIGACAO dos processos da planilha que nao casaram com o banco. NAO GRAVA NADA.
// Classifica cada chave ausente em: TR divergente / processo inexistente / prefixo divergente / etc.
const XLSX = require('xlsx')
const fs = require('fs')
const path = require('path')

const SAIDA = 'C:/Users/Richard/AppData/Local/Temp/claude/C--Users-Richard-sigpc-api/8d9d7ad3-70d9-4241-9d4f-0e681b336ab3/scratchpad'

const GRUPOS = [
  { g: 'G1', arq: 'C:/Users/Richard/Downloads/GRUPO 1 - Nayara (9).xlsx' },
  { g: 'G2', arq: 'C:/Users/Richard/Downloads/GRUPO 2 - Zadir (7).xlsx'  },
  { g: 'G3', arq: 'C:/Users/Richard/Downloads/GRUPO_3__GUSTAVO__2_.xlsx' }
]

const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normCab   = (s) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const normTR    = (s) => semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, '')
const normParc  = (s) => String(s == null ? '' : s).trim()
const soDigitos = (s) => semAcento(s).replace(/[^0-9]/g, '').replace(/^0+/, '')

function normSGPE(s) {
  const t = semAcento(s).toUpperCase()
  return t.replace(/[^A-Z]/g, '') + t.replace(/[^0-9]/g, '').replace(/^0+/, '')
}

function acharCol(cab, cands, ctx = '') {
  const norm = cab.map(c => normCab(c))
  for (const c of cands) { const i = norm.indexOf(normCab(c)); if (i >= 0) return i }
  for (const c of cands) { const a = normCab(c); const i = norm.findIndex(x => x && x.includes(a)); if (i >= 0) return i }
  throw new Error(`coluna nao encontrada ${ctx}: ${cands.join(' | ')}`)
}

function lerAba(wb, nome) {
  const ws = wb.Sheets[nome]
  if (!ws) throw new Error(`aba "${nome}" nao existe`)
  const l = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false })
  return { cab: (l[0] || []).map(c => (c == null ? '' : String(c))), dados: l.slice(1) }
}

const NAO_BAIXA = ['analise', 'diligencia', 'reanalise', 'aguardando']
function ehBaixada(s0) {
  const s = normCab(s0)
  if (!s) return false
  if (NAO_BAIXA.some(n => s.includes(n))) return false
  return s.includes('parecer') || s.includes('controle interno')
}

function lerGrupo({ g, arq }) {
  const wb = XLSX.readFile(arq, { cellDates: true })
  const bk = lerAba(wb, 'backup')
  const cA = acharCol(bk.cab, ['Analista', 'Tecnico', 'Técnico'], `${g}/backup`)
  const cT = acharCol(bk.cab, ['SIGEF TR', 'TR'],                 `${g}/backup`)
  const cP = acharCol(bk.cab, ['Parcial'],                        `${g}/backup`)
  const cN = acharCol(bk.cab, ['Numero de PCs', 'Número de PCs'], `${g}/backup`)
  const cS = acharCol(bk.cab, ['Situacao', 'Situação'],           `${g}/backup`)

  const parciais = []
  for (const l of bk.dados) {
    const tr = normTR(l[cT]); if (!tr) continue
    const sit = l[cS] == null ? '' : String(l[cS]).trim()
    if (!ehBaixada(sit)) continue
    const n = parseInt(String(l[cN] == null ? '' : l[cN]).replace(/[^0-9-]/g, ''), 10)
    parciais.push({ analista: String(l[cA] == null ? '' : l[cA]).trim(), tr, parcial: normParc(l[cP]),
                    numPcs: Number.isFinite(n) ? n : 0, situacao: sit })
  }

  const p1 = lerAba(wb, 'Planilha1')
  const pT = acharCol(p1.cab, ['SIGEF TR', 'TR'],                  `${g}/Planilha1`)
  const pP = acharCol(p1.cab, ['Parcial', 'PARCIAL'],              `${g}/Planilha1`)
  const pS = acharCol(p1.cab, ['Processos SGPE', 'Processo SGPE'], `${g}/Planilha1`)
  const mapa = new Map(), bruto = new Map()
  for (const l of p1.dados) {
    const tr = normTR(l[pT]); if (!tr) continue
    const k = tr + '|' + normParc(l[pP])
    const b = l[pS] == null ? '' : String(l[pS]).trim()
    const s = normSGPE(b); if (!s) continue
    mapa.set(k, s); bruto.set(k, b)
  }
  for (const p of parciais) {
    const k = p.tr + '|' + p.parcial
    p.sgpe = mapa.get(k) || null
    p.sgpeBruto = bruto.get(k) || null
  }
  return { g, parciais }
}

;(async () => {
  const grupos = GRUPOS.map(lerGrupo)

  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 })

  // universo do banco, em 3 indices
  const { rows } = await pool.query(`
    SELECT tr, processo_pc, tipo, parcela_seq::text AS parcela,
           regexp_replace(upper(processo_pc),'[^A-Z]','','g')
           || regexp_replace(regexp_replace(processo_pc,'[^0-9]','','g'),'^0+','') AS sgpe_norm,
           regexp_replace(regexp_replace(processo_pc,'[^0-9]','','g'),'^0+','')     AS sgpe_dig
    FROM prestacoes_contas WHERE setorial_id='FCEE'
  `)
  const porTRSGPE = new Map()   // TR|SGPE -> qtd
  const porSGPE   = new Map()   // SGPE -> Set(TR)
  const porDig    = new Map()   // digitos -> Set(TR|prefixo)
  const trs       = new Set()
  for (const r of rows) {
    const tr = normTR(r.tr)
    trs.add(tr)
    const k = tr + '|' + r.sgpe_norm
    porTRSGPE.set(k, (porTRSGPE.get(k) || 0) + 1)
    if (!porSGPE.has(r.sgpe_norm)) porSGPE.set(r.sgpe_norm, new Set())
    porSGPE.get(r.sgpe_norm).add(tr)
    if (!porDig.has(r.sgpe_dig)) porDig.set(r.sgpe_dig, new Set())
    porDig.get(r.sgpe_dig).add(tr + ' / ' + r.processo_pc)
  }

  const saida = [['grupo', 'analista', 'tr', 'sgpe_bruto', 'sgpe_norm', 'parciais', 'num_pcs', 'classificacao', 'detalhe']]
  const classes = new Map()
  let totalPcs = 0

  for (const gr of grupos) {
    // agrega as parciais ausentes por chave
    const chaves = new Map()
    for (const p of gr.parciais) {
      const k = p.sgpe ? (p.tr + '|' + p.sgpe) : (p.tr + '|(SEM SGPE)')
      if (p.sgpe && porTRSGPE.has(k)) continue          // casou, nao interessa aqui
      if (!chaves.has(k)) chaves.set(k, { tr: p.tr, sgpe: p.sgpe, bruto: p.sgpeBruto, analistas: new Set(), soma: 0, linhas: 0, parciais: [] })
      const c = chaves.get(k)
      c.analistas.add(p.analista); c.soma += p.numPcs; c.linhas++; c.parciais.push(p.parcial)
    }

    for (const c of chaves.values()) {
      let classe, detalhe = ''
      if (!c.sgpe) {
        classe = 'A. sem SGPE na Planilha1'
        detalhe = `parciais: ${c.parciais.join(',')}`
      } else if (!trs.has(c.tr)) {
        classe = 'B. TR nao existe no banco'
      } else if (porSGPE.has(c.sgpe)) {
        classe = 'C. processo existe, mas em OUTRO TR'
        detalhe = 'no banco esta em: ' + [...porSGPE.get(c.sgpe)].join(', ')
      } else {
        const dig = soDigitos(c.bruto || '')
        if (dig && porDig.has(dig)) {
          classe = 'D. mesmos digitos, prefixo diferente'
          detalhe = 'no banco: ' + [...porDig.get(dig)].slice(0, 3).join(' ; ')
        } else {
          classe = 'E. processo nao existe no banco'
          detalhe = `TR tem ${[...porTRSGPE.keys()].filter(k => k.startsWith(c.tr + '|')).length} processos no banco`
        }
      }
      if (!classes.has(classe)) classes.set(classe, { chaves: 0, pcs: 0 })
      classes.get(classe).chaves++; classes.get(classe).pcs += c.soma
      totalPcs += c.soma
      saida.push([gr.g, [...c.analistas].join('/'), c.tr, c.bruto || '(sem sgpe)', c.sgpe || '', c.linhas, c.soma, classe, detalhe])
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log('=== ORIGEM DOS PROCESSOS AUSENTES')
  console.log('='.repeat(80))
  console.log(`chaves ausentes: ${saida.length - 1}  |  PCs envolvidas: ${totalPcs}\n`)
  for (const [c, v] of [...classes.entries()].sort()) {
    console.log(`  ${c.padEnd(42)} ${String(v.chaves).padStart(4)} chaves  ${String(v.pcs).padStart(4)} PCs`)
  }

  console.log('\n--- amostra por classe ---')
  for (const [c] of [...classes.entries()].sort()) {
    console.log(`\n[${c}]`)
    saida.slice(1).filter(r => r[7] === c).slice(0, 6)
      .forEach(r => console.log(`   ${r[0]} | ${r[2]} | ${r[3]} | ${r[6]} PCs | ${r[8]}`))
  }

  const cam = path.join(SAIDA, 'ausentes_classificados.csv')
  fs.writeFileSync(cam, '\uFEFF' + saida.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'utf8')
  console.log(`\nCSV: ${cam}`)

  await pool.end()
})().catch(e => { console.error('\nERRO: ' + e.message); process.exit(1) })
