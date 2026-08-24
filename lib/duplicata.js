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

// ⚠️ O rótulo curto do acervo tem UM dono: `lib/assumir.js`. Este arquivo o CONSULTA para
// decidir se pode trocar o nome do cadastro — nunca para recalcular a regra por conta própria.
// Uma segunda cópia do mapa de nomes é como nasceu o defeito do `MAPA_PLAN_EST` na tela.
const assumir = require('./assumir');

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
 * O nome como ele deve aparecer no cadastro.
 *
 * ⚠️ SÓ MEXE NA CAIXA, E SÓ QUANDO NÃO HÁ NENHUMA MINÚSCULA. O formulário do Primeiro Acesso
 * não impede o CAPS LOCK, e a Scheila (21/08/2026) digitou "SCHEILA ZIMMERMANN FURTADO". Dos
 * 55 cadastros, 2 estão em maiúsculas e 53 em caixa mista — copiar o texto como veio deixaria
 * o nome dela gritando em toda tela do sistema.
 *
 * ⚠️ E NÃO É ESTÉTICA: quem monta o rótulo do acervo é `assumir.nomeCurto`, que faz
 * `split(' ')[0]`. Com o nome em caixa alta, a próxima TR que ela assumisse gravaria
 * "SCHEILA" nas PCs, contra as 161 que já dizem "Scheila" — o analista com dois rótulos no
 * próprio acervo, que é a armadilha 1 do CLAUDE.md.
 *
 * Nome que já vem em caixa mista passa INTACTO: "Ana Letícia Wloch de Oliveira" é como a
 * pessoa escreveu, e não cabe a este código reescrever.
 */
const PARTICULAS = ['de', 'da', 'do', 'das', 'dos', 'e', 'di', 'du', 'del', 'van', 'von'];

