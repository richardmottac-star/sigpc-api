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

// ═════════════════════════════════════════════════════════════════════════════
//  A FOTO DO ESTADO ANTERIOR — e o desfazer do `puxar_ci`.  Richard, 26/08/2026.
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠️ POR QUE A FOTO PRECISOU EXISTIR. Medido em 26/08 contra o banco: das 20 colunas que o
// `SQL_PUXAR_CI` escreve, o `parcela_historico` guardava UMA — o `ci_situacao`, em
// `valor_anterior`. `dt_envio_ci`, `parecer_tipo`, `baixada`, `estornada`, `enviado_ci_por`,
// `ci_rodada`, `baixado_por`, `status` e `situacao_atual` viravam NULL/false sem cópia em
// lugar nenhum. Desfazer era impossível, e refazer à mão gerava `data_baixa` NOVA — a baixa
// de 17/08 da 2023PC002107 virou baixa de 20/08 e mudou de mês na produtividade.
//
// ⚠️ E A DEDUÇÃO NÃO SERVIA COMO SUBSTITUTO — foi medida e reprovada. O evento `ci` anterior
// da mesma parcela quase dá o `parecer_tipo` e o `dt_envio_ci`: 12 das 1.421 PCs puxáveis não
// têm evento `ci` nenhum, o `criado_em` dele diverge do `dt_envio_ci` em 6 casos (até 21 s),
// e 2 parcelas têm `dt_envio_ci` diferente entre PCs irmãs — sendo o histórico por PARCELA.
// Depois da puxada não há como saber em qual caso se está. É a armadilha 19: um candidato só
// esconde a ambiguidade. Por isso a foto guarda VALOR, não pista.
//
// ⚠️ A FOTO É POR `codigo_pc`, e não por parcela. `parcela_historico` é chaveado por
// (tr, parcial_num, setorial_id), mas uma parcela leva até 7 PCs e elas divergem: 2 parcelas
// do acervo já têm `dt_envio_ci` diferente entre irmãs. Uma foto por parcela restauraria o
// valor de uma PC em todas.

/**
 * AS COLUNAS DA FOTO — as 19 que o `puxar_ci` escreve e restaura, mais `data_baixa`.
 *
 * ⚠️ `data_baixa` ENTRA MESMO SEM SER ESCRITA pelo `puxar_ci`. Ela está aqui como PROVA, não
 * como valor a restaurar: se a `data_baixa` de hoje não for a da foto, alguém refez a baixa
 * depois da puxada e o desfazer apagaria trabalho novo. É a assinatura exata do caso real da
 * 2023PC002107. Ver `conferirIntacta`.
 *
 * ⚠️ `atualizado_em` FICA DE FORA DE PROPÓSITO. Ela responde "quando esta linha foi mexida
 * pela última vez", e o desfazer É uma mexida. Restaurá-la faria a linha jurar que ninguém a
 * tocou desde antes da puxada — seria a única coluna da foto a mentir.
 */
const COLUNAS_FOTO = [
  'baixada', 'data_baixa', 'status', 'situacao_atual', 'parecer_tipo', 'baixado_por',
  'enviado_ci', 'dt_envio_ci', 'enviado_ci_por', 'parecer_ci',
  'ci_situacao', 'ci_rodada', 'ci_encerrado_em', 'ci_encerrado_por',
  'estornada', 'data_estorno', 'motivo_estorno', 'estornado_por',
  'dt_situacao', 'obs_situacao',
];

/**
 * A foto, montada NO POSTGRES — `{ "<codigo_pc>": { coluna: valor, … } }`.
 *
 * ⚠️ O JSON É MONTADO PELO BANCO, E NÃO EM JAVASCRIPT, POR CAUSA DA ARMADILHA 18.
 * As nove colunas de data são `timestamp WITHOUT time zone` guardando UTC. O `pg` devolve
 * cada uma como objeto `Date` construído com os componentes LOCAIS do processo — e um
 * `JSON.stringify` nesse `Date` chama `toISOString()`, que SOMA o fuso: a `data_baixa` da
 * carga histórica (`2026-06-30 00:00`) sai como `2026-06-30T03:00:00.000Z`. Gravar isso na
 * foto e devolvê-lo ao banco moveria a baixa em três horas, sem erro nenhum para acusar.
 *
 * O `to_jsonb` do Postgres escreve o relógio de parede que a coluna guarda
 * (`"2026-06-30T00:00:00"`, sem `Z`), e o `::timestamp` do `SQL_RESTAURAR_FOTO` o lê de
 * volta letra por letra. Nenhum fuso entra na conta, nos dois sentidos.
 */
