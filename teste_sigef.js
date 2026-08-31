// CAMINHO: sigpc-api/teste_sigef.js
//
// A CONFERÊNCIA COM O SIGEF — a regra mora em `lib/sigef.js`, e é ela que se testa.
//
// USO: node teste_sigef.js
//
// ⚠️ SEM BANCO. A prova contra o Postgres — a de que o SQL e o JS classificam as 14.658 linhas
// igual — está na conferência 10 de `migracao_sigef_declaracao_20260827.js`, e é lá que ela
// tem de ficar: dublê não roteia, não tem tipo e não tem 14 mil linhas.

const fs = require('fs');
const s = require('./lib/sigef');

let ok = 0, falhou = 0;
const conf = (x, r, d) => { x ? ok++ : falhou++; console.log(`  ${x ? 'OK  ' : 'FALHA'}  ${r}${x || !d ? '' : `   [${d}]`}`); };
const secao = (t) => console.log(`\n=== ${t} ===`);

// As quatro formas de PC que importam. Datas ANTES do corte, salvo onde dito.
const VERMELHA = { codigo_pc: 'A', tipo: 'parcial', baixada: true, sigef_status: null, data_baixa: '2026-06-30' };
const AZUL     = { codigo_pc: 'B', tipo: 'final',   baixada: true, sigef_status: null, data_baixa: '2026-06-30' };
const AMBAR    = { codigo_pc: 'C', tipo: 'parcial', baixada: false, sigef_status: 'Baixa Regular', data_baixa: null };
const OK_PC    = { codigo_pc: 'D', tipo: 'parcial', baixada: true, sigef_status: 'Baixa Regular', data_baixa: '2026-06-30' };

secao('1. AS TRES SITUACOES');
{
  conf(s.classificar(VERMELHA) === s.TAGS.SEM_REGISTRO_SIGEF, 'baixada aqui e sem status do SIGEF -> vermelha');
  conf(s.classificar(AZUL) === s.TAGS.VERIFICAR_FINAL, 'final baixada e sem status -> azul');
  conf(s.classificar(AMBAR) === s.TAGS.ABERTA_COM_BAIXA_SIGEF, 'status do SIGEF e aberta aqui -> ambar');
  conf(s.classificar(OK_PC) === null, 'baixada dos dois lados nao ganha tag nenhuma');
  conf(s.classificar(null) === null, 'e nada nao classifica nada');

  // ⚠️ A tag e do TIPO certo: uma parcial nunca vira azul, uma final nunca vira vermelha.
  conf(s.classificar({ ...VERMELHA, tipo: 'final' }) === s.TAGS.VERIFICAR_FINAL,
       'a mesma linha, tipo final, vira azul — o tipo e que separa as duas');
}

secao('2. O CORTE DA EXTRACAO — 01/08/2026');
{
  // ⚠️ Baixada em agosto nao e classificada: o extrato da CGE vai ate 31/07 e nao PODIA
  // conhece-la. Sao 321 parciais e 40 finais, e acusa-las mandaria conferir o que esta certo.
  conf(s.classificar({ ...VERMELHA, data_baixa: '2026-08-01' }) === null, 'baixada em 01/08 NAO e classificada');
  conf(s.classificar({ ...VERMELHA, data_baixa: '2026-08-25' }) === null, 'nem em 25/08');
  conf(s.classificar({ ...VERMELHA, data_baixa: '2026-07-31' }) === s.TAGS.SEM_REGISTRO_SIGEF, 'e em 31/07 ainda e');
  // O corte vale para as TRES — foi o que faltava na primeira especificacao (324 x 284).
  conf(s.classificar({ ...AZUL, data_baixa: '2026-08-13' }) === null, 'a final de agosto tambem fica de fora');
  conf(s.classificar({ ...VERMELHA, data_baixa: null }) === null, 'sem data_baixa nao da para saber de que lado esta');

  // ⚠️ ARMADILHA 25: o `pg` devolve `date`/`timestamp` como objeto Date, e
  // String(d).slice(0,10) daria "Thu Jul 30" — que e MAIOR que "2026-08-01" como texto.
  const comoDate = { ...VERMELHA, data_baixa: new Date(2026, 5, 30) };   // 30/06/2026 local
  conf(s.classificar(comoDate) === s.TAGS.SEM_REGISTRO_SIGEF, 'um objeto Date e lido como data, nao como "Tue Jun 30"');
  const dateAgosto = { ...VERMELHA, data_baixa: new Date(2026, 7, 25) }; // 25/08/2026 local
  conf(s.classificar(dateAgosto) === null, 'e um Date de agosto cai fora, como deve');
  conf(s.paraIso(new Date(2026, 2, 31)) === '2026-03-31', 'paraIso devolve ISO de verdade');
}

