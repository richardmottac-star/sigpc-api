// CAMINHO: sigpc-api/lib/correcao.js
//
// CORRIGIR A SITUAÇÃO DE UMA PARCIAL (A) e PUXAR DE VOLTA DO CONTROLE INTERNO (B).
// Especificação do Richard, 18/08/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// AS DUAS AÇÕES, E O QUE ELAS TÊM EM COMUM
//
//   A) corrigir situação — tira do status atual e põe em outro. Se desfizer a baixa, a PC
//      SAI DA PRODUTIVIDADE.
//   B) puxar do C.I.     — desfaz o encaminhamento que a própria pessoa fez, sem passar pelo
//      C.I. Desfaz a baixa e sai da produtividade.
//
// As duas exigem MOTIVO (texto livre, obrigatório) e as duas gravam em `parcela_historico`
// com autor, data, hora e motivo — a auditoria da CGE depende disso.
//
// ⚠️ "SAIR DA PRODUTIVIDADE" EXIGE MEXER EM QUATRO COLUNAS, NÃO EM UMA. Medido em 18/08:
// existem TRÊS contagens de produtividade no sistema e elas não concordam.
//
//   `GET /prestacoes_contas/produtividade` conta por `data_baixa` + `estornada`, e NÃO olha
//   `baixada` nem `status`. A tela Produtividade (`prodCarregar`) conta `status='baixada'`,
//   e não olha `estornada`.
//
// Logo: zerar `baixada` sem marcar `estornada` deixa a PC contando na rota; marcar
// `estornada` sem mexer no `status` deixa a PC contando na tela. `SQL_TIRAR_DA_PRODUTIVIDADE`
// mexe nas quatro de uma vez, e é a ÚNICA porta para isso neste arquivo.
//
// ⚠️ `data_baixa` É PRESERVADA de propósito — é o que a rota cumulativa lê para saber o que
// valia em cada data (`estornada = false OR data_estorno > corte`). Apagá-la reescreveria o
// passado dos relatórios já emitidos.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ A CHAVE É `codigo_pc`. NUNCA `parcial_num` — decisão do Richard, 18/08/2026.
//
// A PC final aparece com QUATRO grafias de `parcial_num` no banco ('FINAL' 986, 'Final' 39,
// 'final' 1, e '1' em CINCO casos). Nesses cinco, agrupar por `parcial_num` arrastaria a
// parcial 1 inteira junto com a final. `alvoDaAcao()` resolve isto: a final anda SOZINHA, e
// a parcial leva as irmãs dela **excluindo qualquer final**.

const PARCEIRA = require('./autoria');

// As situações de destino que a correção aceita. São as mesmas quatro do acompanhamento
// (`SITUACOES_VALIDAS` do server) mais 'Livre' — porque corrigir uma baixa feita por engano
// muitas vezes é devolver a parcial ao estado de quem ainda não começou.
const DESTINOS = ['Livre', 'Em análise', 'Diligência', 'Reanálise', 'Aguardando documentação'];

// O `status` legado correspondente. 'Aguardando documentação' não tem equivalente próprio e
// cai em 'analise', igual ao `SITUACAO_PARA_STATUS` do server — duas tabelas divergiriam.
const DESTINO_PARA_STATUS = {
  'Livre': 'livre',
  'Em análise': 'analise',
  'Diligência': 'diligencia',
  'Reanálise': 'reanalise',
  'Aguardando documentação': 'analise',
};

const MOTIVO_MIN = 10;
const MOTIVO_MAX = 500;

// A origem da recarga de 05/08. Está escrita aqui porque a regra do Richard cita a string:
// "a baixa veio da recarga (origem_baixa='recarga_parcial_20260805')".
const ORIGEM_RECARGA = 'recarga_parcial_20260805';

