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
conf(as.nomeCurto('Fulano de Tal Silva') === 'Fulano', 'quem nao esta no mapa entra pelo primeiro nome');
conf(as.nomeCurto('  Richard Motta Coelho  ') === 'Richard', 'espaco em volta nao atrapalha');
conf(as.nomeCurto('') === null && as.nomeCurto(null) === null, 'vazio devolve null');
conf(Object.keys(as.MAPA_NOME).length === 10,
     'o mapa tem 10: os 8 que a tela tinha + Goreti e Janaina, medidos em 16/08');

// ⚠️ AS TRES CHAVES QUE NUNCA DISPARAVAM — corrigido em 16/08/2026.
//
// Ate esta data o mapa tinha 'Sandra Rocha', 'Ana Claudia' e 'Ana Leticia' como CHAVE, que e
// o nome CURTO. Nenhum usuario se chama assim, entao a entrada nunca casava e a funcao caia
// no split(' ')[0]. Estes tres testes usam o `usuarios.nome` real, conferido contra o banco.
conf(as.nomeCurto('Sandra Cezária Ronchi Rocha') === 'Sandra Rocha',
     'Sandra Cezaria Ronchi Rocha -> "Sandra Rocha", nao "Sandra"');
conf(as.nomeCurto('Ana Claudia Carvalho Costa') === 'Ana Claudia',
     'Ana Claudia Carvalho Costa -> "Ana Claudia", nao "Ana"');
conf(as.nomeCurto('Ana Letícia Wloch de Oliveira') === 'Ana Leticia',
     'Ana Leticia Wloch de Oliveira -> "Ana Leticia", nao "Ana"');

// ⚠️ E O DEFEITO EM UMA LINHA: as duas Anas nao podem colapsar no mesmo rotulo.
conf(as.nomeCurto('Ana Claudia Carvalho Costa') !== as.nomeCurto('Ana Letícia Wloch de Oliveira'),
     'as duas Anas continuam sendo duas pessoas diferentes');

// ⚠️ AS DUAS QUE NEM ESTAVAM NO MAPA. Nao e so nome composto: a Goreti e chamada pelo
// SEGUNDO nome, e o acervo da Janaina esta sem acento. O primeiro nome do cadastro erraria
// as duas.
conf(as.nomeCurto('Maria Goreti Korb') === 'Goreti',
     'Maria Goreti Korb -> "Goreti" (o segundo nome), nao "Maria"');
conf(as.nomeCurto('Janaína Frederico Dittrich') === 'Janaina',
     'Janaina Frederico Dittrich -> "Janaina" SEM acento, como as 188 PCs do acervo');

// ⚠️ NENHUMA CHAVE PODE SER UM NOME CURTO SOLTO. Uma chave que nao existe em `usuarios.nome`
// nao da erro — so devolve outro nome. Este teste e a trava contra a volta do defeito: toda
// chave tem de ter sobrenome, ou ser um cadastro que realmente e assim tao curto.
const CADASTROS_CURTOS = ['Sandra Paul', 'Grace Oliveira'];   // conferidos no banco em 16/08
Object.keys(as.MAPA_NOME).forEach(k => {
  conf(k.split(' ').length >= 3 || CADASTROS_CURTOS.includes(k),
       `a chave "${k}" e um usuarios.nome, nao um apelido`);
});

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
// ⚠️ A REGRA DE "LIVRE" AGORA MORA NUMA CONSTANTE SO, e o teste prova isso — nao a ordem
// das clausulas. A versao anterior cravava o texto `status = 'livre' AND analista_id IS NULL`
// e reprovou a extracao para `PC_LIVRE_SQL`, que so trocou a ordem. Teste que casa a redacao
// impede refatoracao sem pegar defeito nenhum.
conf(/analista_id IS NULL/.test(as.PC_LIVRE_SQL) && /status = 'livre'/.test(as.PC_LIVRE_SQL),
     'PC_LIVRE_SQL exige as DUAS coisas: sem dono e sem trabalho comecado');
conf(as.SQL_LIVRES.includes(as.PC_LIVRE_SQL),
     'e o SQL_LIVRES usa a constante, nao uma copia da condicao');
// ⚠️ e o `resumo_tr` do server tem de usar A MESMA — foi a divergencia entre os dois que
// deixou 87 PCs em 6 TRs aparecendo como Livre e recusando ao assumir, desde 10/08.
{
  const srv = require('fs').readFileSync('./server.js', 'utf8');
  conf(/COUNT\(\*\) FILTER \(WHERE \$\{assumir\.PC_LIVRE_SQL\}\) AS pcs_livres/.test(srv),
       'o resumo_tr conta pcs_livres com a MESMA constante, nao com condicao propria');
  conf(!/statusDerivado/.test(srv), 'e o servidor nao deriva status por conta propria');
}

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
