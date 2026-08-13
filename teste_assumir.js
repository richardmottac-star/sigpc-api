// CAMINHO: sigpc-api/teste_assumir.js
//
// ASSUMIR A TR NUMA TRANSAÇÃO — o último lugar do sistema com o padrão "um PATCH por PC".
// Sem rede e sem banco. A seção 3 lê o server.js: transação, ordem e a trava conferida UMA vez.

const fs = require('fs');
const as = require('./lib/assumir');

let ok = 0, falhou = 0;
const conf = (c, n) => { c ? (ok++, console.log('  OK    ' + n)) : (falhou++, console.log('  FALHA  ' + n)); };
const secao = t => console.log('\n═══ ' + t + ' ═══');

// ─────────────────────────────────────────────────────────────
secao('1. O NOME CURTO — armadilha 1 do CLAUDE.md');

// `prestacoes_contas.analista_nome` guarda "Richard", nao "Richard Motta Coelho".
conf(as.nomeCurto('Richard Motta Coelho') === 'Richard', 'o do mapa vira o nome curto');
conf(as.nomeCurto('Zadir Teresinha Machado Ferreira') === 'Zadir', 'idem para a Zadir');
conf(as.nomeCurto('Sandra Paul') === 'Sandra Paul', 'e os de nome composto ficam inteiros');
conf(as.nomeCurto('Ana Leticia') === 'Ana Leticia', 'idem Ana Leticia');
conf(as.nomeCurto('Fulano de Tal Silva') === 'Fulano', 'quem nao esta no mapa entra pelo primeiro nome');
conf(as.nomeCurto('  Richard Motta Coelho  ') === 'Richard', 'espaco em volta nao atrapalha');
conf(as.nomeCurto('') === null && as.nomeCurto(null) === null, 'vazio devolve null');
conf(Object.keys(as.MAPA_NOME).length === 8, 'o mapa tem os 8 nomes que a tela tinha');

secao('2. VALIDACAO');
conf(as.validar({ tr: '2020TR000704', usuario_id: 4 }) === null, 'corpo bom passa');
conf(as.validar(null) !== null, 'corpo vazio recusado');
conf(as.validar({ usuario_id: 4 }) !== null, 'sem tr recusa');
conf(as.validar({ tr: '2020TR000704' }) !== null, 'sem usuario_id recusa');
conf(as.validar({ tr: '   ', usuario_id: 4 }) !== null, 'tr em branco recusa');

// ─────────────────────────────────────────────────────────────
secao('3. AS TRAVAS NO server.js');

const src = fs.readFileSync('./server.js', 'utf8');
const rota = src.slice(src.indexOf("app.post('/tr/assumir'"), src.indexOf("app.post('/tr/assumir'") + 4000);

// ⚠️ O DEFEITO QUE ISTO CORRIGE: 83 PATCHes em serie, sem transacao.
conf(/BEGIN/.test(rota) && /COMMIT/.test(rota) && /ROLLBACK/.test(rota), 'assumir e UMA transacao');
conf(/FOR UPDATE/.test(as.SQL_LIVRES),
     'com FOR UPDATE — dois analistas clicando junto nao leem as mesmas PCs livres');
conf(/codigo_pc = ANY\(\$1\)/.test(as.SQL_ASSUMIR), 'escreve por lista explicita de chaves (regra 12)');
conf(/status = 'livre' AND analista_id IS NULL/.test(as.SQL_LIVRES),
     'so pega o que esta REALMENTE livre');

// ⚠️ A trava de limite era conferida A CADA PATCH — 83 vezes, e podia aceitar meia TR.
conf((rota.match(/podeAssumirTr/g) || []).length === 1, 'a trava de limite e conferida UMA vez');
conf(rota.indexOf('BEGIN') < rota.indexOf('podeAssumirTr'),
     'e DENTRO da transacao — senao outro poderia assumir entre a conferencia e a escrita');
conf(rota.indexOf('podeAssumirTr') < rota.indexOf('SQL_LIVRES'),
     'a trava vem antes de travar as linhas');
conf(/barrouPreparacao/.test(rota), 'preparacao/manutencao barram antes de tudo');
conf(rota.indexOf('barrouPreparacao') < rota.indexOf('BEGIN'), 'e antes de abrir transacao');

// autorizacao de vaga extra so e gasta quando foi ela que liberou
conf(/chk\.autorizacao/.test(rota) && /status = 'usada'/.test(rota),
     'a autorizacao de vaga extra e consumida');
conf(/parcela_historico/.test(rota) && /assumir_tr/.test(rota), 'e o assumir deixa rastro');

// ⚠️ ASSUMIR NAO TOCA NO QUE JA FOI ANALISADO.
['baixada', 'data_baixa', 'enviado_ci', 'parecer_tipo', 'parecer_ci', 'valor', 'ci_situacao', 'ci_rodada']
  .forEach(col => conf(!(new RegExp(`(SET|,)\\s*${col}\\s*=`)).test(as.SQL_ASSUMIR),
                       `o UPDATE nao mexe em ${col}`));

// as duas datas, e a diferenca entre elas
conf(/dt_assumida = NOW\(\)/.test(as.SQL_ASSUMIR) && !/dt_assumida = COALESCE/.test(as.SQL_ASSUMIR),
     'dt_assumida REINICIA a cada assuncao');
conf(/dt_inicio_analise = COALESCE\(dt_inicio_analise, NOW\(\)\)/.test(as.SQL_ASSUMIR),
     'e dt_inicio_analise NAO reinicia — e o relogio do prazo');

// o nome vem do servidor, nao do corpo
conf(/assumir\.nomeCurto\(quem\.nome\)/.test(rota),
     'o analista_nome e montado no SERVIDOR, a partir do usuario_id');
conf(!/campos\.analista_nome/.test(rota), 'e nao vem do corpo do pedido');

// a previa e a gravacao usam a mesma fonte
const previa = src.slice(src.indexOf("app.get('/tr/:tr/assumir'"), src.indexOf("app.get('/tr/:tr/assumir'") + 1600);
conf(/podeAssumirTr/.test(previa), 'a previa responde se pode, pela MESMA regra');
conf(/status = 'livre' AND analista_id IS NULL/.test(previa), 'e conta as livres pelo mesmo criterio');

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