secao('3. O CINZA — declarada, aguardando a proxima extracao');
{
  const decl = [{ resposta: 'ja_estava', data_registro: '2026-08-20' }];
  conf(s.classificar({ ...VERMELHA, sigef_declaracao: decl }) === s.TAGS.REGISTRO_DECLARADO, 'vermelha declarada vira cinza');
  conf(s.classificar({ ...AZUL, sigef_declaracao: decl }) === s.TAGS.REGISTRO_DECLARADO, 'azul declarada vira cinza');

  // ⚠️ O CINZA NAO COBRE O AMBAR. La o pendente e o parecer NESTE sistema, e nada que o
  // analista declare sobre o SIGEF resolve — os proprios textos dizem isso.
  conf(s.classificar({ ...AMBAR, sigef_declaracao: decl }) === s.TAGS.REGISTRO_DECLARADO,
       'ambar declarada vira cinza — as tres declaram desde 30/08/2026');

  // Array vazio nao e declaracao.
  conf(s.classificar({ ...VERMELHA, sigef_declaracao: [] }) === s.TAGS.SEM_REGISTRO_SIGEF, 'array vazio nao conta');
  conf(s.classificar({ ...VERMELHA, sigef_declaracao: null }) === s.TAGS.SEM_REGISTRO_SIGEF, 'nulo tambem nao');
  // E uma PC sem pendencia nao vira cinza so por ter declaracao.
  conf(s.classificar({ ...OK_PC, sigef_declaracao: decl }) === null, 'PC sem pendencia nao ganha cinza');
}

secao('3-B. A PRODUTIVIDADE CONCILIADA COM O SIGEF');
{
  const decl = [{ resposta: 'ja_estava', data_registro: '2026-08-20' }];
  const baixadaOk = { ...OK_PC };                                  // baixada, sem tag
  const soCi = { codigo_pc: 'E', tipo: 'parcial', baixada: false, enviado_ci: true, sigef_status: null, data_baixa: null };

  // A base nao mudou: PC distinta com baixada OU enviado_ci.
  conf(s.baseProdutividade(baixadaOk) === true, 'baixada entra na base');
  conf(s.baseProdutividade(soCi) === true, 'enviada ao C.I. sem baixa TAMBEM entra na base');
  conf(s.baseProdutividade({ baixada: false, enviado_ci: false }) === false, 'nem baixada nem no C.I. fica fora');

  // ⚠️ O DESCONTO: as duas pendencias saem enquanto nao houver declaracao.
  conf(s.contaProdutividade(VERMELHA) === false, 'a vermelha NAO conta');
  conf(s.contaProdutividade(AZUL) === false, 'a azul NAO conta');
  conf(s.descontadaPeloSigef(VERMELHA) === true, 'e a vermelha aparece como descontada');
  conf(s.descontadaPeloSigef(AZUL) === true, 'a azul tambem');

  // ⚠️ DECLAROU, VOLTA NA HORA — nao espera a proxima extracao.
  conf(s.contaProdutividade({ ...VERMELHA, sigef_declaracao: decl }) === true,
       'declarada, a vermelha volta a contar IMEDIATAMENTE');
  conf(s.contaProdutividade({ ...AZUL, sigef_declaracao: decl }) === true, 'a azul tambem');
  conf(s.descontadaPeloSigef({ ...VERMELHA, sigef_declaracao: decl }) === false,
       'e deixa de ser descontada');

  // ⚠️ A AMBAR NAO E TOCADA por esta regra: ela ja nao contava, porque nao esta baixada.
  conf(s.baseProdutividade(AMBAR) === false, 'a ambar nao esta na base — nao esta baixada');
  conf(s.contaProdutividade(AMBAR) === false, 'entao nao conta');
  conf(s.descontadaPeloSigef(AMBAR) === false, 'e NAO e "descontada" — nunca esteve na conta');
  // Se o analista registrar o parecer aqui, ela entra pelo caminho normal.
  conf(s.contaProdutividade({ ...AMBAR, baixada: true }) === true,
       'confirmado o parecer, a ambar entra pelo caminho de sempre');

  // Nada muda para quem nao tem tag.
  conf(s.contaProdutividade(baixadaOk) === true, 'PC sem tag continua contando');
  conf(s.contaProdutividade(soCi) === true, 'e a que so foi ao C.I. tambem');

  // ⚠️ A LISTA DE DESCONTO TEM DUAS TAGS, e so duas. Um dia alguem vai querer por a ambar
  // aqui "para ficar completo" — e ai a PC seria descontada de uma conta em que nunca entrou.
  conf(s.TAGS_QUE_DESCONTAM.length === 2, 'sao DUAS tags que descontam');
  conf(!s.TAGS_QUE_DESCONTAM.includes(s.TAGS.ABERTA_COM_BAIXA_SIGEF), 'e a ambar NAO e uma delas');
  conf(!s.TAGS_QUE_DESCONTAM.includes(s.TAGS.REGISTRO_DECLARADO), 'nem a declarada');
}

