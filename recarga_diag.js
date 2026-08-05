// DIAGNOSTICO da recarga por parcial — NAO GRAVA NADA.
// Parte 1 (planilhas): sempre roda.
// Parte 2 (banco): so roda se process.env.DATABASE_URL estiver definida.
// NAO COMMITAR — operacao de dados.
const XLSX = require('xlsx')
const fs = require('fs')
const path = require('path')

const SAIDA = 'C:/Users/Richard/AppData/Local/Temp/claude/C--Users-Richard-sigpc-api/8d9d7ad3-70d9-4241-9d4f-0e681b336ab3/scratchpad'

const GRUPOS = [
  { g: 'G1', arq: 'C:/Users/Richard/Downloads/GRUPO 1 - Nayara (9).xlsx',  gabarito: 1538 },
  { g: 'G2', arq: 'C:/Users/Richard/Downloads/GRUPO 2 - Zadir (7).xlsx',   gabarito: 1899 },
  { g: 'G3', arq: 'C:/Users/Richard/Downloads/GRUPO_3__GUSTAVO__2_.xlsx',  gabarito: 888  }
]

// ── normalizacoes ───────────────────────────────────────────────────
const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normCab   = (s) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const normTR    = (s) => semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, '')
const normParc  = (s) => String(s == null ? '' : s).trim()

// SGPE: prefixo alfabetico + digitos sem zeros a esquerda (regra 5)
function normSGPE(s) {
  const t = semAcento(s).toUpperCase()
  const letras = t.replace(/[^A-Z]/g, '')
  const digitos = t.replace(/[^0-9]/g, '').replace(/^0+/, '')
  return letras + digitos
}

// Acha o indice da coluna pelo NOME (regra 1). Nunca por posicao.
function acharCol(cabecalho, candidatos, { exigir = true, ctx = '' } = {}) {
  const norm = cabecalho.map(c => normCab(c))
  for (const cand of candidatos) {
    const alvo = normCab(cand)
    const i = norm.indexOf(alvo)
    if (i >= 0) return i
  }
  for (const cand of candidatos) {          // fallback: contem
    const alvo = normCab(cand)
    const i = norm.findIndex(c => c && c.includes(alvo))
    if (i >= 0) return i
  }
  if (exigir) throw new Error(`coluna nao encontrada ${ctx}: ${candidatos.join(' | ')}\n  cabecalho: ${cabecalho.join(' ; ')}`)
  return -1
}

function lerAba(wb, nomeAba, linhaCab = 0) {
  const ws = wb.Sheets[nomeAba]
  if (!ws) throw new Error(`aba "${nomeAba}" nao existe`)
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false })
  return { cab: (linhas[linhaCab] || []).map(c => (c == null ? '' : String(c))), dados: linhas.slice(linhaCab + 1) }
}

// ── regra 4: baixada = "Parecer" OU "Controle Interno" ──────────────
// Nao baixam: analise, diligencia, reanalise, aguardando.
const NAO_BAIXA = ['analise', 'diligencia', 'reanalise', 'aguardando']
function ehBaixada(situacao) {
  const s = normCab(situacao)
  if (!s) return false
  if (NAO_BAIXA.some(n => s.includes(n))) return false
  return s.includes('parecer') || s.includes('controle interno')
}

