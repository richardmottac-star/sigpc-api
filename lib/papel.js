// CAMINHO: sigpc-api/lib/papel.js
//
// TROCA DE PAPEL DO SUPERADMIN — dois papéis no mesmo login, e eles deixam de se confundir.
// Especificação do Richard, 14/08/2026.
//
//   'analista'  → "Richard Motta — analista": vê e faz só o que um analista vê e faz.
//   'tecnico'   → "Richard — técnico do sistema": acesso a tudo, e é o ÚNICO papel que age
//                 pela conta de outro analista.
//
// PAPEL PADRÃO AO ENTRAR: analista. Trocar é ato deliberado.
//
// ⚠️ A GUARDA É DO SERVIDOR, e lê `usuarios.papel_ativo` do BANCO — nunca o que o navegador
// manda. Esconder item de menu é cosmético: a URL antiga continua funcionando.

const PAPEIS = ['analista', 'tecnico'];
const PADRAO = 'analista';

// Só o superadmin tem dois papéis. Para os outros 52 cadastros a coluna nunca muda, e
// `perfilEfetivo` devolve o perfil deles sem olhar para ela.
const PERFIL_COM_PAPEL = 'superadmin';

/**
 * O perfil que VALE nesta requisição.
 *
 * ⚠️ É a função que todas as rotas devem usar no lugar de `u.perfil`. Uma regra só: no papel
 * analista, o superadmin é tratado como analista em TODA parte — inclusive nas seis rotas de
 * "coordenador OU superadmin", onde tirar só o superadmin da lista não bastaria (ele não é
 * coordenador de ninguém, então tem de cair fora pelos dois lados).
 */
function perfilEfetivo(u) {
  if (!u) return null;
  if (u.perfil !== PERFIL_COM_PAPEL) return u.perfil;
  return (u.papel_ativo || PADRAO) === 'tecnico' ? u.perfil : PADRAO;
}

/** Está no papel de técnico? (só faz sentido para o superadmin) */
function ehTecnico(u) {
  return perfilEfetivo(u) === PERFIL_COM_PAPEL;
}

/** Este usuário pode trocar de papel? */
function podeTrocar(u) {
  return !!u && u.perfil === PERFIL_COM_PAPEL;
}

/**
 * Valida o pedido de troca. Devolve a mensagem de erro, ou null.
 *
 * ⚠️ Ninguém troca o papel DE OUTRO. A troca é do próprio, e é ato deliberado — trocar por
 * alguém seria mudar o que a pessoa pode fazer sem ela saber.
 */
function validarTroca(quem, alvoId, papel) {
  if (!quem) return 'Usuário não identificado.';
  if (String(quem.id) !== String(alvoId)) return 'Você só troca o seu próprio papel.';
  if (!podeTrocar(quem)) return 'Só o superadmin tem dois papéis.';
  if (!PAPEIS.includes(papel)) return `Papel inválido. Use um de: ${PAPEIS.join(', ')}.`;
  return null;
}

// ⚠️ SEMPRE volta para 'analista' no login. O padrão não é "o que estava antes": se o papel
// sobrevivesse à sessão, uma entrada de manhã continuaria com o acesso de ontem à noite, e
// trocar deixaria de ser ato deliberado.
const SQL_RESETAR_NO_LOGIN = `
  UPDATE usuarios SET papel_ativo = 'analista'
   WHERE id = $1 AND perfil = 'superadmin' AND papel_ativo <> 'analista'
  RETURNING id`;

const SQL_TROCAR = `
  UPDATE usuarios SET papel_ativo = $2
   WHERE id = $1 AND perfil = 'superadmin'
  RETURNING id, nome, perfil, papel_ativo`;

// O registro de cada troca: quando, e para qual papel. `origem` separa "entrou e ficou no
// padrão" de "trocou de propósito" — sem ela, toda entrada vira uma linha igual à da troca.
const SQL_REGISTRAR = `
  INSERT INTO papel_historico (usuario_id, papel, origem) VALUES ($1, $2, $3) RETURNING id`;

module.exports = {
  PAPEIS, PADRAO, PERFIL_COM_PAPEL,
  perfilEfetivo, ehTecnico, podeTrocar, validarTroca,
  SQL_RESETAR_NO_LOGIN, SQL_TROCAR, SQL_REGISTRAR,
};
