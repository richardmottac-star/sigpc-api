// DIAGNOSTICO 2 — agrega por CHAVE TR+SGPE (nao linha a linha). NAO GRAVA NADA.
// Reaproveita as mesmas regras de leitura do recarga_diag.js.
const XLSX = require('xlsx')
const fs = require('fs')
const path = require('path')

const SAIDA = 'C:/Users/Richard/AppData/Local/Temp/claude/C--Users-Richard-sigpc-api/8d9d7ad3-70d9-4241-9d4f-0e681b336ab3/scratchpad'

const GRUPOS = [
  { g: 'G1', arq: 'C:/Users/Richard/Downloads/GRUPO 1 - Nayara (9).xlsx',  gabarito: 1538 },
  { g: 'G2', arq: 'C:/Users/Richard/Downloads/GRUPO 2 - Zadir (7).xlsx',   gabarito: 1899 },
  { g: 'G3', arq: 'C:/Users/Richard/Downloads/GRUPO_3__GUSTAVO__2_.xlsx',  gabarito: 888  }
]

const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normCab   = (s) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const normTR    = (s) => semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, '')
const normParc  = (s) => String(s == null ? '' : s).trim()

function normSGPE(s) {
  const t = semAcento(s).toUpperCase()
  return t.replace(/[^A-Z]/g, '') + t.replace(/[^0-9]/g, '').replace(/^0+/, '')
}

function acharCol(cabecalho, candidatos, { exigir = true, ctx = '' } = {}) {
  const norm = cabecalho.map(c => normCab(c))
  for (const cand of candidatos) {
    const i = norm.indexOf(normCab(cand))
    if (i >= 0) return i
  }
  for (const cand of candidatos) {
    const alvo = normCab(cand)
    const i = norm.findIndex(c => c && c.includes(alvo))
    if (i >= 0) return i
  }
  if (exigir) throw new Error(`coluna nao encontrada ${ctx}: ${candidatos.join(' | ')}`)
  return -1
}

function lerAba(wb, nomeAba, linhaCab = 0) {
  const ws = wb.Sheets[nomeAba]
  if (!ws) throw new Error(`aba "${nomeAba}" nao existe`)
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false })
  return { cab: (linhas[linhaCab] || []).map(c => (c == null ? '' : String(c))), dados: linhas.slice(linhaCab + 1) }
}

const NAO_BAIXA = ['analise', 'diligencia', 'reanalise', 'aguardando']
function ehBaixada(situacao) {
  const s = normCab(situacao)
  if (!s) return false
  if (NAO_BAIXA.some(n => s.includes(n))) return false
  return s.includes('parecer') || s.includes('controle interno')
}

