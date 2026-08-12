// CAMINHO: sigpc-api/lib/preparacao.js
//
// MODO PREPARAÇÃO — a manhã da abertura.
//
// A equipe precisa entrar para trocar a senha e completar o cadastro, mas não pode usar o
// sistema antes da apresentação da tarde. Com o interruptor ligado, quem é analista entra,
// troca a senha, chega numa tela restrita com o Meu Perfil e nada mais.
//
// **Superadmin e coordenador não são afetados** — são eles que preparam a reunião.
//
// ⚠️ O QUE ISTO É, E O QUE NÃO É
//
// É uma CORTINA, não uma tranca. A tela esconde o menu, e as rotas de trabalho recusam o
// analista enquanto o modo está ligado. Mas o sistema ainda não tem camada de autorização:
// quem souber montar um pedido HTTP e disser que é coordenador passa, como passa hoje em
// qualquer outra rota. Ver a varredura de 11/08.
//
// Para o que se quer — a equipe não mexer no acervo antes da apresentação — a cortina
// basta. Não confundir com controle de acesso.
//
// ⚠️ NA DÚVIDA, O SISTEMA ABRE (falha aberta, de propósito)
//
// Se a tabela não existir ou o banco oscilar, `ler` devolve o modo DESLIGADO. A escolha é
// deliberada: o erro de deixar alguém trabalhar cedo demais é aborrecido; o de trancar 47
// pessoas fora de um sistema em que elas precisam trocar a senha trava a manhã inteira.

// Quem atravessa a cortina. Perfil que não estiver aqui é restringido — inclusive um perfil
// novo que apareça depois. É o lado seguro do engano: um perfil desconhecido esperando a
// tarde é reversível; um perfil desconhecido mexendo no acervo, não.
const ISENTOS = ['superadmin', 'coordenador'];

const MENSAGEM_PADRAO =
  'O sistema abre para a equipe na parte da tarde, depois da apresentação. ' +
  'Aproveite agora para conferir e completar os seus dados.';

const PADRAO = {
  modo_preparacao: false,
  mensagem: MENSAGEM_PADRAO,
  atualizado_em: null,
  atualizado_por_nome: null,
};

/**
 * Lê o interruptor. NUNCA lança: sem tabela, sem linha ou com o banco fora, devolve
 * desligado — ver o aviso do cabeçalho sobre falhar aberto.
 */
async function ler(db) {
  try {
    const { rows } = await db.query(
      `SELECT modo_preparacao, mensagem, atualizado_em, atualizado_por_nome
         FROM config_sistema WHERE id = 1`);
    if (!rows.length) return { ...PADRAO };
    return {
      modo_preparacao: !!rows[0].modo_preparacao,
      // Mensagem em branco não pode virar tela muda: cai no texto padrão.
      mensagem: (rows[0].mensagem || '').trim() || MENSAGEM_PADRAO,
      atualizado_em: rows[0].atualizado_em || null,
      atualizado_por_nome: rows[0].atualizado_por_nome || null,
    };
  } catch (e) {
    return { ...PADRAO };
  }
}

/** Este usuário fica atrás da cortina? */
function restringe(config, usuario) {
  if (!config || !config.modo_preparacao) return false;
  if (!usuario || !usuario.perfil) return false;   // sem saber quem é, não restringe
  return !ISENTOS.includes(usuario.perfil);
}

/**
 * A conferência que as rotas de trabalho chamam. Devolve a frase de recusa, ou null.
 *
 * Busca o perfil NO BANCO a partir do id, e não do corpo do pedido: o corpo é escrito pela
 * tela, e a tela é a que estamos cobrindo. Não é barreira de segurança — é só não deixar a
 * própria cortina depender de quem está atrás dela.
 */
async function bloqueio(db, usuarioId) {
  const cfg = await ler(db);
  if (!cfg.modo_preparacao) return null;
  // Sem id não dá para saber se é isento. Deixa passar: barrar aqui derrubaria rota que
  // não manda id nenhum, e a cortina viraria pane.
  if (!usuarioId) return null;
  try {
    const { rows } = await db.query('SELECT perfil FROM usuarios WHERE id = $1',
                                    [parseInt(usuarioId) || 0]);
    if (!rows.length) return null;
    if (!restringe(cfg, rows[0])) return null;
    return 'O sistema está em preparação e abre na parte da tarde. ' +
           'Enquanto isso, você pode completar os seus dados em Meu Perfil.';
  } catch (e) {
    return null;
  }
}

/** Valida o que a tela manda. Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  if (b.modo_preparacao !== undefined && typeof b.modo_preparacao !== 'boolean')
    return 'modo_preparacao precisa ser true ou false.';
  if (b.mensagem !== undefined && b.mensagem !== null && String(b.mensagem).length > 400)
    return 'A mensagem passa de 400 caracteres.';
  return null;
}

module.exports = { ISENTOS, MENSAGEM_PADRAO, PADRAO, ler, restringe, bloqueio, validar };
