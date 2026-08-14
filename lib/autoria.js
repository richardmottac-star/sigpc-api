// CAMINHO: sigpc-api/lib/autoria.js
//
// AUTORIA DUPLA — o trabalho é do analista, a execução é de quem clicou.
// Especificação do Richard, 14/08/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// O PROBLEMA QUE ISTO RESOLVE
// Até 13/08 os dois papéis coincidiam: quem executava era o dono. Por isso
// `parcela_historico.analista_id` significa DUAS coisas conforme a rota — o dono em
// `parecer`/`situacao`/`ci`, o executor em `devolucao_tr`/`estorno`. Lendo o histórico não
// dava para saber qual dos dois o número era.
//
// Com o superadmin agindo pela conta do analista, os papéis se separam de vez:
//   analista_id   = o DONO       — de quem é o trabalho, e a produtividade
//   executado_por = o EXECUTOR   — quem clicou
//
// ⚠️ `executado_por` fica NULO quando o dono executou. Nulo quer dizer "foi ele mesmo".
// Preencher sempre pareceria mais completo e tiraria o sinal: o que importa achar é a linha
// em que os dois DIFEREM.
// ─────────────────────────────────────────────────────────────────────────────

// O rótulo que aparece na tela e no histórico. Vem do Richard, e é uma frase, não um cargo
// solto: quem lê a trilha meses depois precisa entender sem manual.
const ROTULO_TECNICO = 'Richard — técnico do sistema';

/**
 * Quem pode executar pela conta de outro?
 *
 * ⚠️ SÓ SUPERADMIN, e conferido contra o perfil lido no BANCO — nunca contra o corpo do
 * pedido. Sem isto, qualquer analista mandaria `executado_por` e gravaria no nome de outro:
 * é o mesmo buraco que a troca de senha de 11/08 fechou, e este é o campo que a CGE lê.
 */
function podeExecutarPorOutro(quem) {
  return !!quem && quem.perfil === 'superadmin';
}

/**
 * Resolve o par (dono, executor) de uma ação.
 *
 * @param quem      o usuário autenticado, lido do BANCO
 * @param donoPedido o `analista_id` que o corpo do pedido declara
 * @returns {{ok, erro, analista_id, executado_por, porOutro}}
 */
function resolver(quem, donoPedido) {
  const dono = donoPedido == null || donoPedido === '' ? null : parseInt(donoPedido);
  if (!quem) return { ok: false, erro: 'Usuário não identificado.' };
  if (dono == null || Number.isNaN(dono)) return { ok: false, erro: 'analista_id é obrigatório.' };

  // O caso normal: a pessoa trabalhando na própria carteira.
  if (String(dono) === String(quem.id))
    return { ok: true, analista_id: dono, executado_por: null, porOutro: false };

  if (!podeExecutarPorOutro(quem))
    return { ok: false, erro: 'Você não pode registrar ação no nome de outro analista.' };

  return { ok: true, analista_id: dono, executado_por: quem.id, porOutro: true };
}

/**
 * O sufixo que vai na `observacao` do histórico quando a ação foi feita por outro.
 *
 * ⚠️ Vai no TEXTO além da coluna, e não em vez dela. A coluna serve para CONSULTAR ("o que
 * o Richard executou"); o texto serve para quem abre uma linha solta e precisa entender.
 * Só a coluna repetiria o erro do `registrado_por`, que é nome em texto livre e por isso
 * nunca respondeu a pergunta da CGE.
 */
function marcaObservacao(res, nomeExecutor) {
  if (!res || !res.porOutro) return '';
  return ` · executado por ${nomeExecutor || ROTULO_TECNICO} (${ROTULO_TECNICO})`;
}

/** Junta a observação original com a marca, sem deixar " · " solto quando não há texto. */
function observacaoCom(observacao, res, nomeExecutor) {
  const base = (observacao ?? '').toString().trim();
  const marca = marcaObservacao(res, nomeExecutor);
  if (!marca) return base || null;
  return (base ? base + marca : marca.replace(/^ · /, '')) || null;
}

module.exports = { ROTULO_TECNICO, podeExecutarPorOutro, resolver, marcaObservacao, observacaoCom };
