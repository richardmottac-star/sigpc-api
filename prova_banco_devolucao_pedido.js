// CAMINHO: sigpc-api/prova_banco_devolucao_pedido.js
//
// O PEDIDO DE DEVOLUÇÃO, PROVADO CONTRA O POSTGRES — sobe o Express de verdade.
//
// ⚠️ SOMENTE LEITURA. Nenhum pedido é criado e nenhuma decisão é tomada: isso é escrita em
// produção, e escrita é decisão do Richard. O que se prova aqui é tudo o que dá para provar
// sem gravar — que é mais do que parece:
//   · as rotas SOBEM e respondem (dublê não roteia — foi assim que uma rota devolveu 500);
//   · os perfis levam 403 pelo perfil lido no BANCO, não pelo corpo do pedido;
//   · a prévia conta certo sobre uma TR REAL, e bate com o SQL feito à mão;
//   · a fila roda com a subconsulta da carga do indicado (é SQL novo, e SQL novo quebra);
//   · a validação recusa o pedido incompleto ANTES de tocar no banco.
//
// O QUE FICA POR PROVAR, e exige autorização para gravar:
//   · criar um pedido e aprová-lo (a transferência do motivo 1 e a devolução ao estoque);
//   · o CHECK sd_indicado_no_motivo_1 e o índice único de um pendente por TR — o dublê não
//     tem CHECK nem UNIQUE, e foi assim que a mesclagem passou nos testes e falhou em 12/08.
//
// USO: DATABASE_URL=... node prova_banco_devolucao_pedido.js

const { Client } = require('pg');

