// CAMINHO: sigpc-api/teste_devolucao.js
//
// DEVOLVER A TR AO ESTOQUE — a regra e as travas.
//
// Sem rede e sem banco. ⚠️ A seção 5 lê o próprio server.js: as travas que importam aqui
// são de TRANSAÇÃO, ORDEM e PRESENÇA, e o dublê não alcança nenhuma delas.

const fs = require('fs');
const devol = require('./lib/devolucao');

let ok = 0, falhou = 0;
function conf(cond, nome) {
  if (cond) { ok++; console.log('  OK    ' + nome); }
  else      { falhou++; console.log('  FALHA  ' + nome); }
}
function secao(t) { console.log('\n═══ ' + t + ' ═══'); }

const pc = (o) => ({ codigo_pc: o.c, baixada: !!o.b, ci_situacao: o.ci ?? null,
                     analista_id: o.aid ?? 36, analista_nome: o.an ?? 'Claudia' });

// ─────────────────────────────────────────────────────────────
secao('1. O RESUMO — o que volta, o que fica');

{
  const r = devol.resumir([
    pc({ c: 'A', b: true }), pc({ c: 'B', b: true }),
    pc({ c: 'C' }), pc({ c: 'D' }), pc({ c: 'E' }),
  ]);
  conf(r.total === 5,        'conta o total');
  conf(r.baixadas === 2,     'conta as baixadas');
  conf(r.devolver === 3,     'devolve so as nao baixadas');
  conf(r.no_ci === 0,        'nenhuma no C.I.');
  conf(r.codigos.join() === 'C,D,E', 'a lista traz so as que voltam');
  conf(!r.codigos.includes('A') && !r.codigos.includes('B'),
       'PC BAIXADA NAO ENTRA NA LISTA — a produtividade e conquistada, nao volta');
  conf(r.analista_id === 36 && r.analista_nome === 'Claudia', 'identifica o dono');
}

{
  const r = devol.resumir([pc({ c: 'A', b: true }), pc({ c: 'B', b: true })]);
  conf(r.devolver === 0 && r.codigos.length === 0, 'TR toda baixada: nada a devolver');
}

conf(devol.resumir([]).total === 0, 'TR vazia nao quebra');

// ─────────────────────────────────────────────────────────────
secao('2. O CONTROLE INTERNO BLOQUEIA (opcao B, decisao do Richard)');

{
  const r = devol.resumir([
    pc({ c: 'A', b: true }),
    pc({ c: 'B' }), pc({ c: 'C' }),
    pc({ c: 'D', ci: 'na_fila' }), pc({ c: 'E', ci: 'com_analista' }),
  ]);
  conf(r.no_ci === 2, 'conta as que estao no ciclo do C.I.');
  conf(r.devolver === 2, 'e tira as do C.I. da conta do que volta');
  conf(!r.codigos.includes('D') && !r.codigos.includes('E'), 'elas nao entram na lista');
  const imp = devol.impedimento(r);
  conf(!!imp, 'e a TR fica IMPEDIDA de ser devolvida');
  conf(/Controle Interno/.test(imp), 'a razao cita o Controle Interno');
}

// ⚠️ O CASO REAL, E O QUE QUASE PASSOU BATIDO.
//
// Medido contra o banco em 12/08: as 13 PCs no ciclo do C.I. sao TODAS baixada = true.
// E' a regra de negocio — encaminhar ao C.I. ja conta como baixa. A primeira versao do
// `resumir` procurava C.I. so entre as NAO baixadas: a trava existia e NUNCA disparava.
// So apareceu rodando a rota contra o Postgres. O duble validou a forma, nao a realidade.
{
  const r = devol.resumir([
    pc({ c: 'A', b: true, ci: 'na_fila' }),    // <- como sao as 13 de verdade
    pc({ c: 'B' }), pc({ c: 'C' }),
  ]);
  conf(r.no_ci === 1, 'C.I. EM PC BAIXADA TAMBEM CONTA — e o caso real, nao a excecao');
  conf(!!devol.impedimento(r), 'e bloqueia a TR: a conversa com o C.I. esta aberta');
  conf(r.devolver === 2, 'a baixada nao voltaria de qualquer forma — o que muda e o bloqueio');
}

