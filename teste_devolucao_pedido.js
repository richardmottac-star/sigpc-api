// CAMINHO: sigpc-api/teste_devolucao_pedido.js
//
// O PEDIDO DE DEVOLUÇÃO — o analista pede, o coordenador decide.
// Sem banco e sem rede: dublê onde couber, e as travas que só o banco garante estão
// anotadas como tal (o dublê não tem UNIQUE nem CHECK — foi assim que a mesclagem passou
// nos testes e falhou em produção, em 12/08).
//
// USO: node teste_devolucao_pedido.js

const dp = require('./lib/devolucao-pedido');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};
const secao = (t) => console.log(`\n═══ ${t} ═══`);

const pc = (o) => ({ codigo_pc: 'X', baixada: false, ci_situacao: null, analista_id: 7,
                     analista_nome: 'Rafael', ...o });

secao('1. OS SEIS MOTIVOS, NA ORDEM PEDIDA');
{
  const esperado = ['analise_anterior', 'impedimento', 'falta_documentacao',
                    'afastamento', 'redistribuicao', 'outro'];
  conf(dp.MOTIVOS.length === 6, 'sao seis motivos', `sao ${dp.MOTIVOS.length}`);
  conf(dp.IDS.join(',') === esperado.join(','), 'e na ordem em que aparecem na tela');
  conf(/antes de 01\/08\/2026/.test(dp.MOTIVOS[0].rotulo), 'o 1 fala da analise anterior ao sistema');
  conf(dp.MOTIVOS[0].subtexto === 'trabalho iniciado na planilha, antes do sistema',
       'com o subtexto que explica o que isso quer dizer');
  conf(dp.MOTIVOS[0].exigeIndicado === true, 'e so ele exige "quem ja analisava"');
  conf(dp.MOTIVOS.filter(m => m.exigeIndicado).length === 1, 'nenhum outro exige');

  // ⚠️ O banco guarda o ID. O rotulo do motivo 1 tem uma DATA, e rotulo com data e reescrito.
  conf(dp.IDS.every(id => /^[a-z_]+$/.test(id)), 'os ids sao codigos estaveis, sem data nem acento');
}

secao('2. A JUSTIFICATIVA E OBRIGATORIA EM TODOS');
{
  const base = { tr: '2020TR000612', analista_id: 7, motivo: 'impedimento' };
  conf(dp.validarPedido({ ...base, justificativa: 'motivo bem explicado aqui' }) === null,
       'com justificativa, passa');
  conf(/justificativa/i.test(dp.validarPedido({ ...base, justificativa: '' }) || ''),
       'sem justificativa, recusa');
  conf(/justificativa/i.test(dp.validarPedido({ ...base, justificativa: '   ' }) || ''),
       'so espaco tambem e vazio');
  conf(dp.validarPedido({ ...base, justificativa: 'curto' }) !== null,
       'e curta demais tambem recusa');

  // Vale para os SEIS, nao so para "outro" — e a diferenca em relacao a devolucao do
  // superadmin, onde so "Outro" exige descricao.
  const todos = dp.IDS.map(m =>
    dp.validarPedido({ tr: 'T', analista_id: 1, motivo: m, justificativa: '',
                       indicado_nome: 'Fulano' }));
  conf(todos.every(e => e !== null), 'os SEIS motivos exigem justificativa');
}

secao('3. NO MOTIVO 1, "QUEM JA ANALISAVA" E OBRIGATORIO');
{
  const base = { tr: 'T', analista_id: 7, motivo: 'analise_anterior',
                 justificativa: 'estava com a Marisa desde junho' };
  // ⚠️ Sem o indicado a TR volta ao estoque para QUALQUER UM pegar, quando deveria ir para
  // quem ja estava com ela. E o unico caso em que a devolucao tem destino.
  conf(dp.validarPedido(base) !== null, 'sem indicado, recusa');
  conf(/quem já analisava/i.test(dp.validarPedido(base) || ''), 'e a mensagem diz o que falta');
  conf(dp.validarPedido({ ...base, indicado_id: 12 }) === null, 'com o id do cadastro, passa');
  conf(dp.validarPedido({ ...base, indicado_nome: 'Caroline' }) === null,
       'e o nome livre tambem — ha analista com meta e sem cadastro (Caroline)');
  conf(dp.validarPedido({ ...base, indicado_nome: '   ' }) !== null, 'nome so com espaco nao vale');

  // Nos outros cinco, indicado nao e exigido.
  conf(dp.validarPedido({ tr: 'T', analista_id: 7, motivo: 'afastamento',
                          justificativa: 'ferias de 30 dias a partir de segunda' }) === null,
       'nos outros motivos o indicado nao e exigido');
}

