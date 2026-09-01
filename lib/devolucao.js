// CAMINHO: sigpc-api/lib/devolucao.js
//
// DEVOLVER A TR AO ESTOQUE — só superadmin.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO EXISTE, SE JÁ EXISTIA
//
// A devolução nasceu em 30/07/2026 no `index.html` (`abrirDevM`/`confDevM`) e nunca foi
// removida — foi PERDIDA DE VISTA. Em 05/08 a Minha Planilha foi reconstruída por parcial,
// a tabela antiga saiu inteira e levou o botão junto; o modal e as funções ficaram, e restou
// um botão só, na tela Estoque. Ninguém notou porque ele continuou aparecendo — na outra tela.
//
// O que existia tinha três defeitos, e os três são a razão desta biblioteca:
//
//   1. UM PATCH POR PC, EM SÉRIE, SEM TRANSAÇÃO. Uma TR tem até 83 PCs. Se a rede caísse no
//      meio, metade voltava ao estoque e metade ficava com o analista — o estado que a coluna
//      `conflito` existe para impedir. O próprio código já previa: "ok/83 devolvidas".
//      Agora é UMA transação: ou volta a TR inteira, ou não volta nada.
//
//   2. A GUARDA MORAVA NO index.html (`if(U.perfil !== 'superadmin')`). É a armadilha 9:
//      contornável pelo DevTools, e o servidor aceitava `analista_id: null` de quem pedisse.
//      Agora o perfil vem do BANCO, pelo id de quem pede.
//
//   3. NÃO DEIXAVA RASTRO. Quem devolveu, quando e por quê não ficavam em lugar nenhum.
//      Agora vai para `parcela_historico` e o analista é avisado pelo sino.
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ A BAIXA NUNCA É TOCADA. `baixada`, `data_baixa`, `enviado_ci`, `parecer_tipo` e as
// colunas `ci_*` ficam como estão. PC baixada NÃO volta ao estoque: a produtividade do
// analista foi conquistada e continua registrada. Há teste que falha se o UPDATE daqui
// mencionar qualquer uma delas — a mesma trava que o ciclo do C.I. tem.

const MOTIVOS = [
  'Não será analisada por mim',
  'Redistribuição de carga',
  'Documentação incompleta',
  'Requer complementação do beneficiário',
  'Outro',
];

const DETALHE_MIN = 10;
const DETALHE_MAX = 200;

// ⚠️ SÓ ESTAS DUAS BLOQUEIAM. 'encerrado' é o C.I. que já decidiu: a PC foi para o histórico
// e não espera mais nada de ninguém. Bloquear por ela travaria toda TR que um dia passou
// pelo Controle Interno — que é o caminho normal, não a exceção.
const CI_ABERTO = ['na_fila', 'com_analista'];

/**
 * Valida o que a tela manda. Devolve a mensagem de erro, ou null.
 *
 * O motivo é OBRIGATÓRIO (decisão do Richard, 12/08): devolver sem dizer por quê deixa o
 * analista sem explicação de por que a TR sumiu da planilha dele. Mesma regra da
 * justificativa do estorno e da ressalva do C.I.
 */
function validar(b) {
  if (!b) return 'Nada informado.';
  if (!b.tr || !String(b.tr).trim()) return 'tr é obrigatório.';
  if (!b.usuario_id) return 'usuario_id é obrigatório.';

  const motivo = (b.motivo ?? '').toString().trim();
  if (!motivo) return 'Selecione o motivo da devolução.';
  if (!MOTIVOS.includes(motivo)) return 'Motivo inválido.';

  // 'Outro' sem explicação gravaria um registro que não explica nada — e registrar o porquê
  // é metade do motivo de esta rota existir.
  if (motivo === 'Outro') {
    const d = (b.detalhe ?? '').toString().trim();
    if (!d) return 'Descreva o motivo.';
    if (d.length < DETALHE_MIN) return `Descreva com ao menos ${DETALHE_MIN} caracteres.`;
    if (d.length > DETALHE_MAX) return `A descrição passa de ${DETALHE_MAX} caracteres.`;
  }
  return null;
}

/** O texto que vai para o histórico e para o sino. */
function motivoTexto(b) {
  const motivo = (b.motivo ?? '').toString().trim();
  const detalhe = (b.detalhe ?? '').toString().trim();
  return motivo === 'Outro' && detalhe ? `Outro: ${detalhe}` : motivo;
}

/**
 * A foto da TR: o que volta, o que fica e o que bloqueia.
 *
 * Serve a DUAS chamadas — a prévia que o modal desenha e a conferência de dentro da
 * transação. É de propósito: se a prévia calculasse por um caminho e a gravação por outro,
 * o modal diria 71 e o banco devolveria outro número.
 */