/**
 * Quem pode agir sozinho sobre a BAIXA desta PC?
 *
 * Regra do Richard, 18/08/2026 — o analista corrige sozinho quando:
 *   1. a baixa foi DELE            (`baixado_por = quem.id`)
 *   2. a baixa veio da RECARGA     (`origem_baixa = 'recarga_parcial_20260805'`)
 *   3. NÃO há autoria registrada   (`baixado_por IS NULL`)
 * Se a baixa foi de OUTRA pessoa IDENTIFICADA, ele não corrige: abre solicitação (frente D).
 *
 * ⚠️ O TÉCNICO DO SISTEMA PASSA SEM RESTRIÇÃO, e é o `perfilEfetivo` que decide isso — não
 * `u.perfil`. No papel analista o superadmin É analista, inclusive aqui: se ele passasse
 * pelo perfil do cadastro, trocar de papel deixaria de significar coisa alguma.
 *
 * @returns {{pode:boolean, viaSolicitacao:boolean, motivo:string|null}}
 */
function podeCorrigirBaixa(perfilEfetivo, quemId, pc) {
  if (perfilEfetivo === 'superadmin') return { pode: true, viaSolicitacao: false, motivo: null };
  if (!pc) return { pode: false, viaSolicitacao: false, motivo: 'PC não encontrada.' };

  if (pc.baixado_por == null)                            // caso 3
    return { pode: true, viaSolicitacao: false, motivo: null };
  if (pc.origem_baixa === ORIGEM_RECARGA)                // caso 2
    return { pode: true, viaSolicitacao: false, motivo: null };
  if (String(pc.baixado_por) === String(quemId))         // caso 1
    return { pode: true, viaSolicitacao: false, motivo: null };

  return {
    pode: false, viaSolicitacao: true,
    motivo: 'A baixa desta parcial foi registrada por outra pessoa. '
          + 'Peça a correção ao coordenador do seu grupo.',
  };
}

/**
 * ⚠️ O C.I. JÁ SE MANIFESTOU SOBRE ESTA PC?  (26/08/2026)
 *
 * É a única pergunta que separa "encaminhei por engano, quero desfazer" de "o C.I. trabalhou
 * nisto". `ci_situacao` responde as duas em uma coluna:
 *
 *   | `ci_situacao`  | o que houve                          | `puxar_ci` |
 *   |----------------|--------------------------------------|------------|
 *   | `NULL`         | nunca foi encaminhada                | já recusava (`enviado_ci !== true`) |
 *   | `na_fila`      | encaminhada, o C.I. ainda não olhou  | **continua podendo** — é o caso para o qual a ação existe |
 *   | `com_analista` | o C.I. deu parecer e devolveu        | **BLOQUEIA** |
 *   | `encerrado`    | o C.I. encerrou (ou é C.I. histórico)| **BLOQUEIA** |
 *
 * Medido em 26/08, no acervo inteiro: `enviado_ci = true` ⟺ `ci_situacao IS NOT NULL`, sem
 * uma linha de exceção (11.527 · 1.392 · 2 · 1.737). Logo bloquear por `ci_situacao` **não
 * muda nada** para PC que nunca foi encaminhada — ela já não chegava aqui.
 *
 * ⚠️ POR QUE ISTO IMPORTA. `SQL_PUXAR_CI` derruba `baixada`, `enviado_ci` e `parecer_tipo`,
 * marca `estornada` e TIRA a PC da produtividade. Nas 1.737 encerradas, `enviado_ci` é
 * `true` e `enviado_ci_por` é NULO (vieram da carga de 16/08) — então o `WHERE enviado_ci =
 * true` as alcançava e o caso 3 de baixo deixava a própria analista passar. Um clique
 * apagaria a produtividade de um trabalho que o C.I. já aprovou. Ninguém veria erro nenhum.
 *
 * ⚠️ E A PORTA CERTA PARA ESSES CASOS AGORA EXISTE: `POST /ci/reabrir`, que devolve a PC ao
 * analista sem tocar na baixa. A recusa daqui aponta para ela.
 */