// ⚠️ 'encerrado' NAO bloqueia: o C.I. ja decidiu, a PC foi para o historico e nao espera
// mais nada. Bloquear por ela travaria toda TR que um dia passou pelo C.I. — o normal.
{
  const r = devol.resumir([pc({ c: 'A' }), pc({ c: 'B', ci: 'encerrado' })]);
  conf(r.no_ci === 0, 'C.I. ENCERRADO nao conta como pendente');
  conf(r.devolver === 2, 'e a PC volta normalmente');
  conf(devol.impedimento(r) === null, 'a TR pode ser devolvida');
}

conf(devol.CI_ABERTO.join() === 'na_fila,com_analista', 'so estas duas situacoes bloqueiam');

// ─────────────────────────────────────────────────────────────
secao('3. IMPEDIMENTOS');

{
  const so = devol.resumir([pc({ c: 'A', b: true }), pc({ c: 'B', b: true })]);
  const m = devol.impedimento(so);
  conf(!!m && /já foram baixadas/.test(m), 'TR toda baixada explica o porque');
  conf(devol.impedimento(devol.resumir([])) !== null, 'TR vazia tambem impede');
  conf(devol.impedimento(devol.resumir([pc({ c: 'A' })])) === null, 'TR com 1 PC livre passa');
}

// ─────────────────────────────────────────────────────────────
secao('4. VALIDACAO — o motivo e OBRIGATORIO');

const base = { tr: '2020TR000704', usuario_id: 1 };
conf(devol.validar(null) !== null, 'corpo vazio recusado');
conf(devol.validar({ ...base }) !== null, 'sem motivo, recusa');
conf(devol.validar({ ...base, motivo: '' }) !== null, 'motivo em branco, recusa');
conf(devol.validar({ ...base, motivo: 'Qualquer coisa' }) !== null, 'motivo fora da lista, recusa');
conf(devol.validar({ ...base, motivo: 'Redistribuição de carga' }) === null, 'motivo da lista, passa');
conf(devol.validar({ motivo: 'Redistribuição de carga', usuario_id: 1 }) !== null, 'sem tr, recusa');
conf(devol.validar({ motivo: 'Redistribuição de carga', tr: 'X' }) !== null, 'sem usuario_id, recusa');

// 'Outro' sem explicacao gravaria um registro que nao explica nada
conf(devol.validar({ ...base, motivo: 'Outro' }) !== null, 'Outro sem descricao, recusa');
conf(devol.validar({ ...base, motivo: 'Outro', detalhe: 'curto' }) !== null, 'Outro com menos de 10 chars, recusa');
conf(devol.validar({ ...base, motivo: 'Outro', detalhe: 'x'.repeat(200) }) === null, 'Outro com 200 chars, passa');
conf(devol.validar({ ...base, motivo: 'Outro', detalhe: 'x'.repeat(201) }) !== null, 'Outro com 201 chars, recusa');
conf(devol.validar({ ...base, motivo: 'Outro', detalhe: 'Licença médica a partir de 15/08.' }) === null,
     'Outro com descricao de verdade, passa');

conf(devol.motivoTexto({ motivo: 'Redistribuição de carga' }) === 'Redistribuição de carga',
     'o texto do historico e o motivo');
conf(devol.motivoTexto({ motivo: 'Outro', detalhe: 'Licença médica' }) === 'Outro: Licença médica',
     'e em Outro leva a descricao junto — senao o registro nao explica nada');

// ─────────────────────────────────────────────────────────────
secao('5. TRAVAS NO server.js — o que o duble nao alcanca');

const src = fs.readFileSync('./server.js', 'utf8');
const rota = src.slice(src.indexOf("app.post('/tr/devolver'"),
                       src.indexOf("app.post('/tr/devolver'") + 4200);

// ⚠️ O DEFEITO N.1 DO QUE EXISTIA: 83 PATCHes em serie, sem transacao. Devolver pela
// metade e pior que nao devolver.
conf(/BEGIN/.test(rota) && /COMMIT/.test(rota) && /ROLLBACK/.test(rota),
     'a devolucao e UMA transacao');
conf(/FOR UPDATE/.test(src.slice(src.indexOf('async function lerTrParaDevolucao'),
                                 src.indexOf('async function lerTrParaDevolucao') + 700)),
     'com FOR UPDATE — duas devolucoes simultaneas nao leem o mesmo estado');
