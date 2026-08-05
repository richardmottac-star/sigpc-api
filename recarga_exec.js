// ETAPA 3 — RECARGA POR PARCIAL. GRAVA NO BANCO, TRANSACIONAL.
// Rode com --dry para simular tudo dentro da transacao e dar ROLLBACK no fim.
// NAO COMMITAR — operacao de dados.
const XLSX = require('xlsx')
const fs = require('fs')
const path = require('path')

const DRY   = process.argv.includes('--dry')
const SAIDA = 'C:/Users/Richard/AppData/Local/Temp/claude/C--Users-Richard-sigpc-api/8d9d7ad3-70d9-4241-9d4f-0e681b336ab3/scratchpad'
const TAB_BACKUP = '_backup_baixada_20260805'

// G2: gabarito da planilha esta inflado (~2x em 45% das chaves) — validado contra o banco.
const GRUPOS = [
  { g: 'G1', arq: 'C:/Users/Richard/Downloads/GRUPO 1 - Nayara (9).xlsx',  gabarito: 1538, validaContra: 'gabarito' },
  { g: 'G2', arq: 'C:/Users/Richard/Downloads/GRUPO 2 - Zadir (7).xlsx',   gabarito: 1899, validaContra: 'banco'    },
  { g: 'G3', arq: 'C:/Users/Richard/Downloads/GRUPO_3__GUSTAVO__2_.xlsx',  gabarito: 888,  validaContra: 'gabarito' }
]
const TOLERANCIA = 0.05