const PORTA = process.env.PORTA_PROVA || '3991';
const API = `http://localhost:${PORTA}`;

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const cli = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await cli.connect();

  console.log('\n═══ 0. QUEM E O QUE EXISTE NO BANCO ═══');
  const { rows: pessoas } = await cli.query(
    `SELECT id, nome, perfil, grupo FROM usuarios
      WHERE perfil IN ('superadmin','coordenador','controle_interno') ORDER BY perfil`);
  const sup  = pessoas.find(p => p.perfil === 'superadmin');
  const coord = pessoas.find(p => p.perfil === 'coordenador');
  const ci   = pessoas.find(p => p.perfil === 'controle_interno');

  // Uma TR real, com dono, sem C.I. aberto e com PC a devolver — o caso em que o botão acende.
  const { rows: [alvo] } = await cli.query(
    `SELECT tr, MIN(analista_id) aid, MIN(analista_nome) anome, COUNT(*) pcs,
            COUNT(*) FILTER (WHERE NOT baixada) voltam,
            COUNT(*) FILTER (WHERE baixada) baixadas
       FROM prestacoes_contas
      WHERE analista_id IS NOT NULL
      GROUP BY tr
     HAVING COUNT(*) FILTER (WHERE ci_situacao IN ('na_fila','com_analista')) = 0
        AND COUNT(*) FILTER (WHERE NOT baixada) > 0
      ORDER BY COUNT(*) FILTER (WHERE baixada) DESC
      LIMIT 1`);
  conf(!!sup && !!coord && !!ci, 'ha superadmin, coordenador e C.I. para provar os perfis');
  conf(!!alvo, 'ha uma TR real com dono e com PC a devolver');
  console.log(`        TR ${alvo.tr} · ${alvo.anome} (id ${alvo.aid}) · ${alvo.pcs} PCs `
            + `· ${alvo.voltam} voltariam · ${alvo.baixadas} baixadas`);

  // Um analista que NÃO é o dono, para provar o 403 de "esta TR não é sua".
  const { rows: [outro] } = await cli.query(
    `SELECT id, nome FROM usuarios WHERE perfil = 'analista' AND id <> $1 AND ativo IS NOT FALSE
      ORDER BY id LIMIT 1`, [alvo.aid]);

  console.log('\n═══ 1. O EXPRESS SOBE E RESPONDE ═══');
  // ⚠️ Dublê não roteia. Em 12/08 uma rota de nome fixo declarada depois de `/:id` devolveu
  // HTTP 500 em produção e nenhum teste com dublê pegou.
  process.env.PORT = PORTA;
  require('./server.js');
  let subiu = false;
  for (let i = 0; i < 80; i++) {          // o boot roda as migrações; não se cronometra
    try { await fetch(`${API}/config_sistema`); subiu = true; break } catch (_) { await esperar(500) }
  }
  conf(subiu, `o servidor respondeu na porta ${PORTA}`);
  if (!subiu) { await cli.end(); process.exit(1) }

  const get = async (url) => { const r = await fetch(API + url); return { s: r.status, j: await r.json() } };

  console.log('\n═══ 2. A PREVIA DO ANALISTA, SOBRE A TR REAL ═══');
  const p1 = await get(`/tr/${encodeURIComponent(alvo.tr)}/pedido_devolucao?usuario_id=${alvo.aid}`);
  conf(p1.s === 200, 'o dono recebe a previa', `HTTP ${p1.s}`);
  const d = p1.j.data || {};
  conf((d.motivos || []).length === 6, 'com os seis motivos');
  conf(d.motivos?.[0]?.exigeIndicado === true, 'e o primeiro marcado como "exige indicado"');
  conf(d.aviso?.voltam === Number(alvo.voltam),
       `o aviso diz ${d.aviso?.voltam} e o SQL diz ${alvo.voltam}`);
  conf(d.aviso?.ficam_baixadas === Number(alvo.baixadas),
       `e ${d.aviso?.ficam_baixadas} baixadas ficam, como o SQL`);
  conf(/permanece/.test(d.aviso?.texto_baixadas || '') || /Nenhuma/.test(d.aviso?.texto_baixadas || ''),
       'com o texto que responde "perco o que ja baixei?"');
  conf(!/parcialis/.test(JSON.stringify(d.aviso || {})), 'e sem o plural errado "parcialis"');
  conf(d.pode === true, 'e o pedido pode ser feito nesta TR');

  console.log('\n═══ 3. OS PERFIS — A GUARDA E DO SERVIDOR ═══');
  const p2 = await get(`/tr/${encodeURIComponent(alvo.tr)}/pedido_devolucao?usuario_id=${outro.id}`);
  conf(p2.s === 403, `analista que nao e o dono leva 403 (${outro.nome})`, `HTTP ${p2.s}`);
  const p3 = await get(`/tr/${encodeURIComponent(alvo.tr)}/pedido_devolucao?usuario_id=999999`);
  conf(p3.s === 403, 'id inexistente leva 403', `HTTP ${p3.s}`);
  const p4 = await get(`/tr/NAOEXISTE/pedido_devolucao?usuario_id=${sup.id}`);
  conf(p4.s === 404, 'TR inexistente leva 404', `HTTP ${p4.s}`);

  console.log('\n═══ 4. A FILA — O RECORTE VEM DO PERFIL NO BANCO ═══');
  const f1 = await get(`/solicitacao_devolucao?usuario_id=${sup.id}`);
  conf(f1.s === 200, 'superadmin le a fila', `HTTP ${f1.s}`);
  const f2 = await get(`/solicitacao_devolucao?usuario_id=${coord.id}`);
  conf(f2.s === 200, `coordenador le a fila do grupo dele (${coord.nome})`, `HTTP ${f2.s}`);
  const f3 = await get(`/solicitacao_devolucao?usuario_id=${ci.id}`);
  conf(f3.s === 403, 'o Controle Interno NAO le a fila', `HTTP ${f3.s}`);
  const f4 = await get(`/solicitacao_devolucao?usuario_id=${outro.id}`);
  conf(f4.s === 200 && Array.isArray(f4.j.data), 'analista le — e o servidor recorta para os dele');
  const f5 = await get(`/solicitacao_devolucao?usuario_id=999999`);
  conf(f5.s === 403, 'id inexistente leva 403 tambem na fila', `HTTP ${f5.s}`);

  // ⚠️ SQL NOVO QUEBRA. A subconsulta da carga do indicado só existe desde hoje: se ela
  // estiver errada, é aqui que aparece — e não na tela do coordenador.
  conf(f1.j.error === null, 'a consulta da fila roda sem erro de SQL', JSON.stringify(f1.j.error));

  console.log('\n═══ 5. O QUE A VALIDACAO RECUSA ANTES DE TOCAR NO BANCO ═══');
  const post = async (corpo) => {
    const r = await fetch(`${API}/solicitacao_devolucao`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    return { s: r.status, j: await r.json() };
  };
  const base = { tr: alvo.tr, analista_id: alvo.aid };
  const r1 = await post({ ...base, motivo: 'impedimento' });
  conf(r1.s === 400 && /justificativa/i.test(r1.j.error?.message || ''), 'sem justificativa: 400');
  const r2 = await post({ ...base, motivo: 'inventado', justificativa: 'texto suficiente aqui' });
  conf(r2.s === 400 && /Motivo inválido/.test(r2.j.error?.message || ''), 'motivo fora da lista: 400');
  const r3 = await post({ ...base, motivo: 'analise_anterior', justificativa: 'texto suficiente aqui' });
  conf(r3.s === 400 && /quem já analisava/i.test(r3.j.error?.message || ''),
       'motivo 1 sem o indicado: 400');
  const r4 = await post({ tr: alvo.tr, motivo: 'outro', justificativa: 'texto suficiente aqui' });
  conf(r4.s === 400, 'sem analista_id: 400');

  console.log('\n═══ 6. A TABELA ESTA VAZIA — NADA FOI GRAVADO ═══');
  const { rows: [n] } = await cli.query(`SELECT COUNT(*)::int n FROM solicitacao_devolucao`);
  conf(n.n === 0, `solicitacao_devolucao continua com ${n.n} linhas`);

  console.log('\n═══ 7. O QUE ESTA PROVA NAO PROVA ═══');
  console.log('        · criar um pedido e aprova-lo — exige gravar em producao');
  console.log('        · a transferencia do motivo 1 e a devolucao ao estoque');
  console.log('        · o CHECK do indicado e o indice de um pendente por TR');
  console.log('        · o sino chegando ao analista e ao indicado');

  await cli.end();
  console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error('\nERRO:', e.message); process.exit(1) });