function lerGrupo({ g, arq, gabarito }) {
  const wb = XLSX.readFile(arq, { cellDates: true })

  const bk = lerAba(wb, 'backup')
  const cAnalista = acharCol(bk.cab, ['Analista', 'Tecnico', 'Técnico', 'Servidor'], { ctx: `${g}/backup` })
  const cTR       = acharCol(bk.cab, ['SIGEF TR', 'TR'],                            { ctx: `${g}/backup` })
  const cParcial  = acharCol(bk.cab, ['Parcial'],                                   { ctx: `${g}/backup` })
  const cNumPcs   = acharCol(bk.cab, ['Numero de PCs', 'Número de PCs'],            { ctx: `${g}/backup` })
  const cSit      = acharCol(bk.cab, ['Situacao', 'Situação'],                      { ctx: `${g}/backup` })

  const parciais = []
  for (const l of bk.dados) {
    const tr = normTR(l[cTR])
    if (!tr) continue
    const situacao = l[cSit] == null ? '' : String(l[cSit]).trim()
    if (!ehBaixada(situacao)) continue
    const n = parseInt(String(l[cNumPcs] == null ? '' : l[cNumPcs]).replace(/[^0-9-]/g, ''), 10)
    parciais.push({
      analista: String(l[cAnalista] == null ? '' : l[cAnalista]).trim(),
      tr, parcial: normParc(l[cParcial]),
      numPcs: Number.isFinite(n) ? n : 0, situacao
    })
  }

  const p1 = lerAba(wb, 'Planilha1')
  const pTR      = acharCol(p1.cab, ['SIGEF TR', 'TR'],                  { ctx: `${g}/Planilha1` })
  const pParcial = acharCol(p1.cab, ['Parcial', 'PARCIAL'],              { ctx: `${g}/Planilha1` })
  const pSGPE    = acharCol(p1.cab, ['Processos SGPE', 'Processo SGPE'], { ctx: `${g}/Planilha1` })

  const mapaSGPE = new Map(), sgpeBruto = new Map()
  for (const l of p1.dados) {
    const tr = normTR(l[pTR])
    if (!tr) continue
    const k = tr + '|' + normParc(l[pParcial])
    const bruto = l[pSGPE] == null ? '' : String(l[pSGPE]).trim()
    const sg = normSGPE(bruto)
    if (!sg) continue
    mapaSGPE.set(k, sg); sgpeBruto.set(k, bruto)
  }
  for (const p of parciais) {
    const k = p.tr + '|' + p.parcial
    p.sgpe = mapaSGPE.get(k) || null
    p.sgpeBruto = sgpeBruto.get(k) || null
  }

  const mo = lerAba(wb, 'Monitoramento')
  const mServidor = acharCol(mo.cab, ['SERVIDOR'],                                 { ctx: `${g}/Monitoramento` })
  const mBaixadas = acharCol(mo.cab, ['PCs Baixadas (4)=(3)+(2)', 'PCs Baixadas'], { ctx: `${g}/Monitoramento` })
  const gab = new Map()
  for (const l of mo.dados) {
    const nome = String(l[mServidor] == null ? '' : l[mServidor]).trim()
    if (!nome || /^total/i.test(nome)) continue
    const v = parseInt(String(l[mBaixadas] == null ? '' : l[mBaixadas]).replace(/[^0-9-]/g, ''), 10)
    gab.set(nome, Number.isFinite(v) ? v : 0)
  }

  return { g, arq, gabarito, parciais, gab }
}