// ── leitura de um grupo ─────────────────────────────────────────────
function lerGrupo({ g, arq, gabarito }) {
  const wb = XLSX.readFile(arq, { cellDates: true })

  // -- aba backup: fonte do "quanto baixar" (regra 2)
  const bk = lerAba(wb, 'backup')
  const cAnalista = acharCol(bk.cab, ['Analista', 'Tecnico', 'Técnico', 'Servidor'], { ctx: `${g}/backup` })
  const cTR       = acharCol(bk.cab, ['SIGEF TR', 'TR'],                            { ctx: `${g}/backup` })
  const cParcial  = acharCol(bk.cab, ['Parcial'],                                   { ctx: `${g}/backup` })
  const cNumPcs   = acharCol(bk.cab, ['Numero de PCs', 'Número de PCs'],            { ctx: `${g}/backup` })
  const cSit      = acharCol(bk.cab, ['Situacao', 'Situação'],                      { ctx: `${g}/backup` })

  const parciais = []
  const situacoes = new Map()
  for (const l of bk.dados) {
    const tr = normTR(l[cTR])
    if (!tr) continue
    const situacao = l[cSit] == null ? '' : String(l[cSit]).trim()
    const baixada = ehBaixada(situacao)
    const chaveSit = situacao || '(vazio)'
    if (!situacoes.has(chaveSit)) situacoes.set(chaveSit, { total: 0, baixa: baixada })
    situacoes.get(chaveSit).total++
    if (!baixada) continue
    const numPcs = parseInt(String(l[cNumPcs] == null ? '' : l[cNumPcs]).replace(/[^0-9-]/g, ''), 10)
    parciais.push({
      analista: String(l[cAnalista] == null ? '' : l[cAnalista]).trim(),
      tr,
      parcial: normParc(l[cParcial]),
      numPcs: Number.isFinite(numPcs) ? numPcs : 0,
      situacao
    })
  }

  // -- aba Planilha1: SOMENTE para obter o SGPE de cada parcial (regra 2)
  const p1 = lerAba(wb, 'Planilha1')
  const pTR      = acharCol(p1.cab, ['SIGEF TR', 'TR'],                   { ctx: `${g}/Planilha1` })
  const pParcial = acharCol(p1.cab, ['Parcial', 'PARCIAL'],               { ctx: `${g}/Planilha1` })
  const pSGPE    = acharCol(p1.cab, ['Processos SGPE', 'Processo SGPE'],  { ctx: `${g}/Planilha1` })

  const mapaSGPE = new Map()   // tr|parcial -> sgpe normalizado
  const sgpeBruto = new Map()  // tr|parcial -> texto original
  const conflitos = []
  for (const l of p1.dados) {
    const tr = normTR(l[pTR])
    if (!tr) continue
    const k = tr + '|' + normParc(l[pParcial])
    const bruto = l[pSGPE] == null ? '' : String(l[pSGPE]).trim()
    const sg = normSGPE(bruto)
    if (!sg) continue
    if (mapaSGPE.has(k) && mapaSGPE.get(k) !== sg) conflitos.push({ k, a: mapaSGPE.get(k), b: sg })
    mapaSGPE.set(k, sg)
    sgpeBruto.set(k, bruto)
  }

  // -- junta: cada parcial baixada recebe o seu SGPE
  const semSGPE = []
  for (const p of parciais) {
    const k = p.tr + '|' + p.parcial
    p.sgpe = mapaSGPE.get(k) || null
    p.sgpeBruto = sgpeBruto.get(k) || null
    if (!p.sgpe) semSGPE.push(p)
  }

  // -- aba Monitoramento: gabarito por analista (regra 3)
  const mo = lerAba(wb, 'Monitoramento')
  const mServidor = acharCol(mo.cab, ['SERVIDOR'],                                   { ctx: `${g}/Monitoramento` })
  const mBaixadas = acharCol(mo.cab, ['PCs Baixadas (4)=(3)+(2)', 'PCs Baixadas'],   { ctx: `${g}/Monitoramento` })
  const gab = new Map()
  for (const l of mo.dados) {
    const nome = String(l[mServidor] == null ? '' : l[mServidor]).trim()
    if (!nome || /^total/i.test(nome)) continue
    const v = parseInt(String(l[mBaixadas] == null ? '' : l[mBaixadas]).replace(/[^0-9-]/g, ''), 10)
    gab.set(nome, Number.isFinite(v) ? v : 0)
  }

  return { g, arq, gabarito, parciais, semSGPE, conflitos, situacoes, gab }
}

// ── agregacoes por analista ─────────────────────────────────────────
function agregar(parciais) {
  const porAnalista = new Map()
  for (const p of parciais) {
    if (!porAnalista.has(p.analista)) {
      porAnalista.set(p.analista, { somaNumPcs: 0, linhas: 0, sgpes: new Map() })
    }
    const a = porAnalista.get(p.analista)
    a.somaNumPcs += p.numPcs
    a.linhas++
    if (p.sgpe) {
      // guarda o MAIOR numPcs visto para o mesmo SGPE (nao soma repetido)
      a.sgpes.set(p.sgpe, Math.max(a.sgpes.get(p.sgpe) || 0, p.numPcs))
    }
  }
  for (const a of porAnalista.values()) {
    a.sgpeDistintos = a.sgpes.size
    a.somaPorSgpe = [...a.sgpes.values()].reduce((s, v) => s + v, 0)
  }
  return porAnalista
}

