// CAMINHO: sigpc-api/teste_ci_fila.js
//
// A FILA DO CONTROLE INTERNO, POR PC (lib/ci-fila.js). Sem rede e sem banco.
//
// ⚠️ REESCRITO EM 25/08/2026 JUNTO COM A LIB. Até aqui a unidade era a TR, e o responsável
// morava numa tabela `ci_responsavel`. O Controle Interno trabalha por PC, e a tabela — que
// nunca chegou a receber uma linha — foi renomeada para `ci_responsavel_backup_20260825`,
// nao derrubada. As checagens que valiam para a TR valem agora para a PC, e as tres que
// existiam so por causa da tabela sairam com ela.
//
// ⚠️ COM DUBLÊ, E NÃO CONTRA O BANCO — armadilha 11 do CLAUDE.md. `devolver` e `passar`
// gerenciam a PRÓPRIA transação: o COMMIT interno delas confirmaria a transação externa de
// um teste, e o ROLLBACK do teste não teria mais o que desfazer. Em 12/08 isso gravou 7 PCs
// e 14 mensagens em produção, num teste que parecia isolado.
//
// O que protege, em uma frase cada:
//   · quem é técnico do C.I. tem UMA fonte — o perfil, nunca uma lista paralela;
//   · abrir NÃO escreve nada — a PC só ganha técnico quando o parecer é confirmado;
//   · o parecer do C.I. é dado por um técnico do C.I., superadmin incluído na recusa;
//   · passar é UPDATE direto, nunca solta-e-pega: a PC não pode ficar órfã no meio;
//   · o motivo é obrigatório nas duas ações que tiram a PC de alguém;
//   · a busca por SGPe normaliza os DOIS lados, e exige os três campos;
//   · nada da fila toca em ci_situacao, baixada, data_baixa ou enviado_ci.
//
// USO: node teste_ci_fila.js

const CF = require('./lib/ci-fila');
const fs = require('fs');

let ok = 0, falhou = 0;
const conf = (passou, rotulo, detalhe) => {
  passou ? ok++ : falhou++;
  console.log(`  ${passou ? 'OK  ' : 'FALHA'}  ${rotulo}${passou || !detalhe ? '' : `   [${detalhe}]`}`);
};

// ⚠️ OS INDICES DE params SEGUEM O SQL_HIST, que tem NOVE parametros:
//   0 tr · 1 parcial_num · 2 setorial_id · 3 evento · 4 valor_anterior · 5 valor_novo
//   6 analista_id(DONO) · 7 executado_por(EXECUTOR) · 8 observacao
// ⚠️ ERAM OITO ATE 25/08: o `parcial_num` era NULO fixo no comando e nao consumia parametro,
// porque o responsavel era da TR. Agora ele e o da PC, e entrou na lista — foi contando com o
// numero antigo que a primeira versao deste teste errou por um em oito checagens.
const H_EVENTO = 3, H_ANT = 4, H_NOVO = 5, H_DONO = 6, H_EXEC = 7, H_OBS = 8;