const SQL_FOTO = `
  SELECT jsonb_object_agg(x.codigo_pc, to_jsonb(x) - 'codigo_pc') AS foto
    FROM (SELECT codigo_pc, ${COLUNAS_FOTO.join(', ')}
            FROM prestacoes_contas
           WHERE codigo_pc = ANY($1)
           ORDER BY codigo_pc) x`;

/**
 * RESTAURAR — devolve cada PC ao valor exato da foto, uma coluna por vez.
 *
 * ⚠️ NENHUM `NOW()` EM COLUNA DE DATA ORIGINAL. `dt_envio_ci`, `data_estorno` e `dt_situacao`
 * saem da foto; `data_baixa` nem é tocada. O único `NOW()` é o `atualizado_em`, que é o
 * carimbo de "esta linha acabou de ser mexida" — e ela acabou.
 *
 * ⚠️ `->>` DEVOLVE NULL PARA O `null` DO JSON, que é o que se quer: uma PC cuja
 * `dt_envio_ci` era nula volta a nula, e não a uma data inventada.
 *
 * ⚠️ `ci_rodada` LEVA `COALESCE(…, 0)` porque é a única `NOT NULL` da lista. A foto nunca
 * traria nulo ali — mas se um dia trouxer, o certo é o `DEFAULT` da coluna e não um 500.
 */
const SQL_RESTAURAR_FOTO = `
  UPDATE prestacoes_contas p
     SET baixada          = (e.v->>'baixada')::boolean,
         status           =  e.v->>'status',
         situacao_atual   =  e.v->>'situacao_atual',
         parecer_tipo     =  e.v->>'parecer_tipo',
         baixado_por      = (e.v->>'baixado_por')::integer,
         enviado_ci       = (e.v->>'enviado_ci')::boolean,
         dt_envio_ci      = (e.v->>'dt_envio_ci')::timestamp,
         enviado_ci_por   = (e.v->>'enviado_ci_por')::integer,
         parecer_ci       =  e.v->>'parecer_ci',
         ci_situacao      =  e.v->>'ci_situacao',
         ci_rodada        = COALESCE((e.v->>'ci_rodada')::integer, 0),
         ci_encerrado_em  = (e.v->>'ci_encerrado_em')::timestamp,
         ci_encerrado_por = (e.v->>'ci_encerrado_por')::integer,
         estornada        = (e.v->>'estornada')::boolean,
         data_estorno     = (e.v->>'data_estorno')::timestamp,
         motivo_estorno   =  e.v->>'motivo_estorno',
         estornado_por    =  e.v->>'estornado_por',
         dt_situacao      = (e.v->>'dt_situacao')::timestamp,
         obs_situacao     =  e.v->>'obs_situacao',
         atualizado_em    = NOW()
    FROM jsonb_each($1::jsonb) AS e(k, v)
   WHERE p.codigo_pc = e.k
   RETURNING p.codigo_pc, p.tr, p.parcial_num, p.setorial_id`;

// A linha de puxada a desfazer. `estado_anterior` pode ser nulo — as puxadas anteriores a
// 26/08 não têm foto, e a recusa delas é o ponto (ver `podeDesfazerPuxarCi`).
const SQL_BUSCAR_PUXADA = `
  SELECT id, tr, parcial_num, setorial_id, evento, valor_anterior, analista_id, executado_por,
         observacao, criado_em, estado_anterior
    FROM parcela_historico
   WHERE id = $1`;

// Esta puxada já foi desfeita? A referência mora no `estado_anterior` da própria linha do
// desfazimento — `desfaz_historico_id`. Uma coluna nova só para isso seria uma segunda fonte
// para a mesma resposta, que é o argumento do `autodecidido` em `solicitacao_devolucao`.
const SQL_JA_DESFEITA = `
  SELECT id, criado_em, observacao
    FROM parcela_historico
   WHERE evento = 'desfazer_puxar_ci'
     AND (estado_anterior->>'desfaz_historico_id')::int = $1
   ORDER BY criado_em DESC
   LIMIT 1`;

/**
 * TRAVA as PCs da foto. Só a trava — os VALORES vêm do `SQL_FOTO`, e a razão é medida.
 *
 * ⚠️ NENHUMA CONFERÊNCIA PASSA POR UM `Date` DO JAVASCRIPT. Medido contra o banco em 26/08:
 * o `timestamp` do Postgres guarda MICROSSEGUNDOS (`17:54:23.175269`) e o `Date` do JS só tem
 * MILISSEGUNDOS (`17:54:23.175`). Ler a coluna em JS trunca os três últimos dígitos — e
 * comparar esse valor truncado com o da foto acusava divergência em toda PC cujo microssegundo
 * não fosse zero. Na prova contra o banco, **8 de 39 conferências falharam por isso**, e o
 * efeito em produção seria o pior possível: o desfazer gravaria certo, a conferência posterior
 * diria que não bateu, e o `ROLLBACK` desfaria uma restauração correta. Um desfazer que nunca
 * funciona, sem nenhum erro que aponte para a causa.
 *
 * ⚠️ Os dois lados da comparação saem, portanto, do MESMO `to_jsonb` do Postgres. É a mesma
 * família da armadilha 25: o `Date` que atravessa uma conversão e chega parecendo o original.
 */