// ── execucao ────────────────────────────────────────────────────────
;(async () => {
  const grupos = GRUPOS.map(lerGrupo)

  console.log('\n' + '#'.repeat(78))
  console.log('# PARTE 1 — PLANILHAS (sem banco)')
  console.log('#'.repeat(78))

  // -- situacoes distintas e como foram classificadas (valida a regra 4)
  console.log('\n=== SITUACOES DISTINTAS NA ABA backup (classificacao da regra 4) ===')
  const sitGlobal = new Map()
  for (const gr of grupos) {
    for (const [s, info] of gr.situacoes) {
      if (!sitGlobal.has(s)) sitGlobal.set(s, { total: 0, baixa: info.baixa })
      sitGlobal.get(s).total += info.total
    }
  }
  const sitOrd = [...sitGlobal.entries()].sort((a, b) => b[1].total - a[1].total)
  console.log('  BAIXA?  QTD    SITUACAO')
  for (const [s, info] of sitOrd) {
    console.log(`  ${info.baixa ? ' SIM ' : ' nao '}  ${String(info.total).padStart(5)}  ${s}`)
  }
  const totBaixaSit = sitOrd.filter(x => x[1].baixa).reduce((s, x) => s + x[1].total, 0)
  const totNaoSit   = sitOrd.filter(x => !x[1].baixa).reduce((s, x) => s + x[1].total, 0)
  console.log(`  -> ${totBaixaSit} linhas de parcial baixadas, ${totNaoSit} nao baixadas`)

  // -- por grupo
  const linhasCSV = [['grupo', 'analista', 'tr', 'parcial', 'num_pcs', 'situacao']]
  let totalGeral = { somaNumPcs: 0, somaPorSgpe: 0, gab: 0, parciais: 0, semSGPE: 0 }

  for (const gr of grupos) {
    const agg = agregar(gr.parciais)
    console.log('\n' + '='.repeat(78))
    console.log(`=== ${gr.g}  —  ${path.basename(gr.arq)}`)
    console.log('='.repeat(78))
    console.log(`parciais baixadas na backup : ${gr.parciais.length}`)
    console.log(`sem SGPE na Planilha1       : ${gr.semSGPE.length}`)
    if (gr.conflitos.length) console.log(`(tr,parcial) com SGPE conflitante: ${gr.conflitos.length}`)

    console.log('\n  ANALISTA               GABARITO   SOMA num_pcs   SGPE distintos   SOMA/SGPE   dif(gab-soma/sgpe)')
    const nomes = new Set([...gr.gab.keys(), ...agg.keys()])
    let sg = 0, ss = 0, sp = 0
    for (const nome of [...nomes].sort((a, b) => a.localeCompare(b))) {
      const a = agg.get(nome) || { somaNumPcs: 0, sgpeDistintos: 0, somaPorSgpe: 0 }
      const gv = gr.gab.has(nome) ? gr.gab.get(nome) : null
      sg += gv || 0; ss += a.somaNumPcs; sp += a.somaPorSgpe
      const dif = gv === null ? '' : (gv - a.somaPorSgpe)
      console.log(
        `  ${nome.padEnd(22).slice(0, 22)} ${String(gv === null ? '—' : gv).padStart(8)}   ${String(a.somaNumPcs).padStart(12)}   ` +
        `${String(a.sgpeDistintos).padStart(14)}   ${String(a.somaPorSgpe).padStart(9)}   ${String(dif).padStart(8)}`
      )
    }
    console.log('  ' + '-'.repeat(96))
    console.log(`  ${'TOTAL'.padEnd(22)} ${String(sg).padStart(8)}   ${String(ss).padStart(12)}   ${String('').padStart(14)}   ${String(sp).padStart(9)}   ${String(sg - sp).padStart(8)}`)
    console.log(`  gabarito informado no prompt: ${gr.gabarito}   |  Monitoramento somada: ${sg}   |  soma num_pcs: ${ss}`)

    totalGeral.somaNumPcs += ss
    totalGeral.somaPorSgpe += sp
    totalGeral.gab += sg
    totalGeral.parciais += gr.parciais.length
    totalGeral.semSGPE += gr.semSGPE.length

    for (const p of gr.semSGPE) linhasCSV.push([gr.g, p.analista, p.tr, p.parcial, p.numPcs, p.situacao])
  }

  console.log('\n' + '='.repeat(78))
  console.log('=== RESUMO GERAL (planilhas)')
  console.log('='.repeat(78))
  console.log(`parciais baixadas          : ${totalGeral.parciais}`)
  console.log(`sem SGPE (nao dá pra casar): ${totalGeral.semSGPE}`)
  console.log(`gabarito Monitoramento     : ${totalGeral.gab}`)
  console.log(`soma "Numero de PCs"       : ${totalGeral.somaNumPcs}`)
  console.log(`soma deduplicada por SGPE  : ${totalGeral.somaPorSgpe}`)
  const infl = totalGeral.somaPorSgpe > 0 ? ((totalGeral.somaNumPcs / totalGeral.somaPorSgpe - 1) * 100).toFixed(1) : '—'
  console.log(`inflacao da soma bruta     : ${infl}%`)

  const csv = linhasCSV.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
  const cam = path.join(SAIDA, 'sem_sgpe.csv')
  fs.writeFileSync(cam, '\uFEFF' + csv, 'utf8')
  console.log(`\nCSV das parciais sem SGPE: ${cam}`)

  // ── PARTE 2 — banco ───────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    console.log('\n' + '#'.repeat(78))
    console.log('# PARTE 2 — BANCO: PULADA (DATABASE_URL nao definida)')
    console.log('#'.repeat(78))
    return
  }

  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 })
  try {
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

    console.log('\n' + '#'.repeat(78))
    console.log('# PARTE 2 — BANCO')
    console.log('#'.repeat(78))
    console.log(`chaves TR+SGPE distintas no banco (FCEE): ${noBanco.size}`)

    const naoCasados = [['grupo', 'analista', 'tr', 'sgpe', 'num_pcs', 'situacao']]
    let casou = 0, naoCasou = 0, pcsCasadas = 0
    const divergencias = [['grupo', 'analista', 'tr', 'sgpe', 'num_pcs_planilha', 'linhas_no_banco']]

    for (const gr of grupos) {
      let c = 0, n = 0
      const vistos = new Set()
      for (const p of gr.parciais) {
        if (!p.sgpe) { n++; naoCasados.push([gr.g, p.analista, p.tr, '(sem sgpe)', p.numPcs, p.situacao]); continue }
        const k = p.tr + '|' + p.sgpe
        const qtd = noBanco.get(k)
        if (qtd === undefined) {
          n++
          naoCasados.push([gr.g, p.analista, p.tr, p.sgpeBruto || p.sgpe, p.numPcs, p.situacao])
        } else {
          c++
          if (!vistos.has(k)) { vistos.add(k); pcsCasadas += qtd }
          if (qtd !== p.numPcs) divergencias.push([gr.g, p.analista, p.tr, p.sgpe, p.numPcs, qtd])
        }
      }
      casou += c; naoCasou += n
      const pct = gr.parciais.length ? (n / gr.parciais.length * 100).toFixed(1) : '0'
      console.log(`${gr.g}: parciais ${gr.parciais.length} | casaram ${c} | NAO casaram ${n} (${pct}%)`)
    }
    console.log(`\nTOTAL: casaram ${casou} | nao casaram ${naoCasou}`)
    console.log(`PCs que seriam marcadas como baixadas (linhas distintas TR+SGPE): ${pcsCasadas}`)
    console.log(`gabarito Monitoramento: ${totalGeral.gab}  ->  diferenca ${totalGeral.gab - pcsCasadas}`)

    const cam2 = path.join(SAIDA, 'nao_casados.csv')
    fs.writeFileSync(cam2, '\uFEFF' + naoCasados.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'utf8')
    console.log(`\nCSV nao casados: ${cam2}  (${naoCasados.length - 1} linhas)`)
    const cam3 = path.join(SAIDA, 'divergencia_numpcs.csv')
    fs.writeFileSync(cam3, '\uFEFF' + divergencias.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'utf8')
    console.log(`CSV divergencia num_pcs: ${cam3}  (${divergencias.length - 1} linhas)`)
  } finally {
    await pool.end()
  }
})().catch(e => { console.error('\nERRO: ' + e.message); process.exit(1) })