secao('4. QUEM DECIDE: COORDENADOR DO GRUPO OU SUPERADMIN');
{
  conf(dp.podeDecidir({ perfil: 'superadmin' }, '3') === true, 'superadmin decide qualquer um');
  conf(dp.podeDecidir({ perfil: 'superadmin' }, null) === true, 'inclusive sem grupo');
  conf(dp.podeDecidir({ perfil: 'coordenador', grupo: '3' }, '3') === true,
       'coordenador decide o do SEU grupo');
  // ⚠️ Coordenador de outro grupo tiraria TR de equipe que nao e dele.
  conf(dp.podeDecidir({ perfil: 'coordenador', grupo: '2' }, '3') === false,
       'coordenador de OUTRO grupo nao decide');
  conf(dp.podeDecidir({ perfil: 'coordenador', grupo: '' }, '') === false,
       'coordenador sem grupo nao decide ninguem — nem os sem grupo');
  conf(dp.podeDecidir({ perfil: 'analista', grupo: '3' }, '3') === false, 'analista nao decide');
  conf(dp.podeDecidir({ perfil: 'controle_interno' }, '3') === false, 'o C.I. tambem nao');
  conf(dp.podeDecidir(null, '3') === false, 'e ninguem nao decide nada');
  // Numero e texto sao o mesmo grupo: o grupo vem como int do banco e como string do corpo.
  conf(dp.podeDecidir({ perfil: 'coordenador', grupo: 3 }, '3') === true,
       'grupo 3 e "3" sao o mesmo grupo');
}

secao('5. A DECISAO EXIGE MOTIVO ESCRITO — NAS DUAS');
{
  conf(dp.validarDecisao({ status: 'aprovada', motivo_decisao: 'de acordo com a coordenacao' }) === null,
       'aprovada com motivo, passa');
  conf(dp.validarDecisao({ status: 'negada', motivo_decisao: 'a TR ja esta em analise ha 2 meses' }) === null,
       'negada com motivo, passa');
  // ⚠️ O analista recebe este texto no sino. Decisao sem motivo e a TR sumindo sem explicacao.
  conf(dp.validarDecisao({ status: 'aprovada' }) !== null, 'aprovada SEM motivo, recusa');
  conf(dp.validarDecisao({ status: 'negada', motivo_decisao: '' }) !== null, 'negada SEM motivo, recusa');
  conf(dp.validarDecisao({ status: 'aprovada', motivo_decisao: 'ok' }) !== null, 'motivo curto demais recusa');
  conf(dp.validarDecisao({ status: 'cancelada', motivo_decisao: 'qualquer coisa' }) !== null,
       'so aprovada ou negada — cancelar e outro caminho');
}

secao('6. O AVISO ANTES DE ENVIAR');
{
  const pcs = [pc({ codigo_pc: 'A', baixada: true }), pc({ codigo_pc: 'B', baixada: true }),
               pc({ codigo_pc: 'C' }), pc({ codigo_pc: 'D' })];
  const a = dp.avisoPedido(pcs);
  conf(a.total === 4 && a.voltam === 2 && a.ficam_baixadas === 2, 'conta o que volta e o que fica');
  conf(/2 parciais baixadas permanecem no seu nome/.test(a.texto_baixadas),
       'e diz que as baixadas permanecem no nome dele');
  conf(/produtividade não é afetada/.test(a.texto_baixadas), 'com a garantia da produtividade');
  conf(a.texto_ci === null, 'sem C.I., nao inventa aviso');

  const umaSo = dp.avisoPedido([pc({ baixada: true }), pc({})]);
  conf(/1 parcial baixada permanece/.test(umaSo.texto_baixadas), 'no singular quando e uma so');

  const nenhuma = dp.avisoPedido([pc({}), pc({})]);
  conf(/Nenhuma parcial baixada/.test(nenhuma.texto_baixadas), 'e diz quando nao ha baixada nenhuma');

  const comCi = dp.avisoPedido([pc({ baixada: true, ci_situacao: 'na_fila' }), pc({})]);
  conf(/BLOQUEIA/.test(comCi.texto_ci || ''), 'com C.I., avisa que bloqueia');
  conf(comCi.no_ci === 1, 'e conta quantas');

  // ⚠️ O plural de "parcial" e "parciaIS". A primeira versao escrevia "2 parcialis" na tela.
  const plural = dp.avisoPedido([pc({ baixada: true, ci_situacao: 'na_fila' }),
                                 pc({ baixada: true, ci_situacao: 'na_fila' }), pc({})]);
  conf(!/parcialis/.test(plural.texto_baixadas + plural.texto_ci), 'e nunca escreve "parcialis"');
  conf(/2 parciais no Controle Interno BLOQUEIAM/.test(plural.texto_ci), 'o verbo tambem vai ao plural');
}

