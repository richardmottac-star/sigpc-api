// CAMINHO: sigpc-api/migracao_data_baixa_sigef_20260827.js
//
// A DATA REAL DA BAIXA NO SIGEF — coluna `prestacoes_contas.data_baixa_sigef date`.
// Autorizada pelo Richard em 27/08/2026.
//
//   node migracao_data_baixa_sigef_20260827.js                 (DRY-RUN — nao grava nada)
//   node migracao_data_baixa_sigef_20260827.js --gravar        (grava)
//   node migracao_data_baixa_sigef_20260827.js --planilha="C:\...\Baixas FCEE.xlsx"
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ESTA COLUNA EXISTE
//
// As PCs da carga tem `data_baixa = 30/06/2026`, que e a data do RECARREGAMENTO, nao a data
// em que o parecer foi emitido no SIGEF. A propria nota metodologica do
// `PCS_BAIXADAS_ATE_31072026_CGE.xlsx` ja dizia isso: "qualquer recorte por data de baixa
// feito aqui nao reproduz o recorte do SIGEF". Sem cronologia nao ha relatorio trimestral —
// 3.614 baixas num unico dia nao se distribuem em trimestre nenhum.
//
// A fonte e a coluna `Data Ult Mod - 07-08-26` da planilha `Baixas FCEE.xlsx` (SIGEF):
// 3.359 parciais + 107 finais.
//
// ⚠️ A COLUNA NOVA NAO SUBSTITUI A ANTIGA, E ESTA RODADA NAO ENCOSTA NA ANTIGA.
// `data_baixa` continua sendo o carimbo do SISTEMA (quando o SIGPC-GT registrou a baixa), e e
// ela que a produtividade usa hoje. `data_baixa_sigef` e o carimbo do SIGEF (quando o parecer
// foi emitido la). Sao perguntas diferentes, e juntar as duas numa coluna so destruiria a
// unica que ja existe. Qual das duas o relatorio trimestral vai usar e decisao de REGRA, do
// Richard, e NAO esta sendo tomada aqui.
//
// ⚠️ ESTA RODADA NAO TOCA EM `data_baixa`, `baixada`, `enviado_ci`, `parecer_tipo` NEM EM
// PRODUTIVIDADE. As conferencias 6 e 7 existem para PROVAR isso: um `md5` de TODAS as colunas
// pre-existentes, linha a linha, antes e depois. Contar linhas nao prova que elas nao mudaram
// — a licao do aviso id 6, em 17/08.
//
// ⚠️ PARTE DAS PCs DA PLANILHA NAO ESTA BAIXADA NO NOSSO SISTEMA, e mesmo assim recebe a data.
// Nao e engano: a planilha e uma lista de BAIXAS do SIGEF (`Status 07-08-26` so tem "Baixa
// Regular" e "Baixa Regular Ressalva"), entao o SIGEF baixou e o nosso sistema nao registrou.
// A data e verdadeira; o que falta e a baixa deste lado. Preencher expoe o buraco em vez de
// esconde-lo — e `baixada` continua `false`, porque mexer nela seria mexer na produtividade.
//
// ⚠️ A DATA E LIDA TRES VEZES, POR TRES CAMINHOS INDEPENDENTES, e o script ABORTA se as tres
// nao baterem em TODAS as linhas: (a) o `Date` do `cellDates`, (b) o serial cru do Excel via
// `SSF.parse_date_code` — que nao passa por fuso nenhum — e (c) o texto formatado `m/d/yy`.
// "11/4/25" e 04/11/2025 lido como m/d/yy e 11/04/2025 lido como d/m/yy: um candidato so
// esconderia a ambiguidade (armadilha 19), e um erro de fuso de tres horas move a data de dia
// (armadilhas 18 e 25). Tres leituras concordando fecham as duas portas.
//
// ⚠️ A ABA `Parciais -TEVs` TEM DUAS COLUNAS CHAMADAS `Parcial` (indices 8 e 11) — armadilha
// 16-A. Por isso TODA leitura aqui e por INDICE, com o nome do cabecalho CONFERIDO antes: ler
// por nome pega uma das duas de forma imprevisivel, conforme a biblioteca.