// ── normalizacoes (regra 1 e 5) ─────────────────────────────────────
const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const normCab   = (s) => semAcento(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const normTR    = (s) => semAcento(s).toUpperCase().replace(/[^A-Z0-9]/g, '')
const normParc  = (s) => String(s == null ? '' : s).trim()
const normNome  = (s) => normCab(s)

function normSGPE(s) {
  // A planilha as vezes traz o ano com 2 digitos ("SCC 2859/21"); o banco usa
  // sempre 4 ("SCC 00002859/2021"). Sem expandir, os digitos nunca batem.
  const t = semAcento(s).toUpperCase().trim().replace(/\/\s*(\d{2})\s*$/, (m, yy) => '/20' + yy)
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

// ── regra 4 ─────────────────────────────────────────────────────────
const NAO_BAIXA = ['analise', 'diligencia', 'reanalise', 'aguardando']
function ehBaixada(s0) {
  const s = normCab(s0)
  if (!s) return false
  if (NAO_BAIXA.some(n => s.includes(n))) return false
  return s.includes('parecer') || s.includes('controle interno')
}

function lerGrupo({ g, arq, gabarito, validaContra }) {
  const wb = XLSX.readFile(arq, { cellDates: true })

  // regra 2: o "quanto baixar" vem da aba backup
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
    parciais.push({
      grupo: g,
      analista: String(l[cA] == null ? '' : l[cA]).trim(),
      tr, parcial: normParc(l[cP]),
      numPcs: Number.isFinite(n) ? n : 0,
      situacao: sit
    })
  }

  // regra 2: Planilha1 SO para obter o SGPE de cada parcial
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

  // regra 3: gabarito por analista
  const mo = lerAba(wb, 'Monitoramento')
  const mS = acharCol(mo.cab, ['SERVIDOR'],                                 `${g}/Monitoramento`)
  const mB = acharCol(mo.cab, ['PCs Baixadas (4)=(3)+(2)', 'PCs Baixadas'], `${g}/Monitoramento`)
  const gab = new Map()
  for (const l of mo.dados) {
    const nome = String(l[mS] == null ? '' : l[mS]).trim()
    if (!nome || /^total/i.test(nome)) continue
    const v = parseInt(String(l[mB] == null ? '' : l[mB]).replace(/[^0-9-]/g, ''), 10)
    gab.set(nome, Number.isFinite(v) ? v : 0)
  }

  return { g, arq, gabarito, validaContra, parciais, gab }
}

const csv = (linhas) => '\uFEFF' + linhas.map(l => l.map(c => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n')

// ── execucao ────────────────────────────────────────────────────────
;(async () => {
  const grupos = GRUPOS.map(lerGrupo)
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 })
  const cli = await pool.connect()

  const SGPE_SQL = `regexp_replace(upper(processo_pc),'[^A-Z]','','g')
                    || regexp_replace(regexp_replace(processo_pc,'[^0-9]','','g'),'^0+','')`

  let commitou = false
  try {
    // Mapa nome curto -> analista_id vindo de `usuarios`, que e' a fonte autoritativa.
    // NAO montar a partir de prestacoes_contas: a propria recarga reatribui analista_id
    // sem mexer em analista_nome, entao numa 2a execucao o mapa sairia corrompido.
    const { rows: mapRows } = await cli.query(`SELECT id, nome FROM usuarios WHERE nome IS NOT NULL`)
    const nomeParaId = new Map()
    for (const r of mapRows) nomeParaId.set(normNome(r.nome), r.id)

    // fallback por prefixo: planilha diz "Richard", usuarios tem "Richard Motta Coelho"
    function resolverId(nomeCurto) {
      const n = normNome(nomeCurto)
      if (nomeParaId.has(n)) return nomeParaId.get(n)
      const cand = mapRows.filter(r => normNome(r.nome).startsWith(n + ' '))
      if (cand.length === 1) return cand[0].id
      if (cand.length > 1) throw new Error(`analista ambiguo "${nomeCurto}": ${cand.map(c => c.nome).join(' / ')}`)
      return null
    }

    // universo TR+SGPE do banco
    const { rows: bancoRows } = await cli.query(`
      SELECT tr, ${SGPE_SQL} AS sgpe_norm, COUNT(*)::int AS qtd
      FROM prestacoes_contas WHERE setorial_id='FCEE' GROUP BY 1,2
    `)
    const noBanco = new Map()
    const porSGPE = new Map()   // sgpe_norm -> Set(TR)  — para o fallback da classe C
    for (const r of bancoRows) {
      const tr = normTR(r.tr)
      noBanco.set(tr + '|' + r.sgpe_norm, r.qtd)
      if (!porSGPE.has(r.sgpe_norm)) porSGPE.set(r.sgpe_norm, new Set())
      porSGPE.get(r.sgpe_norm).add(tr)
    }

    // Fallback restrito: a planilha aponta um TR, o banco tem o processo em OUTRO TR.
    // So aceita quando o SGPE existe em EXATAMENTE UM TR no banco e nao e' degenerado
    // (precisa ter letra e >=3 digitos) — evita o caso "1", que aparece em 50 TRs.
    function trUnicoPorSGPE(sgpe) {
      if (!/[A-Z]/.test(sgpe)) return null
      if (sgpe.replace(/[^0-9]/g, '').length < 3) return null
      const trs = porSGPE.get(sgpe)
      if (!trs || trs.size !== 1) return null
      return [...trs][0]
    }

    // ── monta as chaves TR+SGPE a marcar (regra 5; nunca TR+Parcial — regra 6)
    const chaves = new Map()   // "TR|SGPE" -> alvo
    const semAnalista = [], conflitos = [], naoCasados = [], divergencias = [], recuperadas = []

    for (const gr of grupos) {
      for (const p of gr.parciais) {
        if (!p.sgpe) { naoCasados.push([gr.g, p.analista, p.tr, '(sem sgpe)', p.parcial, p.numPcs, p.situacao]); continue }
        let trUsado = p.tr
        let k = p.tr + '|' + p.sgpe
        if (!noBanco.has(k)) {
          const alt = trUnicoPorSGPE(p.sgpe)          // classe C: TR divergente
          if (alt) {
            recuperadas.push([gr.g, p.analista, p.tr, alt, p.sgpeBruto, p.parcial, p.numPcs, noBanco.get(alt + '|' + p.sgpe)])
            trUsado = alt
            k = alt + '|' + p.sgpe
          } else {
            naoCasados.push([gr.g, p.analista, p.tr, p.sgpeBruto, p.parcial, p.numPcs, p.situacao])
            continue
          }
        }
        if (!chaves.has(k)) {
          chaves.set(k, { tr: trUsado, sgpe: p.sgpe, bruto: p.sgpeBruto, qtdBanco: noBanco.get(k),
                          soma: 0, linhas: 0, parciais: [], porAnalista: new Map(), situacao: p.situacao, grupos: new Set() })
        }
        const c = chaves.get(k)
        c.soma += p.numPcs; c.linhas++; c.parciais.push(p.parcial); c.grupos.add(gr.g)
        const at = c.porAnalista.get(p.analista) || { soma: 0, grupo: gr.g }
        at.soma += p.numPcs
        c.porAnalista.set(p.analista, at)
        c.situacao = p.situacao
      }
    }

    // resolve analista e parcial de cada chave
    for (const [k, c] of chaves) {
      const ord = [...c.porAnalista.entries()].sort((a, b) => b[1].soma - a[1].soma)
      c.analista = ord[0][0]
      c.grupoEscolhido = ord[0][1].grupo
      if (ord.length > 1) conflitos.push([c.tr, c.bruto, ord.map(([n, v]) => `${n}(${v.grupo})=${v.soma}`).join(' / '), `escolhido: ${c.analista}`])
      c.analistaId = resolverId(c.analista)
      if (c.analistaId === null) semAnalista.push([c.analista, c.tr, c.bruto, c.qtdBanco])
      const nums = c.parciais.map(x => parseInt(x, 10)).filter(Number.isFinite).sort((a, b) => a - b)
      c.parcialNum = nums.length ? String(nums[0]) : (c.parciais[0] || null)   // regra 7: nunca escreve em `tipo`
      if (c.soma !== c.qtdBanco) divergencias.push([c.tr, c.bruto, c.analista, c.linhas, c.soma, c.qtdBanco, c.soma - c.qtdBanco])
    }

    // cada chave conta uma unica vez, para o grupo do analista escolhido
    const esperado = [...chaves.values()].reduce((s, c) => s + c.qtdBanco, 0)
    const esperadoPorGrupo = {}
    for (const c of chaves.values()) {
      esperadoPorGrupo[c.grupoEscolhido] = (esperadoPorGrupo[c.grupoEscolhido] || 0) + c.qtdBanco
    }

    console.log('='.repeat(80))
    console.log(`RECARGA POR PARCIAL ${DRY ? '— MODO DRY-RUN (rollback garantido)' : '— GRAVANDO'}`)
    console.log('='.repeat(80))
    console.log(`chaves TR+SGPE a marcar : ${chaves.size}`)
    console.log(`PCs esperadas           : ${esperado}`)
    console.log(`parciais nao casadas    : ${naoCasados.length}`)
    console.log(`recuperadas por TR alt  : ${recuperadas.length} parciais (classe C)`)
    console.log(`chaves sem analista_id  : ${semAnalista.length}`)
    console.log(`chaves multi-analista   : ${conflitos.length}`)
    console.log(`divergencia num_pcs     : ${divergencias.length}`)

    // ── TRANSACAO ───────────────────────────────────────────────────
    await cli.query('BEGIN')

    // passo 5 — backup antes de qualquer UPDATE
    await cli.query(`
      CREATE TABLE IF NOT EXISTS ${TAB_BACKUP} AS
      SELECT id, baixada, parecer_tipo, analista_id, status, data_baixa, origem_baixa, parcial_num
      FROM prestacoes_contas WHERE setorial_id='FCEE'
    `)
    const { rows: bk } = await cli.query(`SELECT COUNT(*)::int n FROM ${TAB_BACKUP}`)
    console.log(`\nbackup ${TAB_BACKUP}: ${bk[0].n} linhas`)

    // passo 2a — devolve analista_id ao estado original do backup.
    // Torna a execucao idempotente: sem isso, uma 2a rodada partiria dos ids
    // ja reatribuidos pela 1a e as diferencas se acumulariam.
    const rid = await cli.query(`
      UPDATE prestacoes_contas p SET analista_id = b.analista_id
        FROM ${TAB_BACKUP} b
       WHERE b.id = p.id AND p.setorial_id='FCEE'
         AND p.analista_id IS DISTINCT FROM b.analista_id
    `)
    console.log(`analista_id restaurado do backup: ${rid.rowCount} linhas`)

    // passo 2 — zera o estado de baixa (mantendo status coerente)
    const rst = await cli.query(`
      UPDATE prestacoes_contas
         SET baixada=false, parecer_tipo=NULL, parcial_num=NULL,
             data_baixa=NULL, origem_baixa=NULL,
             status = CASE WHEN status='baixada' THEN 'livre' ELSE status END
       WHERE setorial_id='FCEE'
    `)
    console.log(`reset: ${rst.rowCount} linhas`)

    // passo 3 — marca as PCs, casando por TR + SGPE normalizado
    await cli.query(`
      CREATE TEMP TABLE _alvo (tr text, sgpe text, parecer text, analista_id integer, parcial_num text) ON COMMIT DROP
    `)
    const alvos = [...chaves.values()].map(c => [
      c.tr, c.sgpe, c.situacao, c.analistaId === null ? null : Number(c.analistaId), c.parcialNum
    ])
    for (let j = 0; j < alvos.length; j += 500) {
      const fatia = alvos.slice(j, j + 500)
      const params = fatia.flat()
      const vals = fatia.map((_, x) => {
        const b = x * 5
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`
      }).join(',')
      await cli.query(`INSERT INTO _alvo (tr,sgpe,parecer,analista_id,parcial_num) VALUES ${vals}`, params)
    }
    const { rows: alvoN } = await cli.query('SELECT COUNT(*)::int n FROM _alvo')
    if (alvoN[0].n !== chaves.size) throw new Error(`_alvo tem ${alvoN[0].n}, esperado ${chaves.size}`)

    const upd = await cli.query(`
      UPDATE prestacoes_contas p
         SET baixada = true,
             status = 'baixada',
             parecer_tipo = a.parecer,
             parcial_num  = a.parcial_num,
             analista_id  = COALESCE(a.analista_id, p.analista_id),
             data_baixa   = DATE '2026-06-30',
             origem_baixa = 'recarga_parcial_20260805'
        FROM _alvo a
       WHERE p.setorial_id='FCEE'
         AND regexp_replace(upper(p.tr),'[^A-Z0-9]','','g') = a.tr
         AND (${SGPE_SQL.replace(/processo_pc/g, 'p.processo_pc')}) = a.sgpe
    `)
    console.log(`marcadas: ${upd.rowCount} linhas`)

    // passo 4 — validacao dentro da transacao
    const { rows: val } = await cli.query(`
      SELECT COALESCE(u.nome, p.analista_nome, '(sem analista)') AS nome,
             p.grupo,
             COUNT(*) FILTER (WHERE p.baixada)::int AS baixadas
      FROM prestacoes_contas p LEFT JOIN usuarios u ON u.id = p.analista_id
      WHERE p.setorial_id='FCEE' GROUP BY 1,2 ORDER BY 2,1
    `)
    const { rows: tot } = await cli.query(`
      SELECT COUNT(*) FILTER (WHERE baixada)::int AS baixadas,
             COUNT(*) FILTER (WHERE baixada AND status<>'baixada')::int AS incoerentes
      FROM prestacoes_contas WHERE setorial_id='FCEE'
    `)
    const { rows: porGrupo } = await cli.query(`
      SELECT grupo, COUNT(*) FILTER (WHERE baixada)::int AS baixadas
      FROM prestacoes_contas WHERE setorial_id='FCEE' GROUP BY 1 ORDER BY 1
    `)

    console.log('\n' + '='.repeat(80))
    console.log('VALIDACAO')
    console.log('='.repeat(80))
    console.log(`total baixadas no banco : ${tot[0].baixadas}`)
    console.log(`esperado (calculado)    : ${esperado}`)
    console.log(`incoerentes status      : ${tot[0].incoerentes}`)
    console.log('\nbaixadas por grupo (coluna `grupo` do banco):')
    porGrupo.forEach(r => console.log(`   ${String(r.grupo || '(sem grupo)').padEnd(14)} ${r.baixadas}`))

    console.log('\nGRUPO   GABARITO   MARCADO   DIF     VALIDADO CONTRA')
    let falhou = false
    for (const gr of grupos) {
      const marc = esperadoPorGrupo[gr.g] || 0
      const alvo = gr.validaContra === 'banco' ? marc : gr.gabarito
      const dif  = alvo - marc
      const pct  = alvo ? Math.abs(dif) / alvo : 0
      const ok   = pct <= TOLERANCIA
      if (!ok) falhou = true
      console.log(`${gr.g}      ${String(gr.gabarito).padStart(7)}   ${String(marc).padStart(7)}   ${String(gr.gabarito - marc).padStart(5)}   ` +
                  `${gr.validaContra === 'banco' ? 'banco (' + alvo + ')' : 'gabarito'}  ${ok ? 'OK' : 'FALHOU'} (${(pct * 100).toFixed(1)}%)`)
    }

    if (tot[0].baixadas !== esperado) { falhou = true; console.log(`\n!! total marcado (${tot[0].baixadas}) != esperado (${esperado})`) }
    if (tot[0].incoerentes > 0)       { falhou = true; console.log(`\n!! ${tot[0].incoerentes} linhas com baixada=true e status<>'baixada'`) }

    // relatorios
    fs.writeFileSync(path.join(SAIDA, 'nao_casados.csv'),
      csv([['grupo', 'analista', 'tr', 'sgpe', 'parcial', 'num_pcs', 'situacao'], ...naoCasados]), 'utf8')
    fs.writeFileSync(path.join(SAIDA, 'divergencia_numpcs.csv'),
      csv([['tr', 'sgpe', 'analista', 'linhas_planilha', 'num_pcs_planilha', 'pcs_no_banco', 'dif'], ...divergencias]), 'utf8')
    fs.writeFileSync(path.join(SAIDA, 'validacao_por_analista.csv'),
      csv([['nome', 'grupo', 'baixadas'], ...val.map(r => [r.nome, r.grupo, r.baixadas])]), 'utf8')
    if (recuperadas.length) fs.writeFileSync(path.join(SAIDA, 'recuperadas_por_sgpe.csv'),
      csv([['grupo', 'analista', 'tr_planilha', 'tr_banco', 'sgpe', 'parcial', 'num_pcs', 'pcs_no_banco'], ...recuperadas]), 'utf8')
    if (conflitos.length)   fs.writeFileSync(path.join(SAIDA, 'chaves_multi_analista.csv'), csv([['tr', 'sgpe', 'disputa', 'decisao'], ...conflitos]), 'utf8')
    if (semAnalista.length) fs.writeFileSync(path.join(SAIDA, 'sem_analista_id.csv'), csv([['analista', 'tr', 'sgpe', 'pcs'], ...semAnalista]), 'utf8')

    if (DRY) {
      await cli.query('ROLLBACK')
      console.log('\n>> DRY-RUN: ROLLBACK executado. Nada foi gravado.')
    } else if (falhou) {
      await cli.query('ROLLBACK')
      console.log('\n>> VALIDACAO FALHOU: ROLLBACK executado. Nada foi gravado.')
      process.exitCode = 2
    } else {
      await cli.query('COMMIT')
      commitou = true
      console.log('\n>> COMMIT executado.')
    }

    console.log(`\nCSVs em ${SAIDA}`)
  } catch (e) {
    try { await cli.query('ROLLBACK') } catch {}
    console.error('\nERRO — ROLLBACK: ' + e.message)
    process.exitCode = 1
  } finally {
    cli.release()
    await pool.end()
  }

  if (commitou) {
    console.log(`\nPara reverter manualmente:
  UPDATE prestacoes_contas p SET baixada=b.baixada, parecer_tipo=b.parecer_tipo,
         analista_id=b.analista_id, status=b.status, data_baixa=b.data_baixa,
         origem_baixa=b.origem_baixa, parcial_num=b.parcial_num
    FROM ${TAB_BACKUP} b WHERE b.id=p.id;`)
  }
})().catch(e => { console.error('\nERRO: ' + e.message); process.exit(1) })