const SQL_TRAVAR_PARA_DESFAZER = `
  SELECT codigo_pc
    FROM prestacoes_contas
   WHERE codigo_pc = ANY($1)
   ORDER BY codigo_pc
   FOR UPDATE`;

/**
 * QUEM PODE DESFAZER, E O QUE PRECISA ESTAR NO LUGAR.
 *
 * ⚠️ SÓ SUPERADMIN, e pelo `perfilEfetivo` — no papel analista o técnico não desfaz, como em
 * todo o resto do sistema. Não há caminho por solicitação aqui: o desfazer restaura VALOR
 * GRAVADO, e quem confere se a foto está íntegra é quem administra o sistema.
 *
 * ⚠️ PC SEM FOTO NÃO PODE SER DESFEITA, e a recusa diz isso com todas as letras. As seis
 * puxadas de 20 a 24/08 não têm foto: os valores não foram gravados, e inventá-los seria
 * pior que o buraco — decisão do Richard, 26/08, com a auditoria da CGE em cima. Elas serão
 * refeitas pelas analistas, com data nova.
 *
 * @param {string} perfilEfetivo
 * @param {object|null} linha  a linha de `parcela_historico`
 * @returns {{pode:boolean, motivo:string|null}}
 */
function podeDesfazerPuxarCi(perfilEfetivo, linha) {
  if (perfilEfetivo !== 'superadmin')
    return { pode: false, motivo: 'Só o técnico do sistema desfaz uma puxada do Controle Interno.' };
  if (!linha)
    return { pode: false, motivo: 'Evento não encontrado no histórico.' };
  if (linha.evento !== 'puxar_ci')
    return { pode: false, motivo: `Este evento é "${linha.evento}", e o desfazer é só da puxada do C.I.` };
  if (!linha.estado_anterior || !Object.keys(linha.estado_anterior).length)
    return {
      pode: false,
      motivo: 'Esta puxada é anterior a 26/08/2026 e NÃO TEM FOTO do estado anterior — '
            + 'o parecer, a data de envio ao C.I. e a baixa não foram gravados em lugar nenhum. '
            + 'Desfazer aqui seria inventar valor. A parcial precisa ser refeita pela analista.',
    };
  return { pode: true, motivo: null };
}

/**
 * O relógio de parede da coluna, para MOSTRAR a gente — nunca para comparar.
 *
 * ⚠️ NÃO USE ISTO EM CONFERÊNCIA. O `Date` do JS só tem milissegundos e o `timestamp` do
 * Postgres tem microssegundos: `17:54:23.175269` volta daqui como `17:54:23.175`. Para
 * comparar, os dois lados saem do `SQL_FOTO` — ver `SQL_TRAVAR_PARA_DESFAZER`.
 *
 * ⚠️ USA OS COMPONENTES LOCAIS DE PROPÓSITO, e não `toISOString()`. O `pg` monta o `Date` de
 * um `timestamp WITHOUT time zone` com os componentes locais do processo; ler de volta pelos
 * mesmos componentes é a operação inversa exata, e por isso o resultado não depende do fuso
 * em que o processo roda — Railway em UTC e Windows em Brasília dão a mesma string. O
 * `toISOString()` daria duas diferentes (armadilha 18).
 *
 * ⚠️ E OMITE OS MILISSEGUNDOS QUANDO SÃO ZERO, porque é o que o `to_jsonb` do Postgres faz:
 * `2026-06-30 00:00:00` sai `"2026-06-30T00:00:00"`, sem `.000`. Duas convenções fariam a
 * conferência acusar divergência onde o valor é o mesmo.
 */
