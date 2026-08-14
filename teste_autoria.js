// CAMINHO: sigpc-api/teste_autoria.js
//
// AUTORIA DUPLA — o trabalho é do analista, a execução é de quem clicou.
// Sem banco: a regra mora em `lib/autoria.js`, e é ela que se testa.
//
// USO: node teste_autoria.js

const a = require('./lib/autoria');

let ok = 0, falhou = 0;
const conf = (p, r, d) => { p ? ok++ : falhou++; console.log(`  ${p ? 'OK  ' : 'FALHA'}  ${r}${p || !d ? '' : `   [${d}]`}`) };
const secao = (t) => console.log(`\n═══ ${t} ═══`);

const SUPER   = { id: 4,  nome: 'Richard Motta Coelho', perfil: 'superadmin' };
const ANALISTA= { id: 22, nome: 'Ana Claudia',          perfil: 'analista' };
const COORD   = { id: 56, nome: 'Gustavo Hallack Porto',perfil: 'coordenador' };

secao('1. O CASO NORMAL: A PESSOA NA PROPRIA CARTEIRA');
{
  const r = a.resolver(ANALISTA, 22);
  conf(r.ok === true, 'passa');
  conf(r.analista_id === 22, 'o dono e ela');
  // ⚠️ NULO QUER DIZER "FOI ELE MESMO". Preencher sempre pareceria mais completo e tiraria o
  // sinal: o que importa achar no historico e a linha em que os dois DIFEREM.
  conf(r.executado_por === null, 'e executado_por fica NULO — nao ha o que registrar');
  conf(r.porOutro === false, 'nao e acao por outro');
  // O id pode chegar como texto, do corpo do pedido.
  conf(a.resolver(ANALISTA, '22').executado_por === null, 'texto e numero sao a mesma pessoa');
}

secao('2. O SUPERADMIN AGINDO PELA CONTA DE OUTRO');
{
  const r = a.resolver(SUPER, 22);
  conf(r.ok === true, 'passa');
  conf(r.analista_id === 22, 'o DONO continua sendo o analista — a produtividade e dele');
  conf(r.executado_por === 4, 'e o EXECUTOR e o superadmin');
  conf(r.porOutro === true, 'marcada como acao por outro');
}

secao('3. QUEM NAO PODE AGIR POR OUTRO');
{
  // ⚠️ SO SUPERADMIN. Sem isto, qualquer analista mandaria `executado_por` e gravaria no nome
  // de outro — o mesmo buraco que a troca de senha de 11/08 fechou, e este e o campo que a
  // CGE le.
  conf(a.resolver(ANALISTA, 99).ok === false, 'analista NAO age por outro analista');
  conf(/no nome de outro/.test(a.resolver(ANALISTA, 99).erro), 'e a mensagem diz por que');
  conf(a.resolver(COORD, 22).ok === false, 'o COORDENADOR tambem nao — nem o do grupo dele');
  conf(a.podeExecutarPorOutro(SUPER) === true, 'so o superadmin pode');
  conf(a.podeExecutarPorOutro(COORD) === false, 'coordenador nao');
  conf(a.podeExecutarPorOutro(null) === false, 'e ninguem nao pode nada');
}

secao('4. O QUE FALTA NO PEDIDO');
{
  conf(a.resolver(null, 22).ok === false, 'sem usuario, recusa');
  conf(a.resolver(SUPER, null).ok === false, 'sem analista_id, recusa');
  conf(a.resolver(SUPER, '').ok === false, 'analista_id vazio tambem');
  conf(a.resolver(SUPER, 'abc').ok === false, 'e analista_id que nao e numero');
}

secao('5. A MARCA NO TEXTO, ALEM DA COLUNA');
{
  // ⚠️ Vai nos DOIS lugares de proposito: a coluna serve para CONSULTAR ("o que o Richard
  // executou"), o texto serve para quem abre uma linha solta do historico. So a coluna
  // repetiria o erro do `registrado_por`, que e nome em texto livre e nunca respondeu a
  // pergunta da CGE.
  const porOutro = a.resolver(SUPER, 22);
  const proprio  = a.resolver(ANALISTA, 22);

  conf(a.marcaObservacao(proprio, 'x') === '', 'acao propria nao ganha marca nenhuma');
  conf(/executado por/.test(a.marcaObservacao(porOutro, 'Richard Motta Coelho')),
       'acao por outro ganha "executado por"');
  conf(/Richard — técnico do sistema/.test(a.marcaObservacao(porOutro, 'Richard Motta Coelho')),
       'com o rotulo combinado com o Richard');
  conf(a.ROTULO_TECNICO === 'Richard — técnico do sistema', 'o rotulo e uma frase, nao um cargo solto');

  // A juncao nao pode deixar " · " solto quando nao havia observacao.
  conf(a.observacaoCom('', porOutro, 'Richard').startsWith('executado por'),
       'sem observacao, a marca comeca a frase');
  conf(a.observacaoCom('parecer do lote 3', porOutro, 'Richard') === 'parecer do lote 3 · executado por Richard (Richard — técnico do sistema)',
       'com observacao, a marca vem depois do texto');
  conf(a.observacaoCom('', proprio, null) === null, 'acao propria sem texto continua nula');
  conf(a.observacaoCom('so o texto', proprio, null) === 'so o texto', 'e o texto passa intacto');
  conf(a.observacaoCom(null, proprio, null) === null, 'null nao vira "null"');
}

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══\n`);
process.exit(falhou ? 1 : 0);