function ciJaSeManifestou(pc) {
  return pc?.ci_situacao === 'com_analista' || pc?.ci_situacao === 'encerrado';
}

/**
 * Quem pode puxar esta PC de volta do Controle Interno?
 *
 * Regra do Richard: "o analista desfaz o encaminhamento que ELE MESMO fez". Se foi de outra
 * pessoa, vira solicitação.
 *
 * ⚠️ SEM AUTORIA REGISTRADA (`enviado_ci_por IS NULL`) O ANALISTA PASSA — é a mesma leitura
 * do caso 3 de `podeCorrigirBaixa`, e não é detalhe: são **1.745 das 2.671** PCs no C.I. que
 * não têm autor recuperável (o backfill de 18/08 alcançou 926). Exigir solicitação nelas
 * mandaria dois terços do C.I. para a fila dos três coordenadores no primeiro dia, por um
 * dado que nunca existiu — não por uma decisão de coordenação.
 */
function podePuxarCi(perfilEfetivo, quemId, pc) {
  // ⚠️ ANTES DO SUPERADMIN, E ANTES DE TUDO. Esta recusa não é sobre QUEM pede — é sobre a PC
  // não ter mais o que desfazer. O superadmin sai isento em toda parte do sistema; aqui a
  // isenção o deixaria apagar a produtividade de uma analista por um caminho que existe para
  // consertar engano de encaminhamento. Pôr a conferência depois do `return` dele seria
  // fechar a porta e deixar a chave na fechadura.
  if (ciJaSeManifestou(pc))
    return {
      pode: false, viaSolicitacao: false,
      motivo: pc.ci_situacao === 'encerrado'
        ? 'O Controle Interno já encerrou esta parcial — ela não pode ser puxada de volta. '
        + 'Para devolvê-la ao analista, o C.I. usa "Reabrir no C.I.", que não desfaz a baixa.'
        : 'O Controle Interno já deu parecer nesta parcial e a devolveu ao analista — '
        + 'ela não pode ser puxada de volta. Responda ao C.I. pelo cartão da parcela.',
    };

  if (perfilEfetivo === 'superadmin') return { pode: true, viaSolicitacao: false, motivo: null };
  if (!pc) return { pode: false, viaSolicitacao: false, motivo: 'PC não encontrada.' };

  if (pc.enviado_ci !== true)
    return { pode: false, viaSolicitacao: false, motivo: 'Esta parcial não está no Controle Interno.' };
  if (pc.enviado_ci_por == null) return { pode: true, viaSolicitacao: false, motivo: null };
  if (String(pc.enviado_ci_por) === String(quemId)) return { pode: true, viaSolicitacao: false, motivo: null };

  return {
    pode: false, viaSolicitacao: true,
    motivo: 'O encaminhamento ao Controle Interno foi feito por outra pessoa. '
          + 'Peça a correção ao coordenador do seu grupo.',
  };
}

/** Valida o motivo. Devolve a mensagem de erro, ou null. */
function validarMotivo(texto) {
  const m = (texto ?? '').toString().trim();
  if (!m) return 'Escreva o motivo — ele fica no histórico e a CGE lê.';
  if (m.length < MOTIVO_MIN) return `O motivo precisa de ao menos ${MOTIVO_MIN} caracteres.`;
  if (m.length > MOTIVO_MAX) return `O motivo passa de ${MOTIVO_MAX} caracteres.`;
  return null;
}

/** Valida a situação de destino. Devolve a mensagem de erro, ou null. */
function validarDestino(destino) {
  if (!destino) return 'Escolha para qual situação a parcial vai.';
  if (!DESTINOS.includes(destino)) return `Situação inválida. Use uma de: ${DESTINOS.join(', ')}.`;
  return null;
}