conf(/codigo_pc = ANY\(\$1\)/.test(devol.SQL_DEVOLVER),
     'e escreve por LISTA EXPLICITA de chaves (regra 12), nao por condicao derivada');

// ⚠️ O DEFEITO N.2: a guarda morava no index.html, contornavel pelo DevTools.
conf(/async function ehSuperadmin/.test(src), 'ha conferencia de superadmin no servidor');
conf(/SELECT id, nome, perfil FROM usuarios WHERE id = \$1/.test(
       src.slice(src.indexOf('async function ehSuperadmin'), src.indexOf('async function ehSuperadmin') + 400)),
     'e o perfil vem do BANCO, pelo id — nao do corpo do pedido');
conf(/ehSuperadmin/.test(rota), 'a rota de gravar confere');
conf(/ehSuperadmin/.test(src.slice(src.indexOf("app.get('/tr/:tr/devolucao'"),
                                   src.indexOf("app.get('/tr/:tr/devolucao'") + 900)),
     'e a previa tambem — coordenador nem ve os numeros');

// ⚠️ O DEFEITO N.3: nao deixava rastro.
conf(/parcela_historico/.test(rota) && /devolucao_tr/.test(rota),
     'registra em parcela_historico com evento proprio');
conf(/notif\.criar/.test(rota), 'e avisa o analista pelo sino');
// ⚠️ ref_id com a TR faria a SEGUNDA devolucao da mesma TR ser engolida pelo dedupe —
// a mesma armadilha do num_diligencia, que o ciclo do C.I. resolveu com a rodada.
conf(/ref_id: `devtr-\$\{hist\[0\]\.id\}`/.test(rota),
     'o ref_id e o id do historico, nao a TR — senao a 2a devolucao nao avisaria ninguem');

// A conferencia do C.I. tem de ser refeita DENTRO da transacao: entre abrir o modal e
// clicar, uma PC pode ter ido para o Controle Interno.
conf(rota.indexOf('BEGIN') < rota.indexOf('devol.impedimento'),
     'o impedimento e reconferido DENTRO da transacao');
conf(/409/.test(rota), 'e responde 409 quando impede');

// ⚠️ A BAIXA NUNCA E TOCADA. Mesma trava que o ciclo do C.I. tem.
const proibidas = ['baixada', 'data_baixa', 'enviado_ci', 'parecer_tipo', 'parecer_ci',
                   'ci_situacao', 'ci_rodada', 'valor'];
proibidas.forEach(col => {
  const re = new RegExp(`(SET|,)\\s*${col}\\s*=`);
  conf(!re.test(devol.SQL_DEVOLVER), `o UPDATE nao mexe em ${col}`);
});
conf(/status = 'livre'/.test(devol.SQL_DEVOLVER), 'o UPDATE devolve o status para livre');
conf(/analista_id = NULL/.test(devol.SQL_DEVOLVER), 'e tira o dono');
conf(/dt_assumida = NULL/.test(devol.SQL_DEVOLVER),
     'e limpa dt_assumida — a TR deixou de ter dono, ninguem a assumiu');
conf(!/dt_inicio_analise/.test(devol.SQL_DEVOLVER),
     'mas NAO zera dt_inicio_analise — o relogio da analise ja correu');

// ─────────────────────────────────────────────────────────────
secao('6. dt_assumida — o oposto de dt_inicio_analise, de proposito');

const patch = src.slice(src.indexOf("app.patch('/prestacoes_contas/:codigo_pc'"),
                        src.indexOf("app.patch('/prestacoes_contas/:codigo_pc'") + 6000);
conf(/dt_assumida = NOW\(\)/.test(patch), 'o assumir carimba dt_assumida');
conf(!/dt_assumida = COALESCE/.test(patch),
     'SEM COALESCE — ela reinicia a cada assuncao, senao mostraria a data do analista anterior');
conf(/dt_inicio_analise = COALESCE\(dt_inicio_analise, NOW\(\)\)/.test(patch),
     'e dt_inicio_analise CONTINUA com COALESCE — sao perguntas diferentes');
conf(/campos\.analista_id && campos\.status === 'analise'/.test(patch),
     'so carimba na forma do "assumir" (analista + status analise)');

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