function resumir(pcs) {
  const naoBaixadas = pcs.filter(p => !p.baixada);
  const baixadas    = pcs.filter(p => p.baixada);

  // ⚠️ O C.I. É CONTADO SOBRE A TR INTEIRA, INCLUSIVE NAS BAIXADAS.
  //
  // Medido em 12/08/2026: as 13 PCs no ciclo do C.I. são TODAS `baixada = true`. Não é
  // coincidência — é a regra de negócio: "o analista faz o parecer no SIGEF e encaminha ao
  // C.I., e isso JÁ CONTA COMO BAIXA".
  //
  // A primeira versão desta função procurava C.I. só entre as NÃO baixadas, e por isso
  // nunca encontrava nada: a trava existia e jamais disparava. Só apareceu ao rodar a rota
  // contra o banco de verdade — o dublê validou a forma, não a realidade.
  //
  // Contar sobre a TR inteira é o que o Richard pediu ao escolher a opção B: bloquear
  // "enquanto houver PC no C.I.". E é o que faz sentido — devolver uma TR cuja conversa com
  // o Controle Interno está aberta entrega ao próximo analista uma TR com pendência que não
  // é dele e que ele não pode responder.
  const noCi = pcs.filter(p => CI_ABERTO.includes(p.ci_situacao));

  // Na lista do que volta, o C.I. é excluído por garantia. Hoje ele já cairia fora por ser
  // baixado; se um dia houver PC no C.I. sem baixa, ela continua não voltando — devolvê-la
  // deixaria a resposta do C.I. sem dono.
  const podemVoltar = naoBaixadas.filter(p => !CI_ABERTO.includes(p.ci_situacao));

  return {
    total: pcs.length,
    baixadas: baixadas.length,
    no_ci: noCi.length,
    devolver: podemVoltar.length,
    codigos: podemVoltar.map(p => p.codigo_pc),
    codigos_ci: noCi.map(p => p.codigo_pc),
    analista_id: pcs.find(p => p.analista_id)?.analista_id ?? null,
    analista_nome: pcs.find(p => p.analista_nome)?.analista_nome ?? null,
  };
}

/**
 * Pode devolver? Devolve a mensagem do impedimento, ou null.
 *
 * ⚠️ PC NO CICLO DO C.I. BLOQUEIA A TR INTEIRA — decisão do Richard, 12/08 (opção B).
 *
 * A alternativa era devolver o resto e deixar as do C.I. paradas. Cria um órfão: a PC
 * continua `na_fila` esperando o técnico, mas o `analista_id` sumiu junto com a TR. Se o
 * C.I. decidir 'ressalva', a devolução vai PARA NINGUÉM — e responder é justamente o que a
 * ressalva pede. É a mesma classe de defeito que 12/08 inteiro corrigiu, quando `enviado_ci`
 * e `ci_situacao` respondiam à mesma pergunta.
 */
function impedimento(r) {
  if (r.no_ci > 0) {
    const n = r.no_ci;
    return `${n} PC${n > 1 ? 's estão' : ' está'} no ciclo do Controle Interno. ` +
           `Resolva ${n > 1 ? 'essas PCs' : 'essa PC'} antes de devolver a TR — devolver agora ` +
           `deixaria ${n > 1 ? 'as respostas' : 'a resposta'} do C.I. sem dono.`;
  }
  if (r.devolver === 0) {
    return r.total > 0 && r.baixadas === r.total
      ? `Nada a devolver: todas as ${r.total} PCs desta TR já foram baixadas.`
      : 'Nada a devolver nesta TR.';
  }
  return null;
}

// ⚠️ NÃO MENCIONA baixada, data_baixa, enviado_ci, parecer_tipo NEM ci_*. Há teste que lê
// esta string e falha se alguma delas aparecer. O `dt_assumida` volta a NULL porque a TR
// deixou de ter dono — mas `dt_inicio_analise` FICA: o relógio da análise já correu, e
// zerá-lo daria ao próximo analista um prazo que não é o real.
// ⚠️ `situacao_atual = NULL` ENTROU EM 01/09/2026, e foi um defeito medido: a
// 2021TR000693 voltou ao estoque pelo desfazer de um repasse — sem dono, status `livre` —
// e continuou mostrando "Em análise" na tela. A situação é o estado do TRABALHO, e uma PC
// que voltou ao estoque não tem trabalho em curso: uma TR que nunca foi assumida tem
// `situacao_atual` NULO em 6.084 PCs. Deixar a frase para trás fazia a linha do estoque
// dizer que alguém está analisando o que não tem dono.
//
// ⚠️ E VALE PARA OS DOIS CAMINHOS — a devolução do superadmin e o desfazer do repasse —
// porque é a MESMA pergunta: o que é uma PC no estoque. Escrever a limpeza só no desfazer
// criaria a segunda definição de livre que este SQL existe para não ter.
const SQL_DEVOLVER = `
  UPDATE prestacoes_contas
     SET status = 'livre',
         analista_id = NULL,
         analista_nome = NULL,
         dt_assumida = NULL,
         situacao_atual = NULL,
         atualizado_em = NOW()
   WHERE codigo_pc = ANY($1)
  RETURNING codigo_pc`;

module.exports = {
  MOTIVOS, CI_ABERTO, DETALHE_MIN, DETALHE_MAX, SQL_DEVOLVER,
  validar, motivoTexto, resumir, impedimento,
};