secao('3-C. O SQL DA PRODUTIVIDADE');
{
  // ⚠️ O COALESCE E O QUE IMPEDE O DESASTRE: a tag e NULL em 13.620 das 14.658 linhas, e
  // `NULL NOT IN (...)` e NULL — que num FILTER nao passa. Sem ele, a produtividade dessas
  // PCs zeraria em silencio.
  conf(/COALESCE\(/.test(s.SQL_CONTA_PRODUTIVIDADE), 'a conta protege a tag NULL com COALESCE');
  conf(/NOT IN/.test(s.SQL_CONTA_PRODUTIVIDADE), 'e exclui as tags que descontam');
  // ⚠️ A CONFERENCIA E SOBRE A LISTA DO `NOT IN`, e nao sobre o SQL inteiro: `SQL_TAG` esta
  // embutido aqui dentro e cita as QUATRO tags, inclusive a ambar. Procurar o nome dela no
  // texto todo acusaria a propria expressao que classifica — e foi o que este teste fez na
  // primeira versao. E a mesma familia do md5 que precisou excluir a coluna nova.
  const listaNotIn = (s.SQL_CONTA_PRODUTIVIDADE.match(/NOT IN \(([^)]*)\)/) || [, ''])[1];
  for (const t of s.TAGS_QUE_DESCONTAM) conf(listaNotIn.includes(t), `a tag ${t} sai da conta`);
  conf(!listaNotIn.includes(s.TAGS.ABERTA_COM_BAIXA_SIGEF), 'a ambar NAO esta na lista de desconto');
  conf(!listaNotIn.includes(s.TAGS.REGISTRO_DECLARADO), 'nem a declarada');
  conf(/baixada = true OR p\.enviado_ci = true/.test(s.SQL_BASE_PRODUTIVIDADE),
       'a base e baixada OU enviado_ci — a regra do projeto, intacta');
  conf(s.SQL_CONTA_PRODUTIVIDADE.includes(s.SQL_BASE_PRODUTIVIDADE.trim()),
       'e a conta e construida SOBRE a base, nao reescrita ao lado');
}