;(async () => {
  const grupos = GRUPOS.map(lerGrupo)

  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 })

  const { rows } = await pool.query(`
    SELECT tr,
           regexp_replace(upper(processo_pc),'[^A-Z]','','g')
           || regexp_replace(regexp_replace(processo_pc,'[^0-9]','','g'),'^0+','') AS sgpe_norm,
           COUNT(*)::int AS qtd
    FROM prestacoes_contas
    WHERE setorial_id='FCEE'
    GROUP BY 1,2
  `)
  const noBanco = new Map()
  for (const r of rows) noBanco.set(normTR(r.tr) + '|' + r.sgpe_norm, r.qtd)

  // quantas PCs o banco tem por TR (para medir se o problema e' o SGPE ou o TR)
  const { rows: trRows } = await pool.query(`
    SELECT tr, COUNT(*)::int AS qtd FROM prestacoes_contas WHERE setorial_id='FCEE' GROUP BY 1
  `)
  const trBanco = new Map()
  for (const r of trRows) trBanco.set(normTR(r.tr), r.qtd)

  console.log('\n' + '#'.repeat(80))
  console.log('# AGREGADO POR CHAVE TR+SGPE  (soma dos num_pcs das parciais que apontam a mesma chave)')
  console.log('#'.repeat(80))

  const detalhe = [['grupo', 'analista', 'tr', 'sgpe_bruto', 'sgpe_norm', 'soma_num_pcs_planilha', 'linhas_planilha', 'pcs_no_banco', 'dif', 'tr_existe', 'pcs_no_tr']]
  let T = { chaves: 0, ok: 0, bancoMenos: 0, bancoMais: 0, semChave: 0, semTR: 0,
            somaPlan: 0, somaBanco: 0, perdaSemChave: 0, perdaMenos: 0, ganhoMais: 0 }

  for (const gr of grupos) {
    // agrega por chave
    const chaves = new Map()
    for (const p of gr.parciais) {
      const k = p.sgpe ? (p.tr + '|' + p.sgpe) : (p.tr + '|(SEM SGPE)')
      if (!chaves.has(k)) chaves.set(k, { tr: p.tr, sgpe: p.sgpe, sgpeBruto: p.sgpeBruto, analistas: new Set(), soma: 0, linhas: 0 })
      const c = chaves.get(k)
      c.analistas.add(p.analista); c.soma += p.numPcs; c.linhas++
    }

    let ok = 0, menos = 0, mais = 0, sem = 0, semTR = 0
    let sPlan = 0, sBanco = 0, pSem = 0, pMenos = 0, gMais = 0
    for (const [k, c] of chaves) {
      const qtd = c.sgpe ? noBanco.get(k) : undefined
      const trQtd = trBanco.get(c.tr)
      sPlan += c.soma
      detalhe.push([gr.g, [...c.analistas].join('/'), c.tr, c.sgpeBruto || '(sem sgpe)', c.sgpe || '', c.soma, c.linhas,
                    qtd === undefined ? '' : qtd, qtd === undefined ? '' : (c.soma - qtd),
                    trQtd === undefined ? 'NAO' : 'sim', trQtd === undefined ? '' : trQtd])
      if (qtd === undefined) {
        sem++; pSem += c.soma
        if (trQtd === undefined) semTR++
        continue
      }
      sBanco += qtd
      if (qtd === c.soma) ok++
      else if (qtd < c.soma) { menos++; pMenos += (c.soma - qtd) }
      else { mais++; gMais += (qtd - c.soma) }
    }

    console.log(`\n=== ${gr.g} ===`)
    console.log(`chaves TR+SGPE distintas na planilha : ${chaves.size}`)
    console.log(`  casam exatamente (banco == planilha): ${ok}`)
    console.log(`  banco tem MENOS PCs que a planilha  : ${menos}   (faltam ${pMenos} PCs)`)
    console.log(`  banco tem MAIS PCs que a planilha   : ${mais}   (sobram ${gMais} PCs)`)
    console.log(`  chave NAO existe no banco           : ${sem}   (perde ${pSem} PCs)  [dessas, ${semTR} o TR inteiro nao existe]`)
    console.log(`  soma planilha ${sPlan} | soma banco (chaves casadas) ${sBanco}`)

    T.chaves += chaves.size; T.ok += ok; T.bancoMenos += menos; T.bancoMais += mais
    T.semChave += sem; T.semTR += semTR
    T.somaPlan += sPlan; T.somaBanco += sBanco
    T.perdaSemChave += pSem; T.perdaMenos += pMenos; T.ganhoMais += gMais
  }

  console.log('\n' + '='.repeat(80))
  console.log('=== TOTAL')
  console.log('='.repeat(80))
  console.log(`chaves TR+SGPE distintas          : ${T.chaves}`)
  console.log(`  casam exatamente                : ${T.ok}  (${(T.ok / T.chaves * 100).toFixed(1)}%)`)
  console.log(`  banco MENOS                     : ${T.bancoMenos}  (faltam ${T.perdaMenos} PCs)`)
  console.log(`  banco MAIS                      : ${T.bancoMais}  (sobram ${T.ganhoMais} PCs)`)
  console.log(`  chave ausente no banco          : ${T.semChave}  (perde ${T.perdaSemChave} PCs) [${T.semTR} com TR inexistente]`)
  console.log(`\nsoma num_pcs planilha             : ${T.somaPlan}`)
  console.log(`PCs que seriam baixadas (marcando o processo inteiro): ${T.somaBanco}`)
  console.log(`diferenca                         : ${T.somaPlan - T.somaBanco}  (${((T.somaPlan - T.somaBanco) / T.somaPlan * 100).toFixed(1)}%)`)

  const cam = path.join(SAIDA, 'chaves_tr_sgpe.csv')
  fs.writeFileSync(cam, '\uFEFF' + detalhe.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'utf8')
  console.log(`\nCSV detalhado por chave: ${cam}  (${detalhe.length - 1} chaves)`)

  await pool.end()
})().catch(e => { console.error('\nERRO: ' + e.message); process.exit(1) })