/**
 * QUAIS PCs a ação alcança, a partir de UMA `codigo_pc`.
 *
 * ⚠️ A FINAL ANDA SOZINHA. Ela é uma unidade de produtividade própria (relatório de
 * conclusão, sem valor financeiro) e, em 5 PCs do banco, divide `parcial_num = '1'` com a
 * parcial 1 da mesma TR. Agrupar por `parcial_num` ali corrigiria a parcial junto com a
 * final, e ninguém pediu isso.
 *
 * ⚠️ E A PARCIAL EXCLUI AS FINAIS, pelo mesmo motivo, do outro lado.
 *
 * Recebe a linha da PC pedida e a lista de irmãs já carregada; devolve os `codigo_pc`.
 */
function alvoDaAcao(pc, irmas) {
  if (!pc) return [];
  if (pc.tipo === 'final') return [pc.codigo_pc];
  return (irmas || [])
    .filter(x => x.tipo !== 'final')
    .map(x => x.codigo_pc);
}

/**
 * TIRAR DA PRODUTIVIDADE — as quatro colunas, de uma vez.
 *
 * ⚠️ NÃO APAGA `data_baixa`. Ver o cabeçalho: a produtividade cumulativa lê
 * `(estornada = false OR data_estorno > corte)` para saber o que valia em cada data, e
 * apagar a data reescreveria relatório já emitido.
 *
 * ⚠️ `parecer_tipo` VIRA NULL. Uma parcial que voltou para "Em análise" com um parecer
 * pendurado mostra o selo verde do parecer ao lado do rótulo de análise — e o `pPasso` da
 * tela leria passo 2, oferecendo o botão do C.I. numa parcial que não está baixada.
 */
const SQL_TIRAR_DA_PRODUTIVIDADE = `
  UPDATE prestacoes_contas
     SET baixada        = false,
         status         = $2,
         situacao_atual = $3,
         estornada      = true,
         data_estorno   = NOW(),
         motivo_estorno = $4,
         estornado_por  = $5,
         parecer_tipo   = NULL,
         dt_situacao    = NOW(),
         obs_situacao   = $4,
         baixado_por    = NULL,
         atualizado_em  = NOW()
   WHERE codigo_pc = ANY($1)
   RETURNING codigo_pc, tr, parcial_num, setorial_id`;

/**
 * Corrigir a situação SEM desfazer baixa — quando a parcial já estava aberta.
 *
 * ⚠️ SEM `estornada`/`data_estorno` AQUI. Marcar estorno numa PC que nunca foi baixada
 * inventa um evento que não houve — é a mesma correção de 16/08 no `POST /parcela/estornar`,
 * onde o `AND baixada = true` entrou por isso.
 */
const SQL_SO_SITUACAO = `
  UPDATE prestacoes_contas
     SET status         = $2,
         situacao_atual = $3,
         dt_situacao    = NOW(),
         obs_situacao   = $4,
         atualizado_em  = NOW()
   WHERE codigo_pc = ANY($1) AND baixada = false
   RETURNING codigo_pc, tr, parcial_num, setorial_id`;