secao('3-D. A CONTA "ATE UMA DATA" — as DUAS pernas da regra');
{
  const b = s.sqlBaseAte('$1');
  // ⚠️ CADA PERNA COM A PROPRIA DATA. Cortar as duas por `data_baixa` deixa de fora, de
  // forma estrutural, a PC que conta SO por ter ido ao C.I.: ela tem `dt_envio_ci`, nao
  // `data_baixa`. Era metade da regra escrita, e a rota dizia implementa-la inteira.
  conf(/data_baixa <= \$1/.test(b), 'a perna da baixa corta por data_baixa');
  conf(/enviado_ci = true and p\.dt_envio_ci <= \$1/i.test(b), 'a perna do C.I. corta por dt_envio_ci');
  conf(/ OR /i.test(b), 'e as duas sao ligadas por OR — a regra escrita');
  conf(!/dt_envio_ci <= \$1[\s\S]*data_baixa <= \$1[\s\S]*dt_envio_ci/.test(b), 'sem perna repetida');

  // ⚠️ A PERNA DA BAIXA NAO PODE GANHAR `baixada = true`. A rota e CUMULATIVA: quem responde
  // "o que valia naquela data" e `data_baixa <= corte` junto com o filtro de estorno.
  // `data_baixa` e preservada depois do estorno justamente para isso (lib/correcao.js) —
  // exigir `baixada = true` faria a PC estornada HOJE sumir de um relatorio de ONTEM.
  conf(!/baixada = true AND p\.data_baixa/.test(b), 'a perna da baixa NAO exige baixada = true');

  // O parametro e respeitado: trocar o placeholder troca em todas as ocorrencias.
  const b2 = s.sqlBaseAte('$7');
  conf(!/\$1/.test(b2) && (b2.match(/\$7/g) || []).length === 2, 'o placeholder e parametrizavel');

  // A conta e a descontada se constroem SOBRE a base — nao sao reescritas ao lado.
  conf(s.sqlContaAte('$1').includes(b), 'a conta ate-a-data usa a mesma base');
  conf(s.sqlDescontadaAte('$1').includes(b), 'a descontada tambem');
  conf(/COALESCE\(/.test(s.sqlContaAte('$1')), 'e protege a tag NULL com COALESCE');
}

secao('4. QUEM PODE DECLARAR');
{
  const pc = { ...VERMELHA, analista_id: 51 };
  const dono = { id: 51, nome: 'Janaina' };
  const outro = { id: 22, nome: 'Ana' };
  const rich = { id: 4, nome: 'Richard' };

  conf(s.podeDeclarar(dono, pc, 'analista') === true, 'o analista responsavel declara');
  conf(s.podeDeclarar(outro, pc, 'analista') === false, 'outro analista NAO declara na PC alheia');
  conf(s.podeDeclarar(rich, pc, 'superadmin') === true, 'o superadmin declara em qualquer uma');
  // ⚠️ O perfil vem do EFETIVO: no papel de analista o superadmin e analista em toda parte,
  // e aqui isso quer dizer que ele so declara nas PCs dele.
  conf(s.podeDeclarar(rich, pc, 'analista') === false, 'no papel analista, o superadmin nao declara na PC de outro');
  conf(s.podeDeclarar(rich, { ...pc, analista_id: 4 }, 'analista') === true, 'mas declara na propria');
  conf(s.podeDeclarar(dono, { ...pc, analista_id: null }, 'analista') === false, 'PC sem dono nao tem responsavel');
  conf(s.podeDeclarar(null, pc, 'analista') === false, 'ninguem nao declara');
  conf(s.podeDeclarar(dono, { ...pc, analista_id: '51' }, 'analista') === true, 'id como texto tambem casa');
}

secao('4B. BAIXA ANTERIOR AO GT, E NL COM RESIDUAL (30/08/2026)');
{
  const base = { baixada: true, tipo: 'parcial', sigef_status: 'SV', data_baixa: '2026-06-30' };
  // A data e a data_baixa_sigef, NUNCA a data_baixa: esta ultima e 30/06/2026 em 3.604 PCs
  // (o dia da carga) e classificaria o acervo inteiro pelo dia da importacao.
  conf(s.INICIO_GT === '2025-08-12', 'o GT comecou em 12/08/2025 — Portaria FCEE no 227');
  conf(s.ehPreGt({ ...base, data_baixa_sigef: '2025-08-11' }) === true, '11/08/2025 e anterior ao GT');
  conf(s.ehPreGt({ ...base, data_baixa_sigef: '2025-08-12' }) === false, 'o proprio 12/08/2025 NAO e anterior');
  conf(s.ehPreGt({ ...base, data_baixa_sigef: null }) === false, 'sem data_baixa_sigef NAO classifica — nao inventa');
  conf(s.ehPreGt({ ...base, baixada: false, data_baixa_sigef: '2020-01-01' }) === false, 'e so vale para PC baixada');

  // A pre-GT SAI da produtividade; a residual NAO. Sao coisas diferentes.
  conf(s.contaProdutividade({ ...base, data_baixa_sigef: '2025-01-10' }) === false,
       'a baixa anterior ao GT nao conta produtividade');
  conf(s.contaProdutividade({ ...base, data_baixa_sigef: '2026-01-10' }) === true,
       'a baixa posterior conta normal');
  conf(s.SQL_CONTA_PRODUTIVIDADE.includes('data_baixa_sigef'),
       'e o SQL da produtividade exclui a pre-GT tambem');
  conf(s.sqlContaAte('$1').includes('data_baixa_sigef'),
       'a conta ate-a-data exclui igual — senao o relatorio diverge do card');

  // A RESIDUAL E SO PILULA. Descontar tiraria 1.289 PCs da contagem, e nao e a regra.
  conf(!s.SQL_CONTA_PRODUTIVIDADE.includes('q.codigo_nl'),
       'a NL com residual NAO entra na conta de produtividade');
  conf(/EXISTS/.test(s.SQL_NL_RESIDUAL) && !/ROW_NUMBER/.test(s.SQL_NL_RESIDUAL),
       'a residual e EXISTS, nao janela — janela nao entra em WHERE nem em FILTER');
  conf(s.SQL_NL_RESIDUAL.includes('::int') && s.SQL_NL_RESIDUAL.includes('parcial_num'),
       'e a ordem compara a parcela como NUMERO, senao 10 vem antes de 2');
}

secao('5. ONDE A DECLARACAO VALE');
{
  conf(s.aceitaDeclaracao(VERMELHA) === true, 'a vermelha aceita');
  conf(s.aceitaDeclaracao(AZUL) === true, 'a azul aceita');
  conf(s.aceitaDeclaracao(AMBAR) === true, 'a ambar TAMBEM aceita, desde 30/08/2026');
  conf(s.aceitaDeclaracao(OK_PC) === false, 'a que esta certa nao tem o que declarar');
  // ⚠️ A REDECLARACAO E PERMITIDA: "se o analista errar, ele declara de novo".
  conf(s.aceitaDeclaracao({ ...VERMELHA, sigef_declaracao: [{ resposta: 'ja_estava' }] }) === true,
       'ja declarada aceita DE NOVO — o erro tem de ter conserto');
}

secao('6. A VALIDACAO DO QUE O ANALISTA MANDA');
{
  conf(s.validarDeclaracao({ resposta: 'ja_estava', data_registro: '2026-08-20' }) === null, 'as duas respostas validas passam');
  conf(s.validarDeclaracao({ resposta: 'registrei_agora', data_registro: '2026-08-20' }) === null, 'a segunda tambem');
  conf(!!s.validarDeclaracao({ resposta: 'inventada', data_registro: '2026-08-20' }), 'resposta fora da lista e recusada');
  conf(!!s.validarDeclaracao({ resposta: null, data_registro: '2026-08-20' }), 'sem resposta e recusada');
  conf(!!s.validarDeclaracao({ resposta: 'ja_estava', data_registro: null }), 'sem data e recusada');
  conf(!!s.validarDeclaracao({ resposta: 'ja_estava', data_registro: '20/08/2026' }), 'data em formato brasileiro e recusada');
  // ⚠️ 31 de fevereiro nao existe, e `new Date('2026-02-31')` nao reclama — vira 03/03.
  conf(!!s.validarDeclaracao({ resposta: 'ja_estava', data_registro: '2026-02-31' }), '31 de fevereiro e recusado');
  conf(!!s.validarDeclaracao({ resposta: 'ja_estava', data_registro: '2026-13-01' }), 'mes 13 e recusado');
  // ⚠️ E o prototipo nao e resposta valida: `RESPOSTAS['constructor']` existe em JS.
  conf(!!s.validarDeclaracao({ resposta: 'constructor', data_registro: '2026-08-20' }), 'constructor NAO e uma resposta');
  conf(!!s.validarDeclaracao({ resposta: 'toString', data_registro: '2026-08-20' }), 'toString tambem nao');
}

secao('7. O QUE FICA GRAVADO');
{
  const d = s.montarDeclaracao({
    resposta: 'registrei_agora', data_registro: '2026-08-20',
    quem: { id: 51, nome: 'Janaina Frederico Dittrich' }, agora: new Date('2026-08-27T13:00:00Z'),
  });
  conf(d.resposta === 'registrei_agora', 'o codigo da resposta');
  // ⚠️ O ROTULO VAI JUNTO: e o que a pessoa leu ao clicar, e e o que responde a CGE meses
  // depois se o texto do botao mudar. So o codigo repetiria o erro do `registrado_por`.
  conf(d.resposta_rotulo === 'Não estava; registrei agora', 'e o rotulo que ela leu na tela');
  conf(d.data_registro === '2026-08-20', 'a data informada');
  conf(d.declarado_por === 51 && d.declarado_por_nome === 'Janaina Frederico Dittrich', 'quem declarou');
  conf(d.declarado_em === '2026-08-27T13:00:00.000Z', 'e quando');
  conf(Object.keys(s.RESPOSTAS).length === 3, 'sao tres respostas, e so tres');
  conf(/análise/.test(s.RESPOSTAS.nao_baixada),
       'a terceira diz que o SIGEF nao baixou — em analise, diligencia ou outra');
}

secao('7-B. A DECLARACAO E POR PARCELA — e a tag entra na chave');
{
  // Uma parcela com PCs em situacoes diferentes: 2 vermelhas, 1 azul (a final), 1 sem tag.
  const parcela = [
    { codigo_pc: '2021PC002125', analista_id: 51, sigef_tag: s.TAGS.SEM_REGISTRO_SIGEF },
    { codigo_pc: '2021PC002126', analista_id: 51, sigef_tag: s.TAGS.SEM_REGISTRO_SIGEF },
    { codigo_pc: '2021TR000559-PFINAL', analista_id: 51, sigef_tag: s.TAGS.VERIFICAR_FINAL },
    { codigo_pc: '2021PC002127', analista_id: 51, sigef_tag: null },
  ];

  const v = s.alvoDaDeclaracao(parcela, s.TAGS.SEM_REGISTRO_SIGEF);
  conf(v.codigos.length === 2, 'a vermelha alcanca as 2 PCs vermelhas', String(v.codigos.length));
  conf(v.codigos.join(',') === '2021PC002125,2021PC002126', 'e sao exatamente essas duas');
  // ⚠️ A FINAL NAO ENTRA. Declarar sobre ela o que foi dito das parciais seria afirmar em
  // nome do analista algo que ele nao afirmou — e e a prestacao final, que a CGE olha.
  conf(v.fora.length === 2, 'as outras 2 ficam de fora', String(v.fora.length));
  conf(!v.codigos.includes('2021TR000559-PFINAL'), 'a PC FINAL nao e alcancada pela tag vermelha');

  const a = s.alvoDaDeclaracao(parcela, s.TAGS.VERIFICAR_FINAL);
  conf(a.codigos.length === 1 && a.codigos[0] === '2021TR000559-PFINAL',
       'e a azul alcanca so a final');

  // A PC sem tag nunca e alcancada por nada.
  conf(!s.alvoDaDeclaracao(parcela, s.TAGS.SEM_REGISTRO_SIGEF).codigos.includes('2021PC002127')
    && !s.alvoDaDeclaracao(parcela, s.TAGS.VERIFICAR_FINAL).codigos.includes('2021PC002127'),
       'a PC sem tag nao entra em declaracao nenhuma');
  conf(s.alvoDaDeclaracao([], s.TAGS.SEM_REGISTRO_SIGEF).codigos.length === 0, 'parcela vazia nao alcanca nada');

  // ── quem pode, na PARCELA ───────────────────────────────────────────────────
  const dono = { id: 51 }, outro = { id: 22 }, rich = { id: 4 };
  conf(s.podeDeclararParcela(dono, v.alcanca, 'analista') === true, 'o dono declara na parcela dele');
  conf(s.podeDeclararParcela(outro, v.alcanca, 'analista') === false, 'outro analista nao');
  conf(s.podeDeclararParcela(rich, v.alcanca, 'superadmin') === true, 'o superadmin declara em qualquer uma');
  // ⚠️ DONO MISTO: tem de poder em TODAS, e nao em uma. Bastar uma deixaria alguem gravar no
  // acervo de outro numa parcela que ficou com dois donos.
  const misto = [{ codigo_pc: 'A', analista_id: 51 }, { codigo_pc: 'B', analista_id: 22 }];
  conf(s.podeDeclararParcela(dono, misto, 'analista') === false,
       'parcela de dono MISTO recusa quem e dono de so uma das PCs');
  conf(s.podeDeclararParcela(rich, misto, 'superadmin') === true, 'o superadmin passa mesmo no misto');
  conf(s.podeDeclararParcela(dono, [], 'analista') === false, 'sem PC alcancada, ninguem declara');
}

secao('8. O SQL — o que ele NAO pode conter');
{
  // ⚠️ Declarar nao baixa, nao estorna e nao move produtividade. Se um destes nomes voltar ao
  // SET, este teste falha antes de a rota ir para producao.
  const set = s.SQL_DECLARAR.slice(s.SQL_DECLARAR.indexOf('SET'), s.SQL_DECLARAR.indexOf('WHERE'));
  for (const proibido of ['baixada', 'enviado_ci', 'data_baixa', 'parecer_tipo', 'sigef_status', 'status']) {
    conf(!new RegExp(`\\b${proibido}\\b`).test(set), `o SET nao menciona ${proibido}`);
  }
  conf(/sigef_declaracao/.test(set) && /sigef_registro_em/.test(set), 'o SET toca as duas colunas certas');
  // ⚠️ APENDA, nunca substitui: e o `||` que faz "a declaracao nao se desmarca".
  conf(/\|\|\s*\$2::jsonb/.test(set), 'e o jsonb e APENDADO, nunca substituido');
  conf(/COALESCE\(sigef_declaracao, '\[\]'::jsonb\)/.test(set), 'com COALESCE para a primeira declaracao');
  // ⚠️ LISTA EXPLICITA DE CHAVES, e nao condicao derivada de tr/parcial/tag — armadilha 12.
  // A condicao seria reavaliada no UPDATE e poderia casar linha que a conferencia nunca viu.
  conf(/WHERE codigo_pc = ANY\(\$1\)/.test(s.SQL_DECLARAR), 'a escrita vai por LISTA de codigo_pc');
  conf(!/\btr\b|\bparcial_num\b|\bsetorial_id\b/.test(s.SQL_DECLARAR),
       'e o UPDATE nao repete a chave da parcela — quem escolheu as PCs foi o SELECT FOR UPDATE');

  // O SELECT que escolhe as PCs da parcela.
  const sel = s.SQL_PCS_DA_PARCELA_NA_TAG;
  conf(/setorial_id = \$1[\s\S]*tr = \$2[\s\S]*parcial_num = \$3/.test(sel),
       'o SELECT entra por (setorial_id, tr, parcial_num), como carregarParcela');
  conf(/FOR UPDATE/.test(sel), 'e trava as linhas — FOR UPDATE');
  // ⚠️ A TAG E RECALCULADA NO BANCO. Se ela viesse do corpo, o cliente escolheria em quais
  // linhas escrever: bastaria mandar outra tag para alcancar PC que a tela nunca ofereceu.
  conf(/AS sigef_tag/.test(sel), 'e a tag e CALCULADA no SELECT, nao recebida do corpo');
}

secao('9. O SQL DA TAG');
{
  // ⚠️ O `jsonb_array_length` explode se o valor nao for array. A coluna e nova; uma linha
  // gravada a mao como objeto derrubaria o SELECT de TODAS as telas de uma vez.
  conf(/jsonb_typeof/.test(s.TEM_DECLARACAO), 'a leitura do jsonb confere o tipo antes de medir o tamanho');
  conf(new RegExp(s.CORTE_EXTRACAO).test(s.PENDENCIA_SQL), 'o corte da extracao esta no SQL');
  conf((s.PENDENCIA_SQL.match(new RegExp(s.CORTE_EXTRACAO, 'g')) || []).length === 2,
       'e nas DUAS situacoes que dependem de data');
  conf(!/CURRENT_DATE/.test(s.PENDENCIA_SQL), 'nenhum CURRENT_DATE cru — o corte e data fixa, nao "hoje"');
  for (const t of Object.values(s.TAGS)) conf(s.SQL_TAG.includes(t), `a tag ${t} sai do SQL`);
}

secao('10. A LIB E O SERVER');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  conf(/require\('\.\/lib\/sigef'\)/.test(src), 'o server usa a lib');
  conf(/sigef\.SQL_TAG/.test(src), 'e a tag sai da expressao da lib, nao de um CASE copiado');
  // ⚠️ A regra nao pode estar escrita duas vezes no server.
  conf(!/SEM_REGISTRO_SIGEF'/.test(src.replace(/sigef\.TAGS\.\w+/g, '')),
       'o server nao repete o nome das tags em texto solto');
  conf(/sigef\.podeDeclararParcela/.test(src), 'a guarda de quem declara vem da lib');

  // ⚠️ A ROTA ANTIGA, POR `codigo_pc`, SAIU — e nao ficou comentada. Ela nasceu de manha e
  // durou um dia; deixa-la viva seria um segundo caminho de escrita na mesma coluna, sem a
  // conferencia de tag. Rota morta nao incomoda ninguem ate o dia em que alguem a religa.
  conf(!/prestacoes_contas\/:codigo_pc\/sigef_declaracao/.test(src),
       'a rota por codigo_pc nao existe mais');
  conf(/app\.post\('\/parcela\/sigef_declaracao'/.test(src), 'e a rota e POST /parcela/sigef_declaracao');

  const iRota = src.indexOf("app.post('/parcela/sigef_declaracao'");
  const bloco = iRota < 0 ? '' : src.slice(iRota, iRota + 4200);
  // ⚠️ A rota usa o perfil EFETIVO, e nao `u.perfil`: no papel de analista o superadmin e
  // analista em toda parte, e aqui isso limita as PCs dele.
  conf(/papel\.perfilEfetivo/.test(bloco), 'a rota resolve o perfil pelo papel efetivo');
  conf(/faltaChave/.test(bloco), 'e exige a chave da parcela, como as outras rotas de parcela');
  // ⚠️ UMA transacao para a parcela inteira — armadilha 24: tirado o laco de requisicoes, a
  // conferencia passa a ser UMA, antes de escrever.
  conf(/BEGIN[\s\S]*SQL_PCS_DA_PARCELA_NA_TAG[\s\S]*SQL_DECLARAR[\s\S]*COMMIT/.test(bloco),
       'a parcela inteira vai numa transacao so');
  conf(/gravou\.length !== codigos\.length[\s\S]{0,200}ROLLBACK/.test(bloco),
       'e confere DEPOIS de escrever, com ROLLBACK se nao bater');
  conf(!/req\.body[\s\S]{0,40}perfil/.test(bloco), 'a rota nao le o perfil do corpo');
  conf(/TAGS_QUE_DECLARAM\.includes\(b\.tag\)/.test(bloco), 'so as duas tags que declaram passam');

  // ⚠️ A PRODUTIVIDADE SAI DA LIB EM TODA PARTE. Se uma rota reescrever a conta, ela vai
  // divergir das outras no primeiro ajuste — foi exatamente o que aconteceu com a tela, que
  // contava `status = 'baixada'` enquanto a regra escrita dizia `baixada OU enviado_ci`.
  conf(/sigef\.SQL_CONTA_PRODUTIVIDADE/.test(src), 'o server usa a conta da lib');
  // ⚠️ SÃO DUAS FORMAS DA MESMA CONTA: a do estado de hoje (`SQL_CONTA_PRODUTIVIDADE`) e a
  // cumulativa até uma data (`sqlContaAte`). O que este teste guarda é que NENHUMA rota
  // escreva a conta à mão — por isso conta as duas juntas, e não uma só.
  const usos = (src.match(/sigef\.(SQL_CONTA_PRODUTIVIDADE|sqlContaAte)/g) || []).length;
  conf(usos >= 3, 'a conta da lib aparece em pelo menos tres pontos', String(usos));
  conf(!/COUNT\(\*\) FILTER \(WHERE \(p\.baixada = true OR p\.enviado_ci = true\)/.test(src),
       'e nenhuma rota reescreve a base a mao');
  conf(/sigef\.SQL_DESCONTADA/.test(src), 'e devolve tambem quantas o SIGEF esta segurando');
  // A rota de produtividade nao pode ter voltado a contar `COUNT(*)` cru.
  const iProd = src.indexOf("app.get('/prestacoes_contas/produtividade'");
  const bProd = iProd < 0 ? '' : src.slice(iProd, iProd + 2000);
  conf(!/SELECT COUNT\(\*\) FROM prestacoes_contas/.test(bProd),
       'a rota de produtividade nao conta linha crua');
  conf(/AS total_bruto/.test(bProd), 'e devolve o bruto ao lado do conciliado');
  // ⚠️ AS DUAS PERNAS, e pela lib. Um `data_baixa <= $1` solto no WHERE seria a volta do
  // defeito: ele corta a perna do C.I. antes de o FILTER poder ve-la.
  conf(/sigef\.sqlContaAte\('\$1'\)/.test(bProd), 'a rota usa a conta ate-a-data da lib');
  conf(!/conditions = \[[^\]]*data_baixa <= \$1/.test(bProd),
       'e o WHERE nao corta mais por data_baixa — isso e do FILTER agora');
  conf(/estornada = false OR p\.data_estorno > \$1/.test(bProd),
       'o recorte de estorno continua no WHERE, e continua sendo "o que valia na data"');
}

console.log(`\n=== RESULTADO: ${ok} passaram · ${falhou} falharam ===\n`);
process.exit(falhou ? 1 : 0);
