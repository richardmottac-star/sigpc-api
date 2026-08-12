// CAMINHO: sigpc-api/lib/duplicata.js
//
// DUPLICIDADE DE CADASTRO — quem já existe antes de aprovar.
//
// ⚠️ POR QUE ISTO EXISTE
//
// As contas antigas do acervo têm NOME CURTO e NENHUM CPF ("Franciani", "Marlene",
// "Ana Leticia"). Quando essas pessoas usam o Primeiro Acesso, digitam o nome completo e o
// CPF — e a busca por CPF não acha nada, porque a conta velha não tem CPF. Resultado: nasce
// uma segunda conta, e a antiga é a que tem as PCs e as baixas.
//
// Aprovar a nova sem perceber deixa a pessoa com duas contas: entra pela nova, que tem zero
// PC, e o trabalho dela fica preso na velha.
//
// ⚠️ A REGRA QUE IMPEDE O ESTRAGO: CPF DIFERENTE VENCE O NOME.
//
// A primeira versão desta regra casava por nome contido e produziu um falso positivo
// perigoso em 12/08: "Ana Claudia" (id 22, 106 PCs, 57 baixas) com "Claudia" (id 36,
// 135 PCs, 53 baixas). São duas pessoas — CPFs, grupos e e-mails diferentes. Mesclar teria
// destruído o histórico de uma delas.
//
// Por isso: dois CPFs presentes e diferentes é PROVA de pessoas diferentes, e o nome não
// tem voto. O nome só fala quando o cadastro antigo não tem CPF — que é exatamente o padrão
// que gera o problema.

const NIVEIS = { CERTEZA: 0, FORTE: 1, FRACO: 2 };

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const digitos = (s) => String(s || '').replace(/\D/g, '');

/**
 * Compara um cadastro pendente com um já existente.
 * Devolve `{ nivel, motivo }` ou null quando não há indício.
 */
function avaliar(novo, velho) {
  if (!novo || !velho || novo.id === velho.id) return null;
  const cpfN = digitos(novo.cpf), cpfV = digitos(velho.cpf);

  // 1. Mesmo CPF: é a mesma pessoa, e nada mais precisa ser olhado.
  if (cpfN && cpfV && cpfN === cpfV) return { nivel: 'CERTEZA', motivo: 'mesmo CPF' };

  // 2. ⚠️ CPFs presentes e DIFERENTES: pessoas diferentes. O nome não importa.
  //    É esta linha que separa "Ana Claudia" de "Claudia".
  if (cpfN && cpfV && cpfN !== cpfV) return null;

  // 3. Daqui para baixo o cadastro antigo não tem CPF — o padrão do acervo.
  const tn = norm(novo.nome).split(' ').filter(Boolean);
  const tv = norm(velho.nome).split(' ').filter(Boolean);
  if (!tn.length || !tv.length) return null;

  if (norm(novo.nome) === norm(velho.nome)) return { nivel: 'FORTE', motivo: 'nome idêntico' };

  // "Franciani" dentro de "Franciani Mary Daniel Pereira". Exigir que o PRIMEIRO nome
  // coincida evita casar "Ana Claudia" com "Claudia" caso os CPFs faltassem nos dois.
  const curto = tv.length <= tn.length ? tv : tn;
  const longo = tv.length <= tn.length ? tn : tv;
  if (curto.every(t => longo.includes(t)) && curto[0] === longo[0])
    return { nivel: 'FORTE', motivo: 'nome do cadastro antigo está contido, e começa igual' };

  // Primeiro nome igual e nada mais: indício fraco, mas some do bloco — não some da tela.
  if (tn[0] === tv[0] && tn[0].length >= 4)
    return { nivel: 'FRACO', motivo: 'apenas o primeiro nome coincide' };

  return null;
}

/**
 * Para cada pendente, os candidatos a "já existe", do mais forte para o mais fraco.
 * `todos` são todos os usuários; os que estão aguardando aprovação não entram como candidatos
 * — dois pendentes não se resolvem um ao outro.
 */
function analisar(pendentes, todos) {
  const base = (todos || []).filter(u => !u.aguardando_aprovacao);
  return (pendentes || []).map(n => {
    const candidatos = base
      .map(o => { const r = avaliar(n, o); return r ? { ...r, usuario: o } : null; })
      .filter(Boolean)
      .sort((a, b) => NIVEIS[a.nivel] - NIVEIS[b.nivel]);
    return { ...n, candidatos, bloqueiaBloco: candidatos.length > 0 };
  });
}

/**
 * O que a mesclagem vai fazer. Devolve `{ copiar, erro }`.
 *
 * ⚠️ Só copia campo que o cadastro ANTIGO não tem. A conta antiga é a que carrega as PCs e
 * as baixas; sobrescrever um dado dela por um do cadastro novo seria perder informação
 * conferida para ganhar informação digitada.
 */
function planoMesclagem(novo, velho) {
  if (!novo || !velho) return { erro: 'Cadastro não encontrado.' };
  if (novo.id === velho.id) return { erro: 'É o mesmo cadastro.' };
  if (!novo.aguardando_aprovacao) return { erro: 'O cadastro novo não está aguardando aprovação.' };
  // ⚠️ A trava que evita o desastre: só se apaga conta SEM histórico.
  if ((novo.pcs || 0) > 0)
    return { erro: `Este cadastro já tem ${novo.pcs} PC(s) vinculada(s) e não pode ser excluído. ` +
                   `Não é um cadastro duplicado — aprove-o normalmente.` };

  const copiar = {};
  if (!digitos(velho.cpf) && digitos(novo.cpf)) copiar.cpf = novo.cpf;
  if (!velho.email && novo.email)               copiar.email = novo.email;
  if (!velho.telefone && novo.telefone)         copiar.telefone = novo.telefone;
  return { copiar, erro: null };
}

module.exports = { avaliar, analisar, planoMesclagem, norm, digitos };
