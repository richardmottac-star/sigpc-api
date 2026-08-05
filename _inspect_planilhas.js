// Inspeciona a estrutura das 3 planilhas: abas, cabecalhos e amostra.
// Somente leitura. Nao toca no banco. NAO COMMITAR.
const XLSX = require('xlsx')

const ARQS = [
  ['G1', 'C:/Users/Richard/Downloads/GRUPO 1 - Nayara (9).xlsx'],
  ['G2', 'C:/Users/Richard/Downloads/GRUPO 2 - Zadir (7).xlsx'],
  ['G3', 'C:/Users/Richard/Downloads/GRUPO_3__GUSTAVO__2_.xlsx']
]

for (const [g, arq] of ARQS) {
  console.log('\n' + '='.repeat(78))
  console.log(`${g}  ${arq.split('/').pop()}`)
  console.log('='.repeat(78))
  const wb = XLSX.readFile(arq, { cellDates: true })
  console.log('abas: ' + wb.SheetNames.map(n => `"${n}"`).join(' | '))

  for (const nome of wb.SheetNames) {
    const ws = wb.Sheets[nome]
    const ref = ws['!ref']
    if (!ref) { console.log(`\n  [${nome}] vazia`); continue }
    const range = XLSX.utils.decode_range(ref)
    const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false })
    console.log(`\n  [${nome}] ${range.e.r + 1} linhas x ${range.e.c + 1} colunas`)

    // procura a linha de cabecalho: a primeira com >=3 celulas de texto nao vazias
    let hi = -1
    for (let i = 0; i < Math.min(12, linhas.length); i++) {
      const preenchidas = (linhas[i] || []).filter(c => c !== null && String(c).trim() !== '').length
      if (preenchidas >= 3) { hi = i; break }
    }
    if (hi < 0) { console.log('    nao achei cabecalho'); continue }
    console.log(`    cabecalho na linha ${hi + 1}:`)
    ;(linhas[hi] || []).forEach((c, j) => {
      if (c !== null && String(c).trim() !== '') {
        console.log(`      ${XLSX.utils.encode_col(j).padEnd(3)} "${String(c).trim()}"`)
      }
    })
    const amostra = linhas[hi + 1]
    if (amostra) {
      console.log('    1a linha de dados:')
      amostra.forEach((c, j) => {
        if (c !== null && String(c).trim() !== '') {
          const v = String(c).trim()
          console.log(`      ${XLSX.utils.encode_col(j).padEnd(3)} ${v.slice(0, 60)}`)
        }
      })
    }
  }
}