/**
 * PUXAR DE VOLTA DO C.I. — limpa o ciclo E desfaz a baixa.
 *
 * ⚠️ AQUI A BAIXA CAI, e é a única porta do sistema em que isso acontece por causa do C.I.
 * `lib/ci.js` diz, com todas as letras, que NADA no ciclo toca `baixada`, `data_baixa` ou
 * `enviado_ci` — e continua verdade: aquele arquivo trata do ciclo NORMAL (de_acordo /
 * ressalva), onde a baixa se sustenta qualquer que seja o desfecho.
 *
 * Isto é outra coisa: o Richard definiu que puxar de volta é desfazer um ERRO DE
 * ENCAMINHAMENTO — "não houve relação CI-analista". Por isso `enviado_ci` volta a false,
 * `dt_envio_ci` é apagada e a PC sai da produtividade: o evento não deveria ter existido.
 *
 * ⚠️ `ci_rodada` VOLTA A ZERO junto. Deixá-la em 1 faria a próxima ida ao C.I. começar na
 * rodada 2, e a conversa de `ci_mensagem` (que grava a rodada lida da PC) nasceria
 * desalinhada com o que a tela mostra.
 *
 * ⚠️ O `WHERE` GANHOU `ci_situacao` EM 26/08/2026, e é a segunda tranca da mesma porta.
 * `enviado_ci = true` sozinho alcançava as 1.737 PCs que o C.I. já encerrou — ver
 * `ciJaSeManifestou`. A guarda mora lá, na função que a rota e a tela consultam; aqui está a
 * trava do banco, para o caso de um caminho novo esquecer de perguntar. É a mesma escolha do
 * `AND baixada = true` que entrou no `POST /parcela/estornar` em 16/08.
 *
 * ⚠️ E É `IS NULL OR = 'na_fila'`, NÃO `= 'na_fila'` seco. Hoje `enviado_ci = true` implica
 * `ci_situacao IS NOT NULL` em 14.658 de 14.658 linhas, então a diferença não muda número
 * nenhum. Ela existe para o dia em que mudar: uma PC encaminhada com `ci_situacao` nula é
 * uma PC que o C.I. **não** tocou, e recusá-la seria mudar o comportamento de um caso que
 * este ciclo não veio mudar.
 */
const SQL_PUXAR_CI = `
  UPDATE prestacoes_contas
     SET enviado_ci      = false,
         dt_envio_ci     = NULL,
         enviado_ci_por  = NULL,
         ci_situacao     = NULL,
         ci_rodada       = 0,
         ci_encerrado_em = NULL,
         ci_encerrado_por = NULL,
         parecer_ci      = NULL,
         baixada         = false,
         status          = 'analise',
         situacao_atual  = 'Em análise',
         estornada       = true,
         data_estorno    = NOW(),
         motivo_estorno  = $2,
         estornado_por   = $3,
         parecer_tipo    = NULL,
         baixado_por     = NULL,
         dt_situacao     = NOW(),
         obs_situacao    = $2,
         atualizado_em   = NOW()
   WHERE codigo_pc = ANY($1) AND enviado_ci = true
     AND (ci_situacao IS NULL OR ci_situacao = 'na_fila')
   RETURNING codigo_pc, tr, parcial_num, setorial_id`;

// Carrega a PC pedida e as irmãs dela, com lock. A chave de entrada é SEMPRE `codigo_pc`;
// `tr` e `parcial_num` saem da própria linha, nunca do corpo do pedido — o navegador não
// tem como provar nenhum dos dois.
const SQL_CARREGAR_ALVO = `
  SELECT codigo_pc, tr, parcial_num, setorial_id, tipo, baixada, status, situacao_atual,
         parecer_tipo, origem_baixa, baixado_por, analista_id, enviado_ci, enviado_ci_por,
         ci_situacao, data_baixa, dt_envio_ci
    FROM prestacoes_contas
   WHERE codigo_pc = $1
   FOR UPDATE`;

const SQL_CARREGAR_IRMAS = `
  SELECT codigo_pc, tipo, baixada, enviado_ci
    FROM prestacoes_contas
   WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3
   ORDER BY codigo_pc
   FOR UPDATE`;

module.exports = {
  DESTINOS, DESTINO_PARA_STATUS, MOTIVO_MIN, MOTIVO_MAX, ORIGEM_RECARGA,
  podeCorrigirBaixa, podePuxarCi, ciJaSeManifestou, validarMotivo, validarDestino, alvoDaAcao,
  SQL_TIRAR_DA_PRODUTIVIDADE, SQL_SO_SITUACAO, SQL_PUXAR_CI,
  SQL_CARREGAR_ALVO, SQL_CARREGAR_IRMAS,
  _autoria: PARCEIRA,
};