// Dublê: guarda todo SQL e devolve o que o teste mandar, na ordem.
function db(respostas) {
  const ch = [];
  const fila = [...(respostas || [])];
  const cli = {
    ch,
    query: async (sql, params) => {
      ch.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return fila.length ? fila.shift() : { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { ch, connect: async () => cli, query: cli.query };
}
const sqlDe = (ch) => ch.map(c => c.sql).join(' || ');
const hist = (ch) => ch.find(c => /parcela_historico/.test(c.sql)).params;

const MARCIA  = { id: 62, nome: 'Marcia Terezinha Miranda', perfil: 'controle_interno', ativo: true, papel_ativo: 'analista' };
const ATEM    = { id: 63, nome: 'Atemilson Bispo dos Santos', perfil: 'controle_interno', ativo: true, papel_ativo: 'analista' };
const RICHARD = { id: 4,  nome: 'Richard Motta Coelho', perfil: 'superadmin', papel_ativo: 'tecnico' };
const ANALISTA = { id: 13, nome: 'Gabriele', perfil: 'analista', papel_ativo: 'analista' };
const COORD   = { id: 56, nome: 'Gustavo Hallack Porto', perfil: 'coordenador', papel_ativo: 'analista' };

(async () => {

console.log('\n═══ 1. QUEM PODE MEXER NA FILA ═══');
{
  conf(CF.podeAgir(MARCIA) === true, 'tecnico do C.I. pode');
  conf(CF.podeAgir(RICHARD) === true, 'superadmin tambem, sem restricao');
  // ⚠️ O coordenador entrou em 24/08 e NAO e detalhe de permissao: o menu abre esta tela para
  // ele. Sem isto, ele veria o item, clicaria e leria "Esta fila e do Controle Interno" — a
  // tela que aceita ser aberta e nao responde, que e a armadilha 15 vestida de autorizacao.
  conf(CF.podeAgir(COORD) === true, 'coordenador tambem — e o menu dele abre esta tela');
  conf(CF.podeAgir(ANALISTA) === false, 'analista nao');
  // ⚠️ No papel analista o superadmin E analista, em toda parte. Regra unica de 14/08.
  conf(CF.podeAgir({ ...RICHARD, papel_ativo: 'analista' }) === false, 'no papel analista, nem o superadmin');
  conf(CF.podeAgir(null) === false, 'ninguem logado nao passa');
}

console.log('\n═══ 2. A LISTA LE ci_situacao, NUNCA enviado_ci ═══');
{
  // ⚠️ `enviado_ci` diz "foi ao C.I." e SUSTENTA A BAIXA; `ci_situacao` diz onde a PC esta no
  // ciclo. Confundir as duas foi o defeito que 12/08 corrigiu, e voltar a filtrar por
  // `enviado_ci` faria a PC sumir da tela sem deixar rastro.
  const f = CF.montarFiltro({ chip: 'fila', meuId: 62 });
  conf(/ci_situacao = 'na_fila'/.test(f.sql), 'o chip padrao e a fila');
  conf(!/enviado_ci/.test(f.sql), 'e enviado_ci nao entra no filtro');
  const sql = CF.sqlLista(f.sql);
  conf(/FROM prestacoes_contas p/.test(sql), 'a lista sai de prestacoes_contas');
  // ⚠️ A UNIDADE E A PC. Um GROUP BY aqui devolveria a TR de novo.
  conf(!/GROUP BY/.test(sql), 'sem GROUP BY: uma linha por PC, nao por TR');
  conf(/p\.codigo_pc/.test(sql), 'e o codigo da PC vem na resposta');
  // ⚠️ O parecer mora em parcela_historico, e e RARO — 26 de 958 medidos em 18/08. A tela
  // precisa distinguir "a analista nao escreveu nada" de "nao veio na consulta".
  conf(/LEFT JOIN LATERAL[\s\S]*evento = 'parecer'/.test(sql), 'o texto do parecer vem por LATERAL');
  conf(/LEFT JOIN usuarios t ON t\.id = p\.ci_tecnico_id/.test(sql),
       'o tecnico entra por LEFT JOIN — PC sem dono continua na lista');
  conf(/LIMIT/.test(sql), 'e a lista tem teto');
}

console.log('\n═══ 3. OS CHIPS SAO RECORTES DA MESMA COLUNA ═══');
{
  const q = (chip) => CF.montarFiltro({ chip, meuId: 62 }).sql;
  conf(/ci_tecnico_id = \$1::int/.test(q('minhas')), '"Comigo" e ci_tecnico_id = eu');
  conf(/ci_tecnico_id <> \$1::int/.test(q('outros')), '"Com outros" e ci_tecnico_id <> eu');
  conf(/IS NOT NULL/.test(q('outros')), 'e exclui as sem dono');
  conf(/> 30/.test(q('mais30')), '"Mais de 30 dias" usa a mesma borda da faixa critica');
  conf(/ci_situacao = 'encerrado'/.test(q('encerradas')), '"Encerradas" e ci_situacao = encerrado');
  conf(/ci_situacao = 'com_analista'/.test(q('com_analista')), 'e o card "Com o analista" tem para onde levar');
  // ⚠️ Os quatro primeiros chips sao recortes da FILA. Sem isto, "Comigo" traria tambem as
  // encerradas que eu decidi — e o numero do chip deixaria de bater com a lista.
  ['minhas', 'outros', 'mais30'].forEach(c =>
    conf(/ci_situacao = 'na_fila'/.test(q(c)), `"${c}" e um recorte da fila`));
  // Chip desconhecido cai na fila, e nao numa lista sem WHERE nenhum.
  conf(/ci_situacao = 'na_fila'/.test(q('inventado')), 'chip desconhecido cai na fila');
  conf(CF.CHIPS.length === 6, 'sao seis recortes — os cinco chips e o card do analista');

  // ⚠️ CADA $n TEM DE TER UM PARAMETRO, E CADA PARAMETRO UM $n. Esta checagem existe por causa
  // de um erro medido contra o banco em 25/08/2026:
  //
  //     bind message supplies 1 parameters, but prepared statement "" requires 0
  //
  // A primeira versao punha o `meuId` em `$1` sempre e so o USAVA em dois dos seis chips. Nos
  // outros quatro o SQL saia sem nenhum `$1`, e o `pg` recusa um parametro que a consulta nao
  // usa — quatro dos seis recortes da tela quebravam, e os 145 testes com duble passavam. O
  // duble guarda o SQL e os params, e nao os confere UM CONTRA O OUTRO. Agora confere.
  for (const chip of CF.CHIPS.concat(['inventado'])) {
    for (const extra of [{}, { q: 'APAE' }, { analista_id: 13 }, { espera: 'critica' },
                         { sgpe: 'SCC/9692/2024' }, { q: 'x', analista_id: 13, espera: 'ok' }]) {
      const f = CF.montarFiltro({ chip, meuId: 62, ...extra });
      const usados = (f.sql.match(/\$\d+/g) || []).map(x => +x.slice(1));
      const maior = usados.length ? Math.max(...usados) : 0;
      const rot = chip + ' + ' + (Object.keys(extra).join('/') || 'nada');
      conf(maior === f.params.length,
           'os $n e os parametros batem em: ' + rot, `maior $${maior} para ${f.params.length} params`);
      // E nenhum buraco no meio: $1, $2, $3... sem pular.
      conf(new Set(usados).size === f.params.length, 'sem buraco na numeracao em: ' + rot);
    }
  }
}

console.log('\n═══ 4. ESPERA E FAIXA ═══');
{
  // ⚠️ A ESPERA TEM UMA FONTE SO: O BANCO. Houve uma `diasEspera` em JavaScript aqui, e ela
  // foi removida em 25/08/2026 depois de DIVERGIR do SQL em 12 de 200 linhas medidas — 6%.
  // O `pg` devolve `timestamp WITHOUT time zone` como `Date` no fuso LOCAL, entao uma PC
  // encaminhada as 22h de Brasilia (01:00 UTC do dia seguinte) contava um dia a menos de
  // espera. O SQL, que converte de UTC para Brasilia em dois passos, lia o dia certo.
  //
  // Este teste protege o que sobrou: que a conta continua sendo UMA.
  conf(CF.diasEspera === undefined, 'nao ha uma segunda conta de espera em JavaScript');
  conf(/dias_espera/.test(CF.sqlLista('true')), 'a lista traz a espera calculada pelo banco');

  conf(CF.faixaEspera(15) === 'ok', '15 dias ainda e verde');
  conf(CF.faixaEspera(16) === 'atencao', '16 ja e ambar');
  conf(CF.faixaEspera(30) === 'atencao', '30 continua ambar');
  conf(CF.faixaEspera(31) === 'critica', '31 e vermelho');
  conf(CF.faixaEspera(null) === null, 'sem dias, sem faixa');

  // ⚠️ DOIS PASSOS NO AT TIME ZONE (armadilha 18). `dt_envio_ci` e timestamp guardando UTC:
  // um passo so INTERPRETA o valor como sendo de Brasilia e SOMA 3 h.
  conf(/\(p\.dt_envio_ci AT TIME ZONE 'UTC'\) AT TIME ZONE 'America\/Sao_Paulo'/.test(CF.SQL_DIAS),
       'o SQL converte de UTC para Brasilia, em dois passos');
  conf(!/CURRENT_DATE/.test(CF.SQL_DIAS), 'e nao usa CURRENT_DATE — o Railway roda em UTC');
}

console.log('\n═══ 5. A BUSCA POR SGPe NORMALIZA OS DOIS LADOS ═══');
{
  // ⚠️ `SCC 00009692/2024` e `SCC9692/2024` sao o MESMO processo, e os dois estao no banco.
  // Normalizar so o que o usuario digita acha uma metade e some com a outra, sem erro nenhum.
  conf(CF.chaveSgpe('SCC', '9692', '2024') === 'SCC/9692/2024', 'a chave e sigla/numero/ano');
  conf(CF.chaveSgpe('SCC', '00009692', '2024') === 'SCC/9692/2024', 'zeros a esquerda somem');
  conf(CF.chaveSgpe('scc', ' 9.692 ', '2024') === 'SCC/9692/2024', 'minusculas e pontuacao tambem');
  conf(CF.chaveSgpe('SCC', '9692', '24') === 'SCC/9692/2024', 'ano de dois digitos vira quatro');

  // ⚠️ OS TRES CAMPOS SAO OBRIGATORIOS. Buscar so pelo numero devolveria o SCC 7537 de SETE
  // anos diferentes — a armadilha 19 dita como interface.
  conf(CF.chaveSgpe('SCC', '9692', '') === null, 'sem ano, sem busca');
  conf(CF.chaveSgpe('', '9692', '2024') === null, 'sem sigla, sem busca');
  conf(CF.chaveSgpe('SCC', '', '2024') === null, 'sem numero, sem busca');
  conf(/Informe o ano do processo/.test(CF.faltaSgpe('SCC', '9692', '')), 'e o botao cinza diz o que falta');
  conf(CF.faltaSgpe('SCC', '9692', '2024') === null, 'com os tres, nada falta');

  // O lado do BANCO passa pela mesma normalizacao: ltrim dos zeros, upper na sigla, ano com 4.
  conf(/ltrim\(/.test(CF.SQL_SGPE_CHAVE), 'o SQL tira os zeros a esquerda');
  conf(/upper\(/.test(CF.SQL_SGPE_CHAVE), 'e poe a sigla em maiusculas');
  conf(/'20' \|\|/.test(CF.SQL_SGPE_CHAVE), 'e completa o ano de dois digitos');

  // ⚠️ A BUSCA POR PROCESSO IGNORA O CHIP. Quem digita um processo quer aquele processo, e nao
  // "aquele processo, se por acaso estiver no recorte que estava aberto".
  const f = CF.montarFiltro({ chip: 'encerradas', meuId: 62, sgpe: 'SCC/9692/2024' });
  conf(!/ci_situacao = 'encerrado'/.test(f.sql), 'o chip nao limita a busca por processo');
  conf(/ci_situacao IS NOT NULL/.test(f.sql), 'mas o ciclo do C.I. continua sendo o universo');
  conf(f.params.includes('SCC/9692/2024'), 'e a chave vai por parametro');
}

console.log('\n═══ 6. O FILTRO NAO CONCATENA TEXTO DE USUARIO ═══');
{
  // ⚠️ Tudo por $n. O unico texto que este arquivo poe na string do SQL e o que ele mesmo
  // escreve — o que vem da tela nunca vira SQL.
  const f = CF.montarFiltro({ chip: 'fila', meuId: 62, q: "x'; DROP TABLE usuarios; --", analista_id: '13' });
  conf(!/DROP TABLE/.test(f.sql), 'o texto do usuario nao aparece no SQL');
  conf(f.params.some(p => String(p).includes('DROP TABLE')), 'ele vai como parametro');
  conf(/ILIKE/.test(f.sql), 'a busca livre e ILIKE');
  conf(f.params.some(p => p === 13), 'e o analista entra como inteiro');
  // O `%` e o `_` do usuario sao literais, e nao curingas: quem digita "50%" procura "50%".
  const g = CF.montarFiltro({ chip: 'fila', meuId: 62, q: '50%' });
  conf(g.params.some(p => String(p).includes('50\\%')), 'o curinga digitado e escapado');
  // Faixa de espera desconhecida simplesmente nao filtra, em vez de virar SQL invalido.
  const h = CF.montarFiltro({ chip: 'fila', meuId: 62, espera: 'inventada' });
  conf(h.params.length === 0, 'faixa desconhecida nao vira filtro', 'params: ' + h.params.length);
}

console.log('\n═══ 7. O MOTIVO ═══');
{
  conf(CF.validarMotivo('') !== null, 'vazio e recusado');
  conf(CF.validarMotivo('   ') !== null, 'so espaco tambem');
  conf(CF.validarMotivo('curto') !== null, 'menos de 10 caracteres e recusado');
  conf(CF.validarMotivo('a'.repeat(10)) === null, 'exatamente 10 passa');
  conf(CF.validarMotivo('a'.repeat(501)) !== null, 'acima de 500 e recusado');
}

console.log('\n═══ 8. ABRIR NAO ESCREVE NADA ═══');
{
  // ⚠️ HAVIA UMA `abrir(db, {codigo_pc, quem})` AQUI, e ela foi removida em 26/08/2026.
  //
  // Ela marcava a PC como do tecnico no instante em que ele a EXPANDIA na tela. A ideia era
  // coordenar os tres — quem abriu, ficou —, e o efeito foi que **olhar virou tomar**: nao
  // havia como examinar um valor, um processo SGPe ou o parecer da analista sem se declarar
  // responsavel. No primeiro dia isso pos o nome do superadmin numa PC que ele nao analisa.
  //
  // A posse virou CONSEQUENCIA do parecer. Este teste protege a ausencia: se alguem
  // reintroduzir uma funcao de "abrir" que escreve, ele quebra.
  conf(CF.abrir === undefined, 'a lib nao exporta mais uma funcao de abrir');
  const fonte = fs.readFileSync('./lib/ci-fila.js', 'utf8');
  const codigo = fonte.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // ⚠️ A UNICA funcao desta lib que ATRIBUI um tecnico e o `passar`, que move a demanda de um
  // tecnico do C.I. para outro. `devolver` so apaga. Se aparecer um segundo lugar gravando um
  // id aqui, e porque o "abrir que assume" voltou com outro nome.
  // ⚠️ COM O `SET`, e nao so o nome da coluna: o `SQL_RESUMO` compara `ci_tecnico_id = $1::int`
  // para contar o chip "Comigo", e uma busca pelo nome cru contaria essa LEITURA como escrita.
  // Foi o que aconteceu na primeira versao desta linha — 2 lugares, e um deles era um COUNT.
  const atribui = (codigo.match(/SET ci_tecnico_id = \$\d+::int/g) || []).length;
  conf(atribui === 1, 'so UMA funcao da lib atribui tecnico (o passar)', atribui + ' lugares');
  conf(/async function passar[\s\S]*?ci_tecnico_id = \$2::int/.test(codigo),
       'e e o passar — devolver so apaga');

  // ⚠️ QUEM CARIMBA E `ci.decidir`, no MESMO UPDATE do parecer. Um UPDATE separado deixaria a
  // janela em que a decisao existe e o autor dela nao.
  const libCi = fs.readFileSync('./lib/ci.js', 'utf8');
  const dec = libCi.slice(libCi.indexOf('async function decidir'), libCi.indexOf('async function responder'));
  conf(/const carimbo = `ci_tecnico_id = \$2::int, ci_tecnico_em = NOW\(\)`/.test(dec),
       'ci.decidir carimba o tecnico');
  conf((dec.match(/\$\{carimbo\}/g) || []).length === 2,
       'nos DOIS caminhos — de acordo e devolucao', 'a devolvida tambem precisa dizer quem a devolveu');
  conf(!/UPDATE prestacoes_contas\s+SET ci_tecnico_id[\s\S]{0,200}WHERE/.test(dec),
       'e nunca num UPDATE separado da decisao');
}

console.log('\n═══ 9. DEVOLVER — a PC volta a ficar sem dono ═══');
{
  const d = db([{ rows: [] },
                { rows: [{ tr:'A', parcial_num:'2', setorial_id:'FCEE', ci_tecnico_id: 62, ci_tecnico_nome:'Marcia' }] },
                { rows: [] }, { rows: [] }, { rows: [] }]);
  const r = await CF.devolver(d, { codigo_pc:'A-PC1', quem: MARCIA, motivo:'vou entrar de ferias amanha' });
  const sql = sqlDe(d.ch);
  conf(r.ok === true, 'devolveu');
  // ⚠️ O DONO E LIDO ANTES DE APAGAR. `UPDATE ... RETURNING` devolveria o valor NOVO, que aqui
  // e o proprio NULL — a trilha ficaria com "devolveu: (vazio)".
  conf(/FOR UPDATE/.test(sql), 'a linha e lida e trancada antes');
  conf(sql.indexOf('FOR UPDATE') < sql.indexOf('SET ci_tecnico_id = NULL'), 'e a leitura vem antes do UPDATE');
  const p = hist(d.ch);
  conf(p[H_EVENTO] === 'ci_devolveu', 'o evento e ci_devolveu');
  conf(p[H_ANT] === 'Marcia' && p[H_NOVO] === null, 'de quem era, e para ninguem');
  // ⚠️ AUTORIA DUPLA: o DONO e quem estava com a PC; o EXECUTOR some quando sao o mesmo.
  conf(p[H_DONO] === 62, 'o dono da linha e quem estava com a PC');
  conf(p[H_EXEC] === null, 'e o executor fica NULO quando foi ele mesmo');
  conf(/vou entrar de ferias amanha/.test(p[H_OBS]), 'o motivo vai para o historico');

  // Outro tecnico devolvendo a PC de alguem: os dois papeis passam a diferir.
  const d2 = db([{ rows: [] },
                 { rows: [{ tr:'A', parcial_num:'2', setorial_id:'FCEE', ci_tecnico_id: 62, ci_tecnico_nome:'Marcia' }] },
                 { rows: [] }, { rows: [] }]);
  await CF.devolver(d2, { codigo_pc:'A-PC1', quem: ATEM, motivo:'a Marcia esta afastada' });
  const p2 = hist(d2.ch);
  conf(p2[H_DONO] === 62 && p2[H_EXEC] === 63, 'devolvida por outro: dono 62, executor 63');
  conf(/por Atemilson/.test(p2[H_OBS]), 'e o texto diz quem executou');

  // PC que ja estava sem dono.
  const d3 = db([{ rows: [] }, { rows: [{ tr:'B', parcial_num:'1', ci_tecnico_id: null }] }]);
  const r3 = await CF.devolver(d3, { codigo_pc:'B-PC1', quem: MARCIA, motivo:'qualquer motivo aqui' });
  conf(r3.ok === false && r3.semDono === true, 'PC sem dono nao e "devolvida" duas vezes');
  conf(/ROLLBACK/.test(sqlDe(d3.ch)), 'e desfaz');

  conf(!/ci_situacao|baixada|data_baixa|enviado_ci/.test(sql),
       'devolver nao menciona ci_situacao, baixada, data_baixa nem enviado_ci');
}

console.log('\n═══ 10. PASSAR — a PC nunca fica orfa no meio ═══');
{
  const d = db([{ rows: [] },
                { rows: [{ tr:'A', parcial_num:'3', setorial_id:'FCEE', ci_situacao:'na_fila',
                           ci_tecnico_id: 62, ci_tecnico_nome:'Marcia' }] },
                { rows: [] }, { rows: [] }, { rows: [] }]);
  const r = await CF.passar(d, { codigo_pc:'A-PC1', quem: MARCIA, destino: ATEM, motivo:'ela conhece esta entidade' });
  const sql = sqlDe(d.ch);
  conf(r.ok === true, 'passou');
  // ⚠️ UM UPDATE DIRETO, e nao solta-e-pega. Entre um e outro, mesmo na mesma transacao, uma
  // falha deixaria a demanda ORFA — o estado que esta tela existe para acabar.
  conf(/SET ci_tecnico_id = \$2::int/.test(sql), 'e um UPDATE por cima');
  conf(!/ci_tecnico_id = NULL/.test(sql), 'a PC nunca passa por "sem dono" no caminho');
  conf(/FOR UPDATE/.test(sql), 'a linha e travada antes de trocar de dono');
  const p = hist(d.ch);
  conf(p[H_EVENTO] === 'ci_passou', 'o evento e ci_passou');
  conf(p[H_ANT] === 'Marcia' && p[H_NOVO] === 'Atemilson Bispo dos Santos', 'de quem para quem fica gravado');
  conf(p[H_DONO] === 63, 'o DONO passa a ser o destino');
  conf(p[H_EXEC] === 62, 'e o executor e quem clicou');
  conf(/ela conhece esta entidade/.test(p[H_OBS]), 'com o motivo');

  // ⚠️ SO SE PASSA O QUE ESTA NA FILA. Uma encerrada nao volta para o colo de ninguem.
  const d2 = db([{ rows: [] }, { rows: [{ tr:'A', parcial_num:'1', ci_situacao:'encerrado' }] }]);
  const r2 = await CF.passar(d2, { codigo_pc:'A-PC9', quem: MARCIA, destino: ATEM, motivo:'motivo qualquer aqui' });
  conf(r2.ok === false && r2.foraDaFila === true, 'PC encerrada nao e passada a ninguem');
  conf(/ROLLBACK/.test(sqlDe(d2.ch)), 'e desfaz');
}

console.log('\n═══ 11. O PARECER E DO C.I. — SUPERADMIN INCLUIDO NA RECUSA ═══');
{
  // ⚠️ MUDOU EM 26/08/2026, e nao e endurecimento gratuito: o parecer **carimba o nome de quem
  // o deu** em `ci_tecnico_id`. O nome que fica ali tem de ser o de um tecnico do Controle
  // Interno. Um superadmin decidindo poria o nome dele numa PC que ele nao analisa — que foi
  // exatamente o que aconteceu no primeiro dia da tela.
  conf(CF.podeDecidir(MARCIA, null) === true, 'tecnico do C.I. decide, e a PC nem precisa ter dono');
  conf(CF.podeDecidir(MARCIA, 62) === true, 'PC que ja e dele: decide');
  // ⚠️ SAO TRES PESSOAS NA MESMA FILA. Travar por dono criaria demanda parada toda vez que
  // alguem faltasse, e a PC so tem dono depois de UMA rodada — o caso e raro e o custo, alto.
  conf(CF.podeDecidir(MARCIA, 63) === true, 'PC de outro TECNICO do C.I.: tambem decide');

  // ⚠️ A UNICA REGRA DO SISTEMA EM QUE O SUPERADMIN NAO PASSA. Em todo o resto ele e isento —
  // modo manutencao, limite de TRs, decidir o proprio pedido de devolucao. As outras isencoes
  // o deixam AGIR; esta o faria APARECER como se fosse outra pessoa, num registro que a CGE le.
  conf(CF.podeDecidir(RICHARD, 63) === false, 'o SUPERADMIN nao decide — nem no papel tecnico');
  conf(CF.podeDecidir(RICHARD, null) === false, 'nem numa PC sem dono');
  conf(CF.podeDecidir({ ...RICHARD, papel_ativo: 'analista' }, null) === false, 'nem no papel analista');
  conf(CF.podeDecidir(COORD, null) === false, 'o coordenador tambem nao');
  conf(CF.podeDecidir(ANALISTA, null) === false, 'e o analista muito menos');
  conf(CF.podeDecidir(null, 62) === false, 'ninguem logado nao decide nada');

  // ⚠️ MAS VER CONTINUA LIBERADO. Ler a fila e decidir sobre ela sao coisas diferentes, e o
  // item de menu do coordenador depende disso — ver a secao 1.
  conf(CF.podeAgir(COORD) === true && CF.podeDecidir(COORD, null) === false,
       'coordenador VE a fila e nao decide — as duas guardas sao separadas');
  conf(CF.podeAgir(RICHARD) === true && CF.podeDecidir(RICHARD, null) === false,
       'e o superadmin tambem');

  // O motivo, para o botao cinza poder dizer POR QUE em vez de so ficar apagado.
  conf(/tecnico do C\.I\.|técnico do C\.I\./.test(CF.motivoNaoDecide()),
       'o motivo diz que o parecer e do C.I.');
  conf(/seu nome ficaria registrado/.test(CF.motivoNaoDecide()),
       'e diz POR QUE: o nome de quem decide fica na PC');
}

console.log('\n═══ 12. OS ROTULOS DO HISTORICO ═══');
{
  conf(CF.ROTULO_EVENTO.ci_abriu === 'abriu no Controle Interno', 'abriu no Controle Interno');
  conf(CF.ROTULO_EVENTO.ci_devolveu === 'devolveu à fila do C.I.', 'devolveu a fila');
  conf(CF.ROTULO_EVENTO.ci_passou === 'passou a demanda do C.I.', 'passou a demanda');
  conf(CF.ROTULO_EVENTO.ci_decidiu === 'decidiu no Controle Interno', 'decidiu no C.I.');
  // O texto das duas decisoes mora num lugar so — ele vai para o radio, para a notificacao e
  // para a trilha. Escrever a mesma frase em tres lugares garante que um fique para tras.
  conf(CF.ROTULO_DECISAO.de_acordo === 'Parecer do analista em acordo, baixado', 'o rotulo do de acordo');
  conf(CF.ROTULO_DECISAO.ressalva === 'Parecer para correção, verificar o processo no SGPe', 'e o da correcao');
}

console.log('\n═══ 13. TRAVAS NO server.js ═══');
{
  const src = fs.readFileSync('./server.js', 'utf8');
  conf(/app\.get\('\/ci\/fila'/.test(src), 'GET /ci/fila existe');
  // ⚠️ DUAS ROTAS COM O MESMO CAMINHO NAO DAO ERRO: o Express casa na PRIMEIRA declarada e a
  // segunda vira codigo morto. A rota antiga por `situacao` ocupava este caminho ate 25/08.
  conf((src.match(/app\.get\('\/ci\/fila'/g) || []).length === 1, 'e e a UNICA com esse caminho');
  conf(!/app\.get\('\/ci\/fila_trabalho'/.test(src), 'a rota por TR saiu');
  // ⚠️ POST /ci/pc/abrir SAIU EM 26/08/2026, junto com a regra que a justificava. Enquanto ela
  // existisse, haveria duas portas para o mesmo estado — uma que atribui ao abrir e outra que
  // atribui ao decidir — e um dia alguem chamaria a errada.
  conf(!/app\.post\('\/ci\/pc\/abrir'/.test(src), 'POST /ci/pc/abrir SAIU');
  conf(!/app\.get\('\/ci\/pc\/abrir'/.test(src), 'e nao virou um GET');
  ['devolver', 'passar'].forEach(a =>
    conf(new RegExp(`app\\.post\\('/ci/pc/${a}'`).test(src), `POST /ci/pc/${a} existe`));
  conf(!/app\.post\('\/ci\/tr\//.test(src), 'e as tres rotas por TR sairam');

  // ⚠️ QUEM PEDE E LIDO DO BANCO. Quatro rotas ja confiaram no `perfil` do corpo, e bastava
  // mandar `perfil: 'superadmin'` para passar.
  const g = src.slice(src.indexOf('async function guardaCi'), src.indexOf('async function guardaCi') + 700);
  conf(/lerUsuario\(pool, \(req\.body \|\| \{\}\)\.usuario_id\)/.test(g), 'a guarda le o usuario do BANCO');
  conf(/ciFila\.podeAgir\(quem\)/.test(g), 'e usa a regra unica da lib');

  // ⚠️ O DESTINO TAMBEM E CONFERIDO CONTRA O BANCO. Sem isto, passar a demanda para um
  // analista qualquer a tiraria da fila do C.I. sem sair do ciclo — orfa.
  const p = src.slice(src.indexOf("app.post('/ci/pc/passar'"), src.indexOf("app.post('/ci/pc/passar'") + 2000);
  conf(/lerUsuario\(pool, req\.body\.destino_id\)/.test(p), 'o destino e lido do banco');
  conf(/perfilEfetivo\(d\) !== 'controle_interno'/.test(p), 'e precisa ser tecnico do C.I.');
  conf(/d\.id === g\.quem\.id/.test(p), 'passar para si mesmo e recusado — para isso basta abrir');

  // ⚠️ O MAPA DE LINKS DO SGPe E O QUE FAZ O NUMERO VIRAR LINK. Sem ele o processo sai em
  // texto puro, sem erro nenhum, e o tecnico nao abre o processo que precisa conferir.
  const fila = src.slice(src.indexOf("app.get('/ci/fila'"), src.indexOf('async function guardaCi'));
  conf(/linksDeLinhas\(pool, linhas/.test(fila), 'a lista devolve o mapa de links (armadilha 20)');
  // ⚠️ O CORTE E DITO, nunca silencioso: uma lista truncada sem aviso se le como "acabou".
  conf(/ciFila\.sqlContar/.test(fila), 'e conta o total quando a lista e cortada');

  // ⚠️ NENHUMA DAS ROTAS DA FILA MEXE NO CICLO NEM NA BAIXA.
  const bloco = src.slice(src.indexOf("app.get('/ci/fila'"), src.indexOf("app.post('/ci/decidir'"));
  conf(!/UPDATE prestacoes_contas/.test(bloco), 'nenhuma rota da fila escreve direto em prestacoes_contas');
  // ⚠️ A TRAVA DE DECIDIR VIVE NO SERVIDOR, e nao so no botao cinza. Desabilitar avisa;
  // recusar impede.
  const dec = src.slice(src.indexOf("app.post('/ci/decidir'"), src.indexOf("app.post('/ci/responder'"));
  conf(/ciFila\.podeDecidir\(autor, null\)/.test(dec),
       'POST /ci/decidir confere que quem pede e do C.I.');
  // ⚠️ E CONFERE A PESSOA, nao a posse de cada PC. A posse virou CONSEQUENCIA do parecer:
  // exigi-la antes travaria a fila inteira, porque nenhuma PC tem dono ate o primeiro parecer.
  conf(!/const donos = await pool\.query/.test(dec),
       'e a consulta `donos`, que lia o tecnico PC a PC, saiu junto');
  conf(!/ci_responsavel/.test(dec), 'nem le a tabela por TR, que saiu do caminho do codigo');
  conf(/ciFila\.motivoNaoDecide\(\)/.test(dec), 'e a recusa diz POR QUE o parecer e do C.I.');
  // A conferencia vem ANTES de `ci.decidir`, que abre a propria transacao e grava.
  conf(dec.indexOf('podeDecidir') < dec.indexOf('await ci.decidir('),
       'e a conferencia vem ANTES de a decisao ser gravada');
}

console.log('\n═══ 14. A DECISAO ENTRA NO HISTORICO DA PARCELA ═══');
{
  // ⚠️ Ate 25/08 a decisao so existia na `ci_mensagem` e no par ci_encerrado_em/_por — e a
  // DEVOLUCAO nao deixava rastro nenhum na trilha, porque `ci_encerrado_*` so e gravado no de
  // acordo. A conversa e a trilha respondem perguntas diferentes.
  const src = fs.readFileSync('./lib/ci.js', 'utf8');
  const dec = src.slice(src.indexOf('async function decidir'), src.indexOf('async function responder'));
  conf(/INSERT INTO parcela_historico/.test(dec), 'decidir grava no parcela_historico');
  conf(/'ci_decidiu'/.test(dec), 'com o evento ci_decidiu');
  conf(/for \(const r of alvo\.rows\)/.test(dec), 'uma linha POR PC');
  conf(dec.indexOf('INSERT INTO parcela_historico') < dec.indexOf("await cli.query('COMMIT')"),
       'e dentro da MESMA transacao da decisao');
  // ⚠️ E NADA DISSO TOCA NA BAIXA, em nenhum dos dois caminhos.
  // ⚠️ SEM OS COMENTARIOS: o proprio corpo de decidir EXPLICA que nao toca na baixa, e o
  // texto da explicacao casaria com a busca. E o codigo que precisa ser conferido aqui.
  const decSql = dec.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  conf(!/baixada|data_baixa|enviado_ci/.test(decSql), 'e a decisao nao ESCREVE baixada, data_baixa nem enviado_ci');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exitCode = falhou ? 1 : 0;
})();