const { Pool } = require('pg');
const fs = require('fs');
const { HOJE_BR } = require('./lib/datas');

let XLSX;
try {
  XLSX = require('xlsx');
} catch (e) {
  console.error('\n  X O pacote `xlsx` nao esta instalado. Rode:  npm i xlsx');
  console.error('    (ele nao esta no package.json de proposito — nenhum script de');
  console.error('     manutencao roda no Railway, e o deploy nao precisa dele.)\n');
  process.exit(1);
}

const GRAVAR = process.argv.includes('--gravar');
const TABELA = 'prestacoes_contas';
const COLUNA = 'data_baixa_sigef';
const TIPO = 'date';

// ⚠️ O DRY-RUN NUNCA SOBRESCREVE A REVERSAO DA GRAVACAO. Sao dois nomes de arquivo, e nao um
// com flag: um dry-run rodado depois da gravacao apagaria o unico registro de como voltar.
const ARQ_REVERSAO = GRAVAR
  ? 'reverter_data_baixa_sigef_20260827.json'
  : 'reverter_data_baixa_sigef_20260827_DRYRUN.json';

// ── A PLANILHA ───────────────────────────────────────────────────────────────
// Caminhos tentados, em ordem. Nenhum e adivinhado: ou e um destes, ou vem por --planilha.
const CANDIDATOS = [
  'C:\\Users\\Richard\\Baixas_FCEE.xlsx',
  'C:\\Users\\Richard\\Baixas FCEE.xlsx',
  'C:\\Users\\Richard\\Downloads\\Baixas_FCEE.xlsx',
  'C:\\Users\\Richard\\Downloads\\Baixas FCEE.xlsx',
];

