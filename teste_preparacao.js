// CAMINHO: sigpc-api/teste_preparacao.js
//
// Testes do MODO PREPARAÇÃO (lib/preparacao.js). Sem rede e sem banco.
//
// ⚠️ O QUE ESTES TESTES PROTEGEM
//
//   · superadmin e coordenador NUNCA ficam atrás da cortina — são eles que preparam a
//     reunião, e se caíssem nela não haveria quem desligasse o modo;
//   · perfil desconhecido é RESTRINGIDO, não liberado: esperar a tarde é reversível,
//     mexer no acervo não;
//   · na dúvida o sistema ABRE — tabela ausente ou banco fora devolve desligado, porque
//     trancar 47 pessoas fora por uma oscilação custa mais do que alguém entrar cedo;
//   · o PATCH usa par (informou, valor) e não COALESCE — senão seria impossível DESLIGAR.
//
// USO: node teste_preparacao.js

const P = require('./lib/preparacao');
const fs = require('fs');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

function db(resposta, erro) {
  const ch = [];
  return { ch, query: async (sql, params) => {
    ch.push({ sql: String(sql).replace(/\s+/g,' ').trim(), params });
    if (erro) throw new Error(erro);
    return resposta || { rows: [] };
  }};
}

(async () => {

console.log('\n═══ 1. QUEM FICA ATRAS DA CORTINA ═══');
{
  const on = { modo_preparacao: true };
  conf(P.restringe(on, { perfil: 'analista' }) === true, 'analista e restringido');
  conf(P.restringe(on, { perfil: 'superadmin' }) === false, 'SUPERADMIN NUNCA');
  conf(P.restringe(on, { perfil: 'coordenador' }) === false, 'COORDENADOR NUNCA');
  // Se os dois caíssem na cortina, não haveria quem desligasse o modo pela tela.
  conf(P.restringe(on, { perfil: 'controle_interno' }) === true,
       'perfil fora da lista de isentos e restringido');
  conf(P.restringe(on, { perfil: 'perfil_que_ainda_nao_existe' }) === true,
       'PERFIL DESCONHECIDO E RESTRINGIDO — o lado seguro do engano');
}

console.log('\n═══ 2. DESLIGADO NAO RESTRINGE NINGUEM ═══');
{
  const off = { modo_preparacao: false };
  conf(P.restringe(off, { perfil: 'analista' }) === false, 'analista passa');
  conf(P.restringe(null, { perfil: 'analista' }) === false, 'config nula nao restringe');
  conf(P.restringe(undefined, { perfil: 'analista' }) === false, 'config indefinida idem');
  conf(P.restringe({ modo_preparacao: true }, null) === false, 'sem usuario, nao restringe');
  conf(P.restringe({ modo_preparacao: true }, {}) === false, 'usuario sem perfil, nao restringe');
}

console.log('\n═══ 3. NA DUVIDA, O SISTEMA ABRE ═══');
{
  const semTabela = await P.ler(db(null, 'relation "config_sistema" does not exist'));
  conf(semTabela.modo_preparacao === false, 'tabela ausente → DESLIGADO, e nao erro');
  conf(typeof semTabela.mensagem === 'string' && semTabela.mensagem.length > 0,
       'e ainda assim devolve uma mensagem utilizavel');

  const bancoFora = await P.ler(db(null, 'connection terminated'));
  conf(bancoFora.modo_preparacao === false, 'banco fora → DESLIGADO');

  const semLinha = await P.ler(db({ rows: [] }));
  conf(semLinha.modo_preparacao === false, 'tabela vazia → DESLIGADO');
}

console.log('\n═══ 4. A LEITURA ═══');
{
  const r = await P.ler(db({ rows: [{ modo_preparacao: true, mensagem: 'Volte as 14h',
                                      atualizado_em: '2026-08-12', atualizado_por_nome: 'Richard' }] }));
  conf(r.modo_preparacao === true, 'ligado vem ligado');
  conf(r.mensagem === 'Volte as 14h', 'a mensagem vem como esta gravada');
  conf(r.atualizado_por_nome === 'Richard', 'e quem mexeu tambem');

  // Mensagem em branco não pode virar tela muda.
  const vazia = await P.ler(db({ rows: [{ modo_preparacao: true, mensagem: '   ' }] }));
  conf(vazia.mensagem === P.MENSAGEM_PADRAO, 'mensagem so com espaco cai no texto padrao');
  const nula = await P.ler(db({ rows: [{ modo_preparacao: true, mensagem: null }] }));
  conf(nula.mensagem === P.MENSAGEM_PADRAO, 'mensagem nula idem');
}

console.log('\n═══ 5. O BLOQUEIO DAS ROTAS DE TRABALHO ═══');
{
  // Desligado: ninguém é barrado, e nem se consulta o usuário.
  const d1 = db({ rows: [{ modo_preparacao: false }] });
  conf(await P.bloqueio(d1, 7) === null, 'modo desligado nao barra');
  conf(d1.ch.length === 1, 'e nem chega a perguntar quem e a pessoa', `${d1.ch.length} consultas`);

  // Ligado + analista: barra, com frase que diz o que fazer.
  const d2 = { ch: [], query: async (sql, params) => {
    d2.ch.push({ sql: String(sql), params });
    if (/config_sistema/.test(sql)) return { rows: [{ modo_preparacao: true }] };
    return { rows: [{ perfil: 'analista' }] };
  }};
  const msg = await P.bloqueio(d2, 7);
  conf(typeof msg === 'string', 'analista e barrado');
  conf(/Meu Perfil/.test(msg), 'e a frase diz o que da para fazer agora', msg);

  // Ligado + coordenador: passa.
  const d3 = { query: async (sql) => /config_sistema/.test(sql)
    ? { rows: [{ modo_preparacao: true }] } : { rows: [{ perfil: 'coordenador' }] } };
  conf(await P.bloqueio(d3, 5) === null, 'coordenador passa mesmo com o modo ligado');

  const d4 = { query: async (sql) => /config_sistema/.test(sql)
    ? { rows: [{ modo_preparacao: true }] } : { rows: [{ perfil: 'superadmin' }] } };
  conf(await P.bloqueio(d4, 4) === null, 'superadmin passa');

  // Sem id não dá para saber se é isento: deixa passar, senão a cortina vira pane em rota
  // que não manda id nenhum.
  const d5 = { query: async () => ({ rows: [{ modo_preparacao: true }] }) };
  conf(await P.bloqueio(d5, null) === null, 'sem id de usuario, nao barra');
  conf(await P.bloqueio(d5, undefined) === null, 'id indefinido idem');

  // Usuário que não existe: não barra (não é papel desta função decidir isso).
  const d6 = { query: async (sql) => /config_sistema/.test(sql)
    ? { rows: [{ modo_preparacao: true }] } : { rows: [] } };
  conf(await P.bloqueio(d6, 999) === null, 'usuario inexistente nao e barrado aqui');

  // Erro ao buscar o perfil: falha aberta, como o resto.
  const d7 = { query: async (sql) => {
    if (/config_sistema/.test(sql)) return { rows: [{ modo_preparacao: true }] };
    throw new Error('caiu');
  }};
  conf(await P.bloqueio(d7, 7) === null, 'erro ao ler o perfil nao barra');
}

console.log('\n═══ 6. VALIDACAO DO QUE A TELA MANDA ═══');
{
  conf(P.validar({ modo_preparacao: true }) === null, 'booleano passa');
  conf(P.validar({ modo_preparacao: false }) === null, 'false tambem passa');
  conf(P.validar({ modo_preparacao: 'sim' }) !== null, 'texto no lugar de booleano e recusado');
  conf(P.validar({ modo_preparacao: 1 }) !== null, 'numero idem');
  conf(P.validar({ mensagem: 'x'.repeat(400) }) === null, '400 caracteres passa');
  conf(P.validar({ mensagem: 'x'.repeat(401) }) !== null, '401 e recusado');
  conf(P.validar({ mensagem: null }) === null, 'mensagem nula passa (limpa e cai no padrao)');
  conf(P.validar(null) !== null, 'corpo vazio e recusado');
}

console.log('\n═══ 7. TRAVAS NO server.js ═══');
{
  const src = fs.readFileSync('./server.js', 'utf8');

  // ⚠️ Sem o par (informou, valor), `modo_preparacao = false` seria lido como "não
  // informado" e DESLIGAR pela tela seria impossível. É a mesma armadilha do limite_padrao.
  conf(/modo_preparacao = CASE WHEN \$1::boolean THEN \$2::boolean ELSE modo_preparacao END/.test(src),
       'o PATCH usa par (informou, valor) — da para DESLIGAR');
  conf(!/modo_preparacao\s*=\s*COALESCE/.test(src), 'e nao usa COALESCE, que impediria desligar');

  // Quem liga e desliga é conferido pelo BANCO, não pelo `perfil` do corpo.
  conf(/SELECT id, nome, perfil FROM usuarios WHERE id = \$1[\s\S]{0,300}?quem\.perfil !== 'superadmin'/.test(src),
       'so superadmin altera, conferido pelo banco');

  // As seis portas de trabalho.
  const portas = (src.match(/await barrouPreparacao\(/g) || []).length;
  conf(portas >= 6, 'as rotas de trabalho chamam o bloqueio', `${portas} chamadas`);
  conf(/if \(campos\.analista_id && await barrouPreparacao\(res, campos\.analista_id\)\) return;/.test(src),
       'inclusive o PATCH por onde uma TR muda de dono');

  // O bloqueio tem de vir ANTES da trava de TRs: na manhã ninguém assume, dentro ou fora
  // do limite.
  const iPrep = src.indexOf('MODO PREPARAÇÃO ─');
  const iTrava = src.indexOf('TRAVA DE TRs ─');
  conf(iPrep > 0 && iTrava > 0 && iPrep < iTrava, 'e vem antes da trava de limite');

  // A tabela nasce desligada: criar a tabela não pode trancar a equipe fora.
  conf(/modo_preparacao\s+BOOLEAN\s+NOT NULL DEFAULT false/.test(src),
       'a coluna nasce DESLIGADA');
  conf(/INSERT INTO config_sistema \(id\) VALUES \(1\) ON CONFLICT \(id\) DO NOTHING/.test(src),
       'a linha 1 e garantida, senao o PATCH nao teria o que atualizar');

  conf(/app\.get\('\/config_sistema'/.test(src), 'GET /config_sistema existe');
  conf(/app\.patch\('\/config_sistema'/.test(src), 'PATCH /config_sistema existe');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
})();