function textoData(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  const p = (n, c = 2) => String(n).padStart(c, '0');
  const ms = v.getMilliseconds();
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
       + `T${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
       + (ms ? `.${p(ms, 3)}` : '');
}

/**
 * A PARCIAL AINDA ESTÁ COMO A PUXADA A DEIXOU?
 *
 * ⚠️ ESTA É A CONFERÊNCIA QUE IMPEDE O DESFAZER DE APAGAR TRABALHO NOVO. Entre a puxada e o
 * desfazimento a analista pode ter refeito o parecer, reencaminhado ao C.I. ou recebido o
 * caso de volta. Restaurar por cima disso devolveria a PC a um passado que já não é o dela —
 * e apagaria a baixa NOVA, que é justamente o dano que este ciclo veio evitar.
 *
 * Confere os oito valores que o `SQL_PUXAR_CI` escreve de forma determinística, mais a
 * `data_baixa` da foto. A `data_baixa` é a mais decisiva: ela é o único campo que a puxada
 * NÃO toca, então divergir só é possível se alguém baixou de novo. Foi exatamente o que
 * aconteceu com a 2023PC002107 — baixa de 17/08 virou 20/08.
 *
 * ⚠️ OS DOIS LADOS SÃO OBJETOS VINDOS DO `SQL_FOTO`, e nunca linhas lidas em JavaScript —
 * ver `SQL_TRAVAR_PARA_DESFAZER` para o microssegundo que o `Date` come.
 *
 * @param {object} agora  a foto de hoje  @param {object} foto  a foto gravada na puxada
 * @returns {string|null} a divergência, ou null
 */
function conferirIntacta(agora, foto) {
  if (!agora) return 'a PC não existe mais';
  const dif = [];
  if (agora.enviado_ci !== false)     dif.push('já foi reencaminhada ao C.I.');
  if (agora.dt_envio_ci != null)      dif.push('tem data de envio ao C.I. de novo');
  if (agora.enviado_ci_por != null)   dif.push('tem autor de encaminhamento de novo');
  if (agora.ci_situacao != null)      dif.push(`está no ciclo do C.I. (${agora.ci_situacao})`);
  if (Number(agora.ci_rodada) !== 0)  dif.push(`está na rodada ${agora.ci_rodada} do C.I.`);
  if (agora.baixada !== false)        dif.push('foi baixada de novo');
  if (agora.parecer_tipo != null)     dif.push(`tem parecer de novo (${agora.parecer_tipo})`);
  if (agora.estornada !== true)       dif.push('não está mais marcada como estornada');
  const dbAgora = agora.data_baixa ?? null;
  const dbFoto = foto ? (foto.data_baixa ?? null) : null;
  if (dbAgora !== dbFoto)
    dif.push(`a data da baixa mudou (foto ${dbFoto ?? 'nenhuma'}, hoje ${dbAgora ?? 'nenhuma'})`
           + ' — a baixa foi refeita');
  return dif.length ? dif.join(' · ') : null;
}

/**
 * A foto bate com o estado de agora, coluna por coluna? Usada DEPOIS de gravar, dentro da
 * MESMA transação — conferir só antes prova o que se esperava, não o que aconteceu.
 *
 * ⚠️ AS DUAS SÃO FOTOS DO `SQL_FOTO` — dois `to_jsonb` do mesmo Postgres, comparados como
 * texto. Ler o "depois" em JavaScript truncava o microssegundo do `timestamp` e acusava
 * divergência onde o valor era idêntico; ver `SQL_TRAVAR_PARA_DESFAZER`.
 *
 * @param {object} foto  a foto gravada  @param {object} agora  a foto de depois de gravar
 * @returns {string[]} as divergências (vazio = bateu)
 */
function conferirRestauracao(foto, agora) {
  const fora = [];
  for (const codigo of Object.keys(foto || {})) {
    const a = (agora || {})[codigo];
    if (!a) { fora.push(`${codigo}: sumiu`); continue; }
    for (const col of COLUNAS_FOTO) {
      const esperado = foto[codigo][col] ?? null;
      const obtido = a[col] ?? null;
      if (String(esperado) !== String(obtido))
        fora.push(`${codigo}.${col}: esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
    }
  }
  return fora;
}

module.exports = {
  DESTINOS, DESTINO_PARA_STATUS, MOTIVO_MIN, MOTIVO_MAX, ORIGEM_RECARGA,
  podeCorrigirBaixa, podePuxarCi, ciJaSeManifestou, validarMotivo, validarDestino, alvoDaAcao,
  SQL_TIRAR_DA_PRODUTIVIDADE, SQL_SO_SITUACAO, SQL_PUXAR_CI,
  SQL_CARREGAR_ALVO, SQL_CARREGAR_IRMAS,
  COLUNAS_FOTO, SQL_FOTO, SQL_RESTAURAR_FOTO, SQL_BUSCAR_PUXADA, SQL_JA_DESFEITA,
  SQL_TRAVAR_PARA_DESFAZER,
  podeDesfazerPuxarCi, conferirIntacta, conferirRestauracao, textoData,
  _autoria: PARCEIRA,
};