// ⚠️ INDICE E NOME ESPERADO, os dois. O indice e o que le; o nome e o que confere. Se a
// planilha for reexportada com outra ordem de colunas, o script PARA em vez de gravar a
// coluna errada em milhares de linhas.
const ABAS = [
  {
    aba: 'Parciais -TEVs',
    iChave: 9, nomeChave: 'NR. PC',
    iData: 30, nomeData: 'Data Ult Mod - 07-08-26',
    esperado: 3359,
  },
  {
    aba: 'Finais',
    iChave: 8, nomeChave: 'TRANSFERÊNCIA',
    iData: 13, nomeData: 'Data Ult Mod - 07-08-26',
    esperado: 107,
  },
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const linha = (t) => console.log(t);
const passo = (t) => console.log(`\n-- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);

let confOk = 0, confFalhou = 0;
function conferir(nome, cond, detalhe) {
  if (cond) { confOk++; linha(`   OK    ${nome}`); }
  else { confFalhou++; linha(`   FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
  return cond;
}

// ─────────────────────────────────────────────────────────────────────────────
// A LEITURA DA PLANILHA — tres caminhos para a mesma data, e aborta se divergirem.
// ─────────────────────────────────────────────────────────────────────────────
function acharPlanilha() {
  const arg = process.argv.find((a) => a.startsWith('--planilha='));
  if (arg) {
    const p = arg.slice('--planilha='.length).replace(/^"|"$/g, '');
    if (!fs.existsSync(p)) throw new Error(`--planilha aponta para arquivo inexistente: ${p}`);
    return p;
  }
  const achado = CANDIDATOS.find((p) => fs.existsSync(p));
  if (!achado) {
    throw new Error(
      'planilha nao encontrada. Tentados:\n     ' + CANDIDATOS.join('\n     ')
      + '\n   Passe o caminho com --planilha="C:\\...\\Baixas FCEE.xlsx"');
  }
  return achado;
}

function lerAba(wbD, wbN, spec) {
  const wsD = wbD.Sheets[spec.aba];
  const wsN = wbN.Sheets[spec.aba];
  if (!wsD) throw new Error(`a aba "${spec.aba}" nao existe na planilha`);
  const rg = XLSX.utils.decode_range(wsD['!ref']);

  // Confere o CABECALHO nos dois indices antes de ler uma linha sequer.
  const cab = (i) => {
    const c = wsD[XLSX.utils.encode_cell({ r: rg.s.r, c: i })];
    return c ? String(c.v).trim() : null;
  };
  if (cab(spec.iChave) !== spec.nomeChave) {
    throw new Error(`aba "${spec.aba}": a coluna [${spec.iChave}] deveria ser `
      + `"${spec.nomeChave}" e e "${cab(spec.iChave)}"`);
  }
  if (cab(spec.iData) !== spec.nomeData) {
    throw new Error(`aba "${spec.aba}": a coluna [${spec.iData}] deveria ser `
      + `"${spec.nomeData}" e e "${cab(spec.iData)}"`);
  }

  const itens = [];
  const problemas = [];
  for (let r = rg.s.r + 1; r <= rg.e.r; r++) {
    const cK = wsD[XLSX.utils.encode_cell({ r, c: spec.iChave })];
    const chave = cK ? String(cK.v).trim() : '';
    const cD = wsD[XLSX.utils.encode_cell({ r, c: spec.iData })];
    const cN = wsN[XLSX.utils.encode_cell({ r, c: spec.iData })];

    if (!chave) { problemas.push({ linha: r + 1, erro: 'chave vazia' }); continue; }
    if (!cD || cD.v === null || cD.v === '') {
      problemas.push({ linha: r + 1, chave, erro: 'data vazia' });
      continue;
    }

    // (a) o Date do cellDates
    const a = cD.v instanceof Date ? cD.v.toISOString().slice(0, 10) : null;
    // (b) o serial cru do Excel — nao passa por fuso nenhum
    let b = null;
    if (cN && typeof cN.v === 'number') {
      const p = XLSX.SSF.parse_date_code(cN.v);
      if (p) b = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }
    // (c) o texto formatado m/d/yy
    let c = null;
    if (cD.w && /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(cD.w)) {
      const [m, dia, y] = cD.w.split('/').map(Number);
      c = `20${String(y).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
    if (!a || a !== b || b !== c) {
      problemas.push({ linha: r + 1, chave, erro: 'as tres leituras da data divergem', a, b, c, w: cD.w });
      continue;
    }
    itens.push({ linha: r + 1, chave, data: a });
  }
  return { itens, problemas };
}

// ─────────────────────────────────────────────────────────────────────────────
// A FOTO DA TABELA
//
// ⚠️ O `md5` COBRE TODAS AS COLUNAS PRE-EXISTENTES, uma a uma, com separador, EXCLUINDO a
// coluna nova. Um `md5` de `to_jsonb(linha)` mudaria sozinho quando a coluna entrasse — e a
// conferencia que deveria provar "nada mais mudou" acusaria a propria migracao.
// ─────────────────────────────────────────────────────────────────────────────
function sqlFoto(listaColunas) {
  return `
  SELECT
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS tem_coluna,
    (SELECT data_type FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS tipo_coluna,
    (SELECT is_nullable FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS nullable_coluna,
    (SELECT column_default FROM information_schema.columns
      WHERE table_name = '${TABELA}' AND column_name = '${COLUNA}')          AS default_coluna,
    (SELECT COUNT(*)::int FROM information_schema.columns
      WHERE table_name = '${TABELA}')                                        AS n_colunas,
    (SELECT COUNT(*)::int FROM ${TABELA})                                    AS n_linhas,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE baixada = true)               AS n_baixadas,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE enviado_ci = true)            AS n_enviado_ci,
    (SELECT COUNT(*)::int FROM ${TABELA}
      WHERE baixada = true OR enviado_ci = true)                             AS n_produtividade,
    (SELECT COUNT(*)::int FROM ${TABELA}
      WHERE data_baixa::date = DATE '2026-06-30')                            AS n_data_baixa_3006,
    (SELECT COUNT(*)::int FROM ${TABELA} WHERE parecer_tipo IS NOT NULL)     AS n_com_parecer,
    -- o md5 das QUATRO colunas que esta rodada promete nao tocar, explicito e legivel
    (SELECT md5(COALESCE(string_agg(
        concat_ws(chr(31), codigo_pc, data_baixa, baixada, enviado_ci, parecer_tipo),
        chr(30) ORDER BY codigo_pc), '')) FROM ${TABELA})                    AS md5_intocaveis,
    -- e o md5 de TUDO que ja existia, que e a conferencia que fecha a porta de verdade
    (SELECT md5(COALESCE(string_agg(t.a, chr(30) ORDER BY t.codigo_pc), ''))
       FROM (SELECT codigo_pc, concat_ws(chr(31), ${listaColunas}) AS a
               FROM ${TABELA}) t)                                            AS md5_conteudo`;
}

(async () => {
  const cli = await pool.connect();
  let commitou = false;
  try {
    linha('=======================================================================');
    linha(`  A DATA REAL DA BAIXA NO SIGEF — ${TABELA}.${COLUNA} ${TIPO}`);
    linha(`  MODO: ${GRAVAR ? '*** GRAVAR ***' : 'DRY-RUN (nada e escrito)'}`);
    linha('=======================================================================');

    // ── 1. A PLANILHA ────────────────────────────────────────────────────────
    passo('1. A PLANILHA');
    const arq = acharPlanilha();
    linha(`   arquivo ....................... ${arq}`);
    const wbD = XLSX.readFile(arq, { cellDates: true });
    const wbN = XLSX.readFile(arq, { cellDates: false });
    linha(`   abas .......................... ${wbD.SheetNames.join(' · ')}`);

    const lido = {};
    for (const spec of ABAS) {
      const { itens, problemas } = lerAba(wbD, wbN, spec);
      lido[spec.aba] = { spec, itens, problemas };
      linha(`   ${spec.aba.padEnd(16)} ......... ${String(itens.length).padStart(5)} linhas lidas`
        + (problemas.length ? `  ⚠️ ${problemas.length} PROBLEMAS` : '   (0 problemas)'));
      if (problemas.length) {
        problemas.slice(0, 10).forEach((p) => linha(`      ⚠️  ${JSON.stringify(p)}`));
        throw new Error(`a aba "${spec.aba}" tem ${problemas.length} linha(s) que nao deram para ler com seguranca`);
      }
      if (itens.length !== spec.esperado) {
        linha(`      ⚠️  esperava ${spec.esperado} linhas nesta aba e vieram ${itens.length}`
          + ' — a planilha mudou de tamanho');
      }
      // Chave repetida na planilha e ambiguidade: qual data valeria?
      const cont = {};
      itens.forEach((x) => { cont[x.chave] = (cont[x.chave] || 0) + 1; });
      const reps = Object.entries(cont).filter(([, n]) => n > 1);
      if (reps.length) {
        const comConflito = reps.filter(([k]) =>
          new Set(itens.filter((x) => x.chave === k).map((x) => x.data)).size > 1);
        linha(`      ⚠️  ${reps.length} chave(s) repetida(s), ${comConflito.length} com DATAS DIFERENTES`);
        if (comConflito.length) {
          throw new Error(`a aba "${spec.aba}" tem chave repetida com data diferente — `
            + 'qual data vale e decisao de regra, nao do script');
        }
      }
    }
    const todasAsDatas = Object.values(lido).flatMap((x) => x.itens.map((i) => i.data)).sort();
    linha(`   faixa das datas ............... ${todasAsDatas[0]} a ${todasAsDatas[todasAsDatas.length - 1]}`);

    await cli.query('BEGIN');

    // ── 2. A FOTO, ANTES ─────────────────────────────────────────────────────
    passo('2. FOTO DE ANTES');
    const { rows: cols } = await cli.query(
      `SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS lista
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name <> $2`, [TABELA, COLUNA]);
    const SQL_FOTO = sqlFoto(cols[0].lista);

    const { rows: a } = await cli.query(SQL_FOTO);
    const antes = a[0];
    linha(`   coluna ${COLUNA} existe? .. ${antes.tem_coluna ? 'SIM (' + antes.tipo_coluna + ')' : 'nao'}`);
    linha(`   colunas na tabela ............. ${antes.n_colunas}`);
    linha(`   linhas (PCs) .................. ${antes.n_linhas}`);
    linha(`   baixada = true ................ ${antes.n_baixadas}`);
    linha(`   enviado_ci = true ............. ${antes.n_enviado_ci}`);
    linha(`   produtividade (baixada OU ci) . ${antes.n_produtividade}`);
    linha(`   data_baixa = 30/06/2026 ....... ${antes.n_data_baixa_3006}`);
    linha(`   com parecer_tipo .............. ${antes.n_com_parecer}`);
    linha(`   md5 das 4 intocaveis .......... ${antes.md5_intocaveis}`);
    linha(`   md5 de tudo que ja existia .... ${antes.md5_conteudo}`);

    // ── 3. A COLUNA ──────────────────────────────────────────────────────────
    passo('3. A COLUNA');
    const DDL = `ALTER TABLE ${TABELA} ADD COLUMN IF NOT EXISTS ${COLUNA} ${TIPO}`;
    linha(`   ${DDL}`);
    if (antes.tem_coluna) {
      linha(`   (a coluna JA EXISTE — ${antes.tipo_coluna}. O ADD COLUMN IF NOT EXISTS nao faz nada.)`);
      if (antes.tipo_coluna !== TIPO) {
        linha(`   ⚠️  MAS O TIPO E ${antes.tipo_coluna}, e o esperado e ${TIPO}. Conferir a mao.`);
      }
    }
    await cli.query(DDL);

    // ── 4. O PLANO ───────────────────────────────────────────────────────────
    passo('4. O PLANO — o que casa, e o que nao casa');

    // 4a. PARCIAIS: casam por codigo_pc.
    const par = lido['Parciais -TEVs'].itens;
    const { rows: achadosPar } = await cli.query(
      `SELECT codigo_pc, baixada FROM ${TABELA} WHERE codigo_pc = ANY($1)`,
      [par.map((x) => x.chave)]);
    const mapaPar = new Map(achadosPar.map((r) => [r.codigo_pc, r]));

    // 4b. FINAIS: casam por tr, e a data vai na PC final DAQUELA TR.
    //     ⚠️ Resolvido pelo BANCO (`tipo = 'final'`), e nao pela suposicao de que o codigo e
    //     `tr || '-PFINAL'`. A convencao bate hoje em 100% das finais, mas quem responde
    //     "qual e a PC final desta TR" e a tabela, nao o formato do texto.
    const fin = lido['Finais'].itens;
    const { rows: achadosFin } = await cli.query(
      `SELECT tr, COUNT(*)::int AS n, MIN(codigo_pc) AS codigo_pc, bool_or(baixada) AS baixada
         FROM ${TABELA} WHERE tr = ANY($1) AND tipo = 'final' GROUP BY tr`,
      [fin.map((x) => x.chave)]);
    const mapaFin = new Map(achadosFin.map((r) => [r.tr, r]));
    const trsMultiplas = achadosFin.filter((r) => r.n > 1);
    if (trsMultiplas.length) {
      throw new Error(`${trsMultiplas.length} TR(s) tem MAIS DE UMA PC final — a qual delas a `
        + 'data se aplica e decisao de regra: ' + trsMultiplas.map((r) => r.tr).join(', '));
    }

    // 4c. O plano, e as sobras.
    const plano = [];
    const semCorrespondencia = [];
    for (const x of par) {
      const r = mapaPar.get(x.chave);
      if (!r) {
        semCorrespondencia.push({ origem: 'parcial', chave: x.chave, linha: x.linha,
          motivo: 'codigo_pc nao existe em prestacoes_contas' });
        continue;
      }
      plano.push({ codigo_pc: r.codigo_pc, data: x.data, origem: 'parcial', chave: x.chave, baixada_aqui: r.baixada });
    }
    for (const x of fin) {
      const r = mapaFin.get(x.chave);
      if (!r) {
        semCorrespondencia.push({ origem: 'final', chave: x.chave, linha: x.linha,
          motivo: 'a TR nao tem PC final em prestacoes_contas' });
        continue;
      }
      plano.push({ codigo_pc: r.codigo_pc, data: x.data, origem: 'final', chave: x.chave, baixada_aqui: r.baixada });
    }

    // Uma PC nao pode aparecer duas vezes no plano com datas diferentes.
    const porPc = new Map();
    for (const p of plano) {
      if (porPc.has(p.codigo_pc) && porPc.get(p.codigo_pc).data !== p.data) {
        throw new Error(`a PC ${p.codigo_pc} recebeu duas datas diferentes no plano `
          + `(${porPc.get(p.codigo_pc).data} e ${p.data})`);
      }
      porPc.set(p.codigo_pc, p);
    }

    const nParcial = plano.filter((p) => p.origem === 'parcial').length;
    const nFinal = plano.filter((p) => p.origem === 'final').length;
    const naoBaixadasAqui = plano.filter((p) => p.baixada_aqui !== true);
    linha(`   parciais da planilha .......... ${String(par.length).padStart(5)}  ->  casaram ${nParcial}`);
    linha(`   finais da planilha ............ ${String(fin.length).padStart(5)}  ->  casaram ${nFinal}`);
    linha(`   TOTAL a preencher ............. ${String(plano.length).padStart(5)} PCs`);
    linha('');
    linha(`   ⚠️  SEM CORRESPONDENCIA ....... ${semCorrespondencia.length}`);
    if (semCorrespondencia.length) {
      const porOrigem = {};
      semCorrespondencia.forEach((s) => { porOrigem[s.origem] = (porOrigem[s.origem] || 0) + 1; });
      linha(`      por origem: ${JSON.stringify(porOrigem)}`);
      semCorrespondencia.slice(0, 25).forEach((s) =>
        linha(`      · ${s.origem} ${s.chave} (linha ${s.linha}) — ${s.motivo}`));
      if (semCorrespondencia.length > 25) {
        linha(`      · ... e mais ${semCorrespondencia.length - 25} — a lista inteira vai no JSON de reversao`);
      }
    }
    linha('');
    linha(`   ⚠️  recebem data mas NAO estao baixadas aqui ... ${naoBaixadasAqui.length}`);
    linha(`      (${naoBaixadasAqui.filter((p) => p.origem === 'parcial').length} parciais · `
      + `${naoBaixadasAqui.filter((p) => p.origem === 'final').length} finais) — o SIGEF baixou e o`);
    linha('      sistema nao registrou. `baixada` NAO e tocada; ver o cabecalho deste arquivo.');

    // 4d. O que muda de fato (idempotencia).
    const codigos = plano.map((p) => p.codigo_pc);
    const datas = plano.map((p) => p.data);
    const { rows: antesValores } = await cli.query(
      `SELECT codigo_pc, ${COLUNA}::text AS atual FROM ${TABELA} WHERE codigo_pc = ANY($1)`,
      [codigos]);
    const mapaAtual = new Map(antesValores.map((r) => [r.codigo_pc, r.atual]));
    const aGravar = plano.filter((p) => mapaAtual.get(p.codigo_pc) !== p.data);
    const jaCertas = plano.length - aGravar.length;
    linha('');
    linha(`   ja estao com a data certa ..... ${jaCertas}  (nada a fazer nelas)`);
    linha(`   vao ser escritas .............. ${aGravar.length}`);
    if (aGravar.length === 0) linha('   -> IDEMPOTENTE: nada mudou desde a ultima rodada.');

    // ── 5. A ESCRITA ─────────────────────────────────────────────────────────
    passo('5. O COMANDO DE ESCRITA');
    const SQL_UPDATE = `
      UPDATE ${TABELA} p
         SET ${COLUNA} = v.dt
        FROM (SELECT unnest($1::text[]) AS cpc, unnest($2::date[]) AS dt) v
       WHERE p.codigo_pc = v.cpc
         AND p.${COLUNA} IS DISTINCT FROM v.dt`;
    linha('   UPDATE prestacoes_contas p');
    linha(`      SET ${COLUNA} = v.dt`);
    linha('     FROM (SELECT unnest($1::text[]) cpc, unnest($2::date[]) dt) v');
    linha('    WHERE p.codigo_pc = v.cpc');
    linha(`      AND p.${COLUNA} IS DISTINCT FROM v.dt        -- ${plano.length} pares`);
    linha('');
    linha('   ⚠️  UMA coluna no SET. `data_baixa`, `baixada`, `enviado_ci` e `parecer_tipo`');
    linha('       nao aparecem nem no SET nem no WHERE.');

    const res = await cli.query(SQL_UPDATE, [codigos, datas]);
    linha(`   linhas afetadas ............... ${res.rowCount}`);

    // ── 6. AS CONFERENCIAS, CONTRA A FOTO, DEPOIS DE ESCREVER ────────────────
    passo('6. CONFERENCIAS (contra a foto de antes)');
    const { rows: d } = await cli.query(SQL_FOTO);
    const depois = d[0];

    conferir('1. a coluna passou a existir', depois.tem_coluna === 1);
    conferir(`2. o tipo dela e ${TIPO}`, depois.tipo_coluna === TIPO, `veio ${depois.tipo_coluna}`);
    conferir('3. aceita NULL e nao tem DEFAULT',
      depois.nullable_coluna === 'YES' && depois.default_coluna === null,
      `nullable=${depois.nullable_coluna} default=${depois.default_coluna}`);
    conferir('4. a tabela ganhou exatamente UMA coluna',
      depois.n_colunas === antes.n_colunas + (antes.tem_coluna ? 0 : 1),
      `${antes.n_colunas} -> ${depois.n_colunas}`);
    conferir('5. o numero de PCs nao mudou',
      depois.n_linhas === antes.n_linhas, `${antes.n_linhas} -> ${depois.n_linhas}`);

    // ⚠️ AS DUAS QUE FECHAM A PORTA DE VERDADE.
    conferir('6. md5 das 4 intocaveis IDENTICO — data_baixa, baixada, enviado_ci, parecer_tipo',
      depois.md5_intocaveis === antes.md5_intocaveis,
      `${antes.md5_intocaveis} -> ${depois.md5_intocaveis}`);
    conferir('7. md5 de TODAS as colunas pre-existentes IDENTICO — so a coluna nova mudou',
      depois.md5_conteudo === antes.md5_conteudo,
      `${antes.md5_conteudo} -> ${depois.md5_conteudo}`);

    conferir('8. a produtividade nao se moveu (baixada OU enviado_ci)',
      depois.n_produtividade === antes.n_produtividade,
      `${antes.n_produtividade} -> ${depois.n_produtividade}`);
    conferir('9. as baixas com data_baixa = 30/06/2026 continuam as mesmas',
      depois.n_data_baixa_3006 === antes.n_data_baixa_3006,
      `${antes.n_data_baixa_3006} -> ${depois.n_data_baixa_3006}`);

    // Contra o PREVISTO no plano — nunca contra numero literal.
    const { rows: nn } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA} WHERE ${COLUNA} IS NOT NULL`);
    conferir('10. o total com data do SIGEF e exatamente o previsto no plano',
      nn[0].n === plano.length, `previsto ${plano.length}, veio ${nn[0].n}`);

    const { rows: div } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA} p
         JOIN (SELECT unnest($1::text[]) AS cpc, unnest($2::date[]) AS dt) v
           ON v.cpc = p.codigo_pc
        WHERE p.${COLUNA} IS DISTINCT FROM v.dt`, [codigos, datas]);
    conferir('11. nenhuma PC do plano ficou com data diferente da planilha',
      div[0].n === 0, `${div[0].n} divergentes`);

    const { rows: fora } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA}
        WHERE ${COLUNA} IS NOT NULL AND NOT (codigo_pc = ANY($1))`, [codigos]);
    conferir('12. nenhuma PC de fora do plano ganhou data',
      fora[0].n === 0, `${fora[0].n} PCs de fora com valor`);

    // Armadilha 3: data futura zera relatorio. HOJE_BR, nunca CURRENT_DATE.
    const { rows: fut } = await cli.query(
      `SELECT COUNT(*)::int AS n FROM ${TABELA} WHERE ${COLUNA} > ${HOJE_BR}`);
    conferir('13. nenhuma data do SIGEF esta no futuro (armadilha 3)',
      fut[0].n === 0, `${fut[0].n} no futuro`);

    // A idempotencia, PROVADA dentro da propria transacao: rodar de novo nao muda nada.
    const res2 = await cli.query(SQL_UPDATE, [codigos, datas]);
    conferir('14. rodar o UPDATE de novo afeta ZERO linhas (idempotente)',
      res2.rowCount === 0, `afetou ${res2.rowCount}`);

    // ── 7. REVERSAO ──────────────────────────────────────────────────────────
    passo('7. JSON DE REVERSAO');
    // ⚠️ A reversao vai por LISTA EXPLICITA DE CHAVES, com o valor ANTERIOR de cada uma —
    // nunca por condicao derivada (armadilha 12). Um `WHERE data_baixa_sigef IS NOT NULL`
    // apagaria tambem o que uma rodada posterior tiver escrito.
    const reversao = {
      script: 'migracao_data_baixa_sigef_20260827.js',
      modo: GRAVAR ? 'gravacao' : 'dry-run',
      quando: new Date().toISOString(),
      autorizado_por: 'Richard Motta Coelho, 27/08/2026',
      planilha: arq,
      coluna_fonte: 'Data Ult Mod - 07-08-26',
      alterou: { tabela: TABELA, coluna: COLUNA, tipo: TIPO, ddl: DDL },
      resumo: {
        parciais_planilha: par.length,
        finais_planilha: fin.length,
        casaram: plano.length,
        sem_correspondencia: semCorrespondencia.length,
        ja_estavam_certas: jaCertas,
        escritas: res.rowCount,
        receberam_data_sem_estar_baixadas_aqui: naoBaixadasAqui.length,
      },
      foto_antes: antes,
      foto_depois: depois,
      conferencias: { passaram: confOk, falharam: confFalhou },
      sem_correspondencia: semCorrespondencia,
      // o valor ANTERIOR de cada PC tocada — e por ele que se volta
      valores_anteriores: aGravar.map((p) => ({
        codigo_pc: p.codigo_pc,
        de: mapaAtual.get(p.codigo_pc) === undefined ? null : mapaAtual.get(p.codigo_pc),
        para: p.data,
      })),
      reverter_com:
        'UPDATE prestacoes_contas SET data_baixa_sigef = v.de::date FROM (VALUES ...) '
        + 'AS v(codigo_pc, de) WHERE prestacoes_contas.codigo_pc = v.codigo_pc   '
        + '-- monte o VALUES a partir de `valores_anteriores` deste arquivo',
      reverter_a_coluna_inteira: `ALTER TABLE ${TABELA} DROP COLUMN IF EXISTS ${COLUNA}`,
      aviso_reversao:
        'Se uma rodada posterior tiver escrito nesta coluna, o DROP COLUMN apaga aquilo junto. '
        + 'Voltar pela lista `valores_anteriores` desfaz SO o que esta rodada fez.',
    };
    fs.writeFileSync(ARQ_REVERSAO, JSON.stringify(reversao, null, 2), 'utf8');
    linha(`   escrito: ${ARQ_REVERSAO}`);
    linha(`   ${reversao.valores_anteriores.length} chaves com o valor anterior de cada uma`);

    // ── 8. DESFECHO ──────────────────────────────────────────────────────────
    passo('8. DESFECHO');
    linha(`   conferencias: ${confOk} passaram · ${confFalhou} falharam`);

    if (confFalhou > 0) {
      await cli.query('ROLLBACK');
      linha('\n   X ROLLBACK — alguma conferencia falhou. Nada foi gravado.');
      process.exitCode = 1;
      return;
    }
    if (!GRAVAR) {
      await cli.query('ROLLBACK');
      linha('\n   ROLLBACK — DRY-RUN. Nada foi gravado.');
      linha('   Para gravar: node migracao_data_baixa_sigef_20260827.js --gravar');
      return;
    }
    await cli.query('COMMIT');
    commitou = true;
    linha(`\n   OK COMMIT — ${res.rowCount} PCs com a data real do SIGEF.`);
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* a transacao pode nem ter comecado */ }
    console.error('\n   X ERRO — ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
    if (commitou) {
      linha('\n   A coluna e NOVA e ninguem le ela ainda: nenhuma tela, nenhuma rota,');
      linha('   nenhum relatorio mudou de comportamento. Nao precisa reiniciar a API.');
    }
  }
})();