function nomeExibicao(s) {
  const n = String(s || '').replace(/\s+/g, ' ').trim();
  if (!n) return '';
  // Tem alguma minúscula? Então a pessoa escolheu a caixa. Não se toca.
  if (/[a-zà-ÿ]/.test(n)) return n;
  return n.toLowerCase().split(' ')
    .map((p, i) => (i > 0 && PARTICULAS.includes(p)) ? p : p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * O nome completo pode substituir o curto? Devolve `{ ok, nome, motivo }`.
 *
 * ⚠️ A CONDIÇÃO É O RÓTULO DO ACERVO, NÃO O NOME EM SI (24/08/2026).
 *
 * `prestacoes_contas.analista_nome` guarda o nome CURTO — "Scheila", "Marlene", "Ana Leticia" —
 * e quem o escreve é `assumir.nomeCurto(usuarios.nome)`, no ato de assumir a TR. Trocar
 * `usuarios.nome` sem olhar isso muda o rótulo das PCs FUTURAS e deixa o acervo da pessoa com
 * dois nomes. Nenhuma consulta do sistema junta `usuarios.nome` com `analista_nome` — medido
 * em 24/08 —, então nada quebra com erro; só passa a mentir na tela, que é pior.
 *
 * Por isso a regra: **o nome só é copiado quando o rótulo curto continua exatamente o mesmo.**
 *   "Scheila"      → "Scheila Zimmermann Furtado"     nomeCurto continua "Scheila"    ✅
 *   "Ana Leticia"  → "Ana Letícia Wloch de Oliveira"  MAPA_NOME devolve "Ana Leticia" ✅
 *   "Claudia"      → "Ana Claudia Carvalho Costa"     viraria "Ana Claudia"           ❌
 *
 * ⚠️ `rotuloAcervo` É O QUE O BANCO DIZ, E VENCE A DEDUÇÃO. Quem passa é a rota, com o
 * `analista_nome` dominante das PCs daquele `analista_id`. Sem ele a função cai em
 * `nomeCurto(velho.nome)`, que é uma DEDUÇÃO — e ela erra justamente nos três casos do
 * `MAPA_NOME`: com o cadastro antigo escrito "Ana Leticia", `nomeCurto` deduz "Ana", enquanto
 * as 149 PCs dela dizem "Ana Leticia". Comparar contra a dedução recusaria uma troca que na
 * verdade CONSERTA o rótulo. Medir o que existe é sempre melhor do que inferir o que deveria.
 *
 * E só troca por nome MAIS COMPLETO: mesclar nunca pode encurtar o que o cadastro já tem.
 */
function planoNome(novo, velho, rotuloAcervo) {
  const n = nomeExibicao(novo && novo.nome);
  const v = String((velho && velho.nome) || '').trim();
  if (!n) return { ok: false, motivo: 'o cadastro novo não tem nome.' };
  if (!v) return { ok: true, nome: n };
  if (norm(n) === norm(v)) return { ok: false, motivo: 'os dois nomes já são o mesmo.' };

  const tn = norm(n).split(' ').filter(Boolean).length;
  const tv = norm(v).split(' ').filter(Boolean).length;
  if (tn <= tv)
    return { ok: false, motivo: `o cadastro antigo já tem o nome mais completo ("${v}").` };

  const acervo = String(rotuloAcervo || '').trim();
  const rotuloHoje = acervo || assumir.nomeCurto(v);
  const rotuloNovo = assumir.nomeCurto(n);
  if (norm(rotuloNovo) !== norm(rotuloHoje))
    return { ok: false, motivo: `mudaria o nome do acervo de "${rotuloHoje}" para "${rotuloNovo}" ` +
                                `nas PCs assumidas daqui pra frente. Para trocar assim, o MAPA_NOME ` +
                                `do lib/assumir.js precisa da entrada nova antes.` };

  return { ok: true, nome: n };
}

/**
 * O que a mesclagem vai fazer. Devolve `{ copiar, naoCopiado, erro }`.
 *
 * ⚠️ Só copia campo que o cadastro ANTIGO não tem. A conta antiga é a que carrega as PCs e
 * as baixas; sobrescrever um dado dela por um do cadastro novo seria perder informação
 * conferida para ganhar informação digitada.
 *
 * ⚠️ AS DUAS EXCEÇÕES — A SENHA E O NOME (24/08/2026, decisão do Richard).
 *
 * A **senha** é copiada SEMPRE, por cima da que o cadastro antigo tiver. Ela é a única coisa
 * do cadastro novo que a pessoa acabou de escolher e é a única que ela lembra; até 24/08 ela
 * morria no DELETE e a pessoa ficava sem saber como entrar — a Scheila (ids 49 e 73) é o caso
 * que revelou isso. Vai junto `senha_provisoria = false`: obrigar a trocar a senha recém
 * escolhida desfaria o motivo de copiá-la.
 *
 * ⚠️ **E ISSO MUDA O PESO DO BOTÃO MESCLAR.** Antes ele só juntava dados; agora ele entrega o
 * ACESSO da conta antiga — com as PCs e as baixas — a quem sabe a senha do cadastro novo.
 * Mesclar o par errado deixou de ser erro de dado e virou erro de acesso. Quem prova que os
 * dois são a mesma pessoa é o humano que clica, olhando o nível do indício de `avaliar`.
 *
 * O **nome** só é copiado sob a condição do `planoNome` — ver lá.
 */
function planoMesclagem(novo, velho, rotuloAcervo) {
  if (!novo || !velho) return { erro: 'Cadastro não encontrado.' };
  if (novo.id === velho.id) return { erro: 'É o mesmo cadastro.' };
  if (!novo.aguardando_aprovacao) return { erro: 'O cadastro novo não está aguardando aprovação.' };
  // ⚠️ A trava que evita o desastre: só se apaga conta SEM histórico.
  if ((novo.pcs || 0) > 0)
    return { erro: `Este cadastro já tem ${novo.pcs} PC(s) vinculada(s) e não pode ser excluído. ` +
                   `Não é um cadastro duplicado — aprove-o normalmente.` };

  const copiar = {}, naoCopiado = {};
  if (!digitos(velho.cpf) && digitos(novo.cpf)) copiar.cpf = novo.cpf;
  if (!velho.email && novo.email)               copiar.email = novo.email;
  if (!velho.telefone && novo.telefone)         copiar.telefone = novo.telefone;

  // ⚠️ A senha, sempre — mas nunca uma senha VAZIA. Copiar `null` por cima apagaria a senha da
  // conta que fica e trancaria a pessoa do lado de fora, que é o oposto do que se quer aqui.
  if (novo.senha_hash) {
    copiar.senha_hash = novo.senha_hash;
    copiar.senha_provisoria = novo.senha_provisoria === true;
  } else {
    naoCopiado.senha_hash = 'o cadastro novo não tem senha gravada.';
  }

  const pn = planoNome(novo, velho, rotuloAcervo);
  if (pn.ok) copiar.nome = pn.nome;
  else naoCopiado.nome = pn.motivo;

  return { copiar, naoCopiado, erro: null };
}

/**
 * O plano como ele pode ser DITO — para a resposta HTTP e para a tela.
 *
 * ⚠️ `senha_hash` NUNCA sai do servidor (armadilha 8 do CLAUDE.md). Devolver `plano.copiar`
 * cru na resposta entregaria o bcrypt da pessoa a quem chamasse a rota. Aqui o valor vira
 * rótulo; a CHAVE continua lá, que é o que a tela conta e mostra.
 */
function semSenha(copiar) {
  const fora = { ...(copiar || {}) };
  if ('senha_hash' in fora) fora.senha_hash = '(a senha escolhida no Primeiro Acesso)';
  return fora;
}

module.exports = { avaliar, analisar, planoMesclagem, planoNome, nomeExibicao, semSenha, norm, digitos };