secao('7. O C.I. BLOQUEIA O PEDIDO — E E A MESMA TRAVA DA DEVOLUCAO DIRETA');
{
  // ⚠️ Contado sobre a TR INTEIRA, inclusive nas baixadas. As 13 PCs que estao no C.I. sao
  // TODAS baixadas: procurar so entre as nao baixadas foi o defeito de 13/08, em que a trava
  // existia e NUNCA disparava. So apareceu contra o banco.
  const comCi = [pc({ codigo_pc: 'A', baixada: true, ci_situacao: 'na_fila' }), pc({ codigo_pc: 'B' })];
  const r1 = dp.impedimentoPedido(comCi);
  conf(r1.impedimento !== null, 'PC baixada no C.I. BLOQUEIA o pedido');
  conf(/Controle Interno/.test(r1.impedimento), 'e o texto diz por que');

  const comAnalista = [pc({ codigo_pc: 'A', ci_situacao: 'com_analista' }), pc({ codigo_pc: 'B' })];
  conf(dp.impedimentoPedido(comAnalista).impedimento !== null, "'com_analista' tambem bloqueia");

  // 'encerrado' NAO bloqueia: o C.I. ja decidiu e nao espera mais nada. Bloquear por ela
  // travaria toda TR que um dia passou pelo Controle Interno.
  const encerrado = [pc({ codigo_pc: 'A', baixada: true, ci_situacao: 'encerrado' }), pc({ codigo_pc: 'B' })];
  conf(dp.impedimentoPedido(encerrado).impedimento === null, "'encerrado' NAO bloqueia");

  const todasBaixadas = [pc({ baixada: true }), pc({ baixada: true })];
  conf(/Nada a devolver/.test(dp.impedimentoPedido(todasBaixadas).impedimento || ''),
       'TR toda baixada nao tem o que devolver — sao 334 delas hoje');
}

secao('7b. PARA ONDE A TR VAI NA APROVACAO');
{
  // ⚠️ O MOTIVO 1 NAO PASSA PELO ESTOQUE — decisao do Richard, 13/08. Mandar ao estoque uma
  // TR que tem destino conhecido a entrega a quem chegar primeiro, que e o problema que o
  // proprio motivo 1 descreve.
  conf(dp.destinoAprovacao('analise_anterior') === 'indicado', 'motivo 1 vai DIRETO para o indicado');
  ['impedimento', 'falta_documentacao', 'afastamento', 'redistribuicao', 'outro'].forEach(m => {
    conf(dp.destinoAprovacao(m) === 'estoque', `'${m}' vai ao estoque`);
  });
  conf(dp.destinoAprovacao(undefined) === 'estoque', 'motivo desconhecido cai no estoque, nao trava');

  const ped = { motivo: 'analise_anterior', analista_id: 7, indicado_nome: 'Marisa' };
  const ativa = { id: 31, nome: 'Marisa Goncalves', ativo: true };

  conf(dp.impedimentoIndicado(ped, ativa) === null, 'indicado com cadastro ativo recebe');
  // ⚠️ O LIMITE NAO E CONFERIDO: 29 dos 44 ja estao em 6 ou acima, e a trava de 10/08 vale no
  // ATO DE ASSUMIR — aqui a TR esta VOLTANDO para quem ja a analisava. Quem olha a carga e o
  // coordenador, no cartao.
  conf(dp.impedimentoIndicado({ ...ped, indicado_ocupadas: 54 }, ativa) === null,
       'e recebe mesmo com 54 TRs — o limite nao barra a transferencia');

  // ⚠️ SEM CADASTRO ATIVO, BLOQUEIA. A alternativa seria mandar ao estoque em silencio, que
  // e o defeito que o motivo 1 corrige.
  conf(dp.impedimentoIndicado(ped, null) !== null, 'sem cadastro, BLOQUEIA a aprovacao');
  conf(/não tem cadastro/.test(dp.impedimentoIndicado(ped, null)), 'e diz que falta cadastro');
  conf(/não pode ir ao estoque/.test(dp.impedimentoIndicado(ped, null)),
       'dizendo por que nao cai no estoque');
  conf(/INATIVO/.test(dp.impedimentoIndicado(ped, { ...ativa, ativo: false }) || ''),
       'cadastro inativo tambem bloqueia');
  conf(dp.impedimentoIndicado({ ...ped, analista_id: 31 }, ativa) !== null,
       'indicar a si mesmo bloqueia — nao ha para quem transferir');

  // Nos outros motivos o indicado nem e olhado.
  conf(dp.impedimentoIndicado({ motivo: 'afastamento' }, null) === null,
       'nos outros motivos o indicado nao e exigido nem conferido');
}

