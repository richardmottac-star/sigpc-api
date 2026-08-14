// CAMINHO: sigpc-api/prova_banco_ci.js
//
// A PARCIAL DO RAFAEL ABRE COM O BOTÃO DO C.I. ATIVO? — prova CONTRA O POSTGRES.
//
// POR QUE ESTA PROVA EXISTE
// As 16 suítes do front rodam sobre parciais inventadas por mim. Elas provam que o código faz
// o que eu escrevi — não que a LINHA REAL do Rafael, como ela está no banco, acende o botão.
// Todo defeito sério de 10 a 13/08/2026 passou pelos testes com dublê e só apareceu aqui:
// a trava do C.I. que nunca disparava, os 9.221 dias de atraso, o HTTP 500 por ordem de rota.
//
// O QUE ELA FAZ
//   1. lê as PCs do Rafael DIRETO do Postgres  (colunas `date` viram objeto Date)
//   2. lê as MESMAS PCs pela API, por HTTP     (as mesmas colunas viram string ISO)
//   3. roda a agregação e as funções REAIS extraídas do index.html sobre os dois
//   4. confere que os dois caminhos produzem o MESMO botão, e que ele está ATIVO
//
// ⚠️ O passo 3 usa o código do index.html, não uma cópia. Reescrever a agregação aqui daria
//    duas fontes para a mesma resposta — e a do teste passaria enquanto a da tela falhava.
//
// ⚠️ SOMENTE LEITURA. Nenhum INSERT/UPDATE/DELETE, nenhuma transação aberta. O `POST` que
//    encaminha de verdade NÃO é exercitado aqui: seria escrita em produção.
//
// USO: DATABASE_URL=... node prova_banco_ci.js  [nome do analista]  (padrão: Rafael)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Client } = require('pg');

const QUEM = process.argv[2] || 'Rafael';
const API = process.env.API_URL || 'https://sigpc-api-production.up.railway.app';
const INDEX = path.join(__dirname, '..', 'sigpc-gt', 'index.html');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

// ── o código REAL da tela, extraído do index.html ────────────────────────────────
function carregarTela() {
  const html = fs.readFileSync(INDEX, 'utf8');

  const iAgr = html.indexOf('const grupos = {}');
  const fAgr = html.indexOf('// Filtros de parcial: escondem as parciais que nao casam');
  const iAux = html.indexOf('function pPasso(pa) {');
  const fAux = html.indexOf('function renderPlan(rows) {');
  if (iAgr < 0 || fAgr < 0 || iAux < 0 || fAux < 0)
    throw new Error('nao achei a agregacao ou os auxiliares no index.html');

  const ctx = {
    console,
    // as dependências da agregação e das faixas, no comportamento que a tela tem
    planEhFinal: (p) => String(p.tipo || '').trim().toLowerCase() === 'final',
    prazoDias: (d) => d ? Math.round((new Date().setHours(0,0,0,0)
                 - new Date(String(d).slice(0,10) + 'T00:00:00')) / 86400000) : null,
    planData: (d) => d ? new Date(String(d).slice(0,10) + 'T12:00:00').toLocaleDateString('pt-BR') : '—',
    escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
    vcOff: () => '',
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(iAux, fAux), ctx);                     // pPasso, pFaixaPasso, pBotaoCI
  vm.runInContext(`function agrupar(pcs) { ${html.slice(iAgr, fAgr)} return trs }`, ctx);
  return ctx;
}

// ── as duas leituras ─────────────────────────────────────────────────────────────
async function doPostgres(cli, tr) {
  const { rows } = await cli.query(
    `SELECT * FROM prestacoes_contas WHERE tr = $1 ORDER BY codigo_pc`, [tr]);
  return rows;
}

async function doHttp(tr) {
  const r = await fetch(`${API}/prestacoes_contas?tr=${encodeURIComponent(tr)}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'API recusou');
  return j.data || [];
}

(async () => {
  const tela = carregarTela();
  const cli = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await cli.connect();

  console.log(`\n═══ 1. ACHAR UMA PARCIAL REAL DO ${QUEM.toUpperCase()} NO PASSO 2 ═══`);
  // Passo 2 = baixada, com parecer, ainda NÃO encaminhada. É a que não tinha botão.
  const { rows: cand } = await cli.query(
    `SELECT tr, parcial_num, COUNT(*) pcs, MIN(parecer_tipo) parecer, MIN(data_baixa) baixa
       FROM prestacoes_contas
      WHERE analista_nome ILIKE $1 AND baixada AND parecer_tipo IS NOT NULL
        AND NOT enviado_ci AND parcial_num IS NOT NULL
      GROUP BY tr, parcial_num ORDER BY MIN(data_baixa) DESC LIMIT 1`, [QUEM + '%']);

  conf(cand.length === 1, `o ${QUEM} tem parcial no passo 2 para provar`);
  if (!cand.length) { await cli.end(); console.log('\nSem caso para provar.'); process.exit(1); }

  const alvo = cand[0];
  console.log(`        ${alvo.tr} · parcial ${alvo.parcial_num} · ${alvo.pcs} PC(s) · `
            + `${alvo.parecer} · baixada em ${new Date(alvo.baixa).toLocaleDateString('pt-BR')}`);

  console.log('\n═══ 2. AS DUAS LEITURAS TRAZEM A LINHA ═══');
  const [pgRows, htRows] = await Promise.all([doPostgres(cli, alvo.tr), doHttp(alvo.tr)]);
  conf(pgRows.length > 0, `o Postgres devolveu ${pgRows.length} PC(s) da ${alvo.tr}`);
  conf(htRows.length === pgRows.length, 'e a API devolveu a mesma quantidade',
       `banco ${pgRows.length} x api ${htRows.length}`);

  // ⚠️ A DIFERENÇA QUE JÁ CUSTOU CARO: o `pg` devolve `date`/`timestamp` como objeto Date; o
  // HTTP entrega string ISO. `String(d).slice(0,10)` num Date dá "Thu Aug 13" — e isso PASSA
  // em comparação de texto. Por isso a mesma função roda sobre os dois.
  const umPg = pgRows.find(p => String(p.parcial_num) === String(alvo.parcial_num));
  const umHt = htRows.find(p => String(p.parcial_num) === String(alvo.parcial_num));
  conf(umPg.data_baixa instanceof Date, 'do banco, data_baixa vem como objeto Date');
  conf(typeof umHt.data_baixa === 'string', 'da API, data_baixa vem como string ISO');

  console.log('\n═══ 3. A AGREGACAO REAL DA TELA, SOBRE O DADO REAL ═══');
  const achaParcial = (linhas) => {
    const trs = tela.agrupar(linhas);
    const g = trs.find(t => t.tr === alvo.tr);
    return g && g.parciais.find(p => String(p.num) === String(alvo.parcial_num));
  };
  const paPg = achaParcial(pgRows);
  const paHt = achaParcial(htRows);

  conf(!!paPg && !!paHt, `a parcial ${alvo.parcial_num} existe nas duas agregacoes`);
  conf(paPg.baixada === true && paHt.baixada === true, 'ela esta baixada nas duas');
  conf(!!paPg.parecer_tipo && !!paHt.parecer_tipo, 'e tem parecer nas duas');
  conf(paPg.enviado_ci === false, 'e ainda NAO foi ao C.I. — e o caso que nao tinha botao');

  console.log('\n═══ 4. O BOTAO DO C.I. ABRE ATIVO ═══');
  const chave = `'${alvo.tr}','${alvo.parcial_num}'`;
  const btPg = tela.pBotaoCI(paPg, chave);
  const btHt = tela.pBotaoCI(paHt, chave);

  conf(tela.pPasso(paPg) === 2, 'a parcial cai no passo 2');
  conf(btPg !== '', 'O BOTAO EXISTE — antes de 13/08 este ramo nao desenhava botao nenhum');
  conf(!/disabled/.test(btPg), 'E ESTA ATIVO — sem `disabled`');
  conf(btPg.includes(`onclick="pEnviarCI(${chave})"`), 'e chama pEnviarCI com a TR e a parcial reais');
  conf(/opcional — a parcial já está baixada/.test(btPg), 'com "opcional — a parcial ja esta baixada"');
  conf(btPg === btHt, 'o botao e IDENTICO pelos dois caminhos — Date e string dao o mesmo HTML');

  console.log('\n═══ 5. A FAIXA DO PASSO 2, COM A DATA REAL ═══');
  //
  // ⚠️ A FAIXA SE PROVA PELO CAMINHO HTTP, e é ele que vale: o navegador recebe JSON, então
  // toda data chega como STRING. O objeto `Date` do `pg` nunca atravessa a rede.
  //
  // Medido aqui: sobre um `Date` cru, `planData` devolve "Invalid Date" — porque
  // `String(date).slice(0,10)` dá "Thu Aug 13" e `new Date('Thu Aug 13T12:00:00')` não existe.
  // É a armadilha 25 do CLAUDE.md, e a lição é a mesma de sempre: **função de tela nunca é
  // alimentada com linha crua do `pg`.** A asserção abaixo guarda isso de propósito — se um
  // dia alguém fizer o servidor devolver `Date` em vez de string, a faixa some da tela e esta
  // linha é que vai contar.
  const fxHt = tela.pFaixaPasso(paHt);
  const fxPg = tela.pFaixaPasso(paPg);
  const dataBr = new Date(alvo.baixa).toLocaleDateString('pt-BR');

  conf(/Passo 2 de 2/.test(fxHt), 'a faixa diz "Passo 2 de 2"');
  conf(fxHt.includes(`baixada em ${dataBr}`), `com a data real da baixa (${dataBr})`,
       fxHt.replace(/\s+/g, ' ').slice(0, 140));
  conf(fxHt.includes(alvo.parecer), `e o parecer real (${alvo.parecer})`);
  conf(!/Thu|Invalid/.test(fxHt), 'sem "Thu Aug 13" e sem "Invalid Date" — o caminho real esta limpo');

  conf(/Invalid Date/.test(fxPg),
       'e a linha crua do `pg` NAO serve para a tela — prova viva da armadilha 25');
  conf(tela.pBotaoCI(paPg, chave) === tela.pBotaoCI(paHt, chave),
       'ja o BOTAO nao depende de data, e sai igual pelos dois caminhos');

  console.log('\n═══ 6. A ROTA ACEITA A PARCELA BAIXADA — SEM ESCREVER ═══');
  // ⚠️ Não se faz o POST: seria escrita em produção, e escrita é decisão do Richard. O que dá
  // para provar sem gravar é que NENHUMA das duas recusas da rota se aplica a esta parcela.
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const iRota = srv.indexOf("app.post('/parcela/ci'");
  const bRota = srv.slice(iRota, iRota + 1400);
  const recusas = [...bRota.matchAll(/status\((\d{3})\)[\s\S]{0,120}?message: '([^']+)'/g)].map(m => m[2]);
  console.log('        recusas da rota:', recusas.join(' · '));

  conf(/if \(!pcs\.some\(p => p\.parecer_tipo\)\)/.test(bRota), 'a rota exige parecer — e esta tem');
  conf(/if \(pcs\.every\(p => p\.enviado_ci === true\)\)/.test(bRota),
       'e recusa a que ja foi — esta nao foi');
  conf(!/p\.baixada/.test(bRota), 'a rota NAO olha `baixada` — a parcela baixada passa');
  conf(!/SET[\s\S]{0,300}?baixada/.test(bRota), 'e o UPDATE dela NAO toca em `baixada`');

  console.log('\n═══ 7. O QUE ESTA PROVA NAO PROVA ═══');
  console.log('        · o POST de verdade — exigiria gravar em producao');
  console.log('        · o clique na tela — precisa de navegador e de uma pessoa');
  console.log(`        · o retorno do C.I. depois do envio — nao ha caso novo para observar`);

  await cli.end();
  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error('\nERRO:', e.message); process.exit(1); });