secao('8. A BAIXA NUNCA E TOCADA');
{
  // ⚠️ Quem devolve na aprovacao e a `devolucao.js`, e o SQL dela nao menciona a baixa.
  // Este teste existe la tambem; aqui ele guarda o caminho NOVO, que e o do pedido.
  const sql = require('./lib/devolucao').SQL_DEVOLVER;
  ['baixada', 'data_baixa', 'enviado_ci', 'parecer_tipo', 'ci_situacao', 'ci_rodada'].forEach(col => {
    conf(!new RegExp(`\\b${col}\\b`).test(sql), `o UPDATE da aprovacao nao menciona '${col}'`);
  });
  // ⚠️ E o pedido nao pode tocar em analista_id: e isso que mantem a TR contando no limite
  // enquanto esta pendente. Se o pendente ja liberasse a vaga, qualquer um abriria vaga so
  // pedindo devolucao.
  conf(!/analista_id\s*=/.test(dp.SQL_CRIAR), 'e o INSERT do pedido nao mexe em analista_id');
  conf(!/UPDATE|DELETE/i.test(dp.SQL_CRIAR), 'o pedido so INSERE — nao altera nada');

  // ⚠️ A transferencia do motivo 1 usa a MESMA escrita do "assumir": dt_assumida = NOW() para
  // o novo dono e dt_inicio_analise PRESERVADO por COALESCE — o relogio do prazo nao reinicia
  // so porque a TR trocou de mao.
  const sqlAss = require('./lib/assumir').SQL_ASSUMIR;
  conf(/dt_inicio_analise = COALESCE\(dt_inicio_analise, NOW\(\)\)/.test(sqlAss),
       'a transferencia PRESERVA o dt_inicio_analise');
  conf(/dt_assumida = NOW\(\)/.test(sqlAss) && !/dt_assumida = COALESCE/.test(sqlAss),
       'e reinicia o dt_assumida — sao perguntas diferentes');
  ['baixada', 'data_baixa', 'enviado_ci', 'parecer_tipo'].forEach(col => {
    conf(!new RegExp(`\\b${col}\\b`).test(sqlAss), `e nao toca em '${col}' na transferencia`);
  });
}

secao('9. AS TRAVAS QUE SO O BANCO GARANTE');
{
  // ⚠️ DUBLE NAO TEM UNIQUE NEM CHECK. Estas quatro estao no banco, e o que se prova aqui e
  // que o SQL as INVOCA — a prova de que funcionam e a prova contra o Postgres.
  conf(/status = 'pendente'/.test(dp.SQL_DECIDIR),
       "o UPDATE da decisao exige status 'pendente' — e o que impede duas decisoes");
  conf(/WHERE id = \$1 AND status = 'pendente'/.test(dp.SQL_DECIDIR),
       'e por id, nunca por condicao derivada (regra 12)');
  conf(/RETURNING \*/.test(dp.SQL_DECIDIR), 'devolvendo a linha, para saber se pegou');
  conf(/\$1::text IS NULL OR s\.status = \$1::text/.test(dp.SQL_LISTAR),
       'a listagem aceita filtro nulo sem montar SQL na mao');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
