// CAMINHO: sigpc-api/lib/sigef.js
//
// A CONFERÊNCIA COM O SIGEF — as três situações, e a declaração do analista.
// Especificação do Richard, 27/08/2026.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ISTO RESOLVE
//
// O extrato do SIGEF que a CGE enviou (`Baixas FCEE.xlsx`) foi carregado em 27/08 nas colunas
// `sigef_status` e `data_baixa_sigef`: 3.466 PCs. Cruzar esse extrato com o nosso estado
// revela três desencontros, e cada um pede uma ação diferente de quem está com a PC na mão.
//
// ⚠️ A CLASSIFICAÇÃO É CALCULADA, NUNCA GRAVADA. Não há coluna `sigef_tag`, e não pode haver:
// ela mudaria sozinha a cada extração nova da CGE, e uma coluna gravada ficaria mentindo até
// alguém rodar um script para recalculá-la. O que se grava é o FATO (o extrato, e a
// declaração do analista); a tag é leitura desses fatos, feita na hora.
//
// ⚠️ E ESTA LIB É O ÚNICO LUGAR ONDE A REGRA MORA. O `server.js` cola `SQL_TAG` no SELECT e
// devolve `sigef_tag` pronto em cada linha; a tela só pinta o que recebeu. Se a tela também
// classificasse, seriam duas regras — e a segunda cópia é sempre a que fica velha (foi assim
// com o `MAPA_PLAN_EST`, em 17/08).
// ─────────────────────────────────────────────────────────────────────────────

// ⚠️ O CORTE DA EXTRAÇÃO. O extrato da CGE tem `Data Ult Mod` até 31/07/2026, então uma PC
// baixada aqui a partir de 01/08 NÃO PODIA aparecer nele — ela é posterior à foto. Classificar
// essas seria acusar de "sem registro no SIGEF" 321 parciais e 40 finais que a equipe baixou
// em agosto, e mandar o analista conferir o que está certo.
//
// ⚠️ VALE PARA AS TRÊS SITUAÇÕES, e não só para a primeira — decisão do Richard, 27/08. Sem
// ele em `VERIFICAR_FINAL` a contagem dá 324 em vez de 284.
//
// ⚠️ A COMPARAÇÃO É DIRETA CONTRA O `timestamp` NAIVE, e isso está medido: existem ZERO PCs
// com `data_baixa` na janela entre 31/07 20h e 01/08 04h, então nenhuma leitura de fuso muda
// de lado. Não é o caso da armadilha 18 — aqui não há conversão nenhuma, é uma data fixa
// histórica contra uma coluna naive. Não trocar por `HOJE_BR`: aquilo é para "hoje", e este
// corte não anda.
const CORTE_EXTRACAO = '2026-08-01';

// ─────────────────────────────────────────────────────────────────────────────
// AS TAGS
//
// ⚠️ O CÓDIGO É O CONTRATO ENTRE SERVIDOR E TELA. Cor e texto são da tela (índice único no
// `index.html`); aqui fica só o código e o que ele significa. Trocar um código quebra a tela
// em silêncio — ela cai no `else` e não pinta nada.
// ─────────────────────────────────────────────────────────────────────────────
const TAGS = {
  // Baixada aqui, e o extrato do SIGEF não conhece. A parcial pode ter tido o parecer
  // anexado ao SGPe sem ter sido registrada no SIGEF — é o erro que este cruzamento acha.
  SEM_REGISTRO_SIGEF: 'SEM_REGISTRO_SIGEF',
  // O SIGEF baixou e nós não. O conserto é aqui dentro, não lá: falta o parecer no sistema.
  ABERTA_COM_BAIXA_SIGEF: 'ABERTA_COM_BAIXA_SIGEF',
  // A final não está no extrato — mas o extrato de finais só lista as aprovadas pelo
  // Secretário, então ausência ali não prova ausência no SIGEF. Por isso "verificar", e não
  // "sem registro": é a mesma forma da armadilha 19 — um sinal só não confirma nada.
  VERIFICAR_FINAL: 'VERIFICAR_FINAL',
  // O analista já declarou. Fica assim até a CGE mandar a próxima extração.
  REGISTRO_DECLARADO: 'REGISTRO_DECLARADO',
};

// ─────────────────────────────────────────────────────────────────────────────
// O QUE É "BAIXA" NO `sigef_status` — a lista única
//
// ⚠️ ESTE CAMPO GUARDA DUAS FAMÍLIAS DE VALOR, e é por isso que a lista existe:
//   · TEXTO LONGO — da conciliação com o extrato da CGE ("Baixa Regular Ressalva").
//   · CÓDIGO DE DUAS LETRAS — da importação dos relatórios do SIGEF de 30/08/2026 ("SV",
//     "AV", "VA"…), que trazem a situação corrente de QUALQUER PC, não só das baixadas.
//
// ⚠️ FOI A SEGUNDA FAMÍLIA QUE QUEBROU A REGRA ANTIGA. Até 30/08 a tag âmbar perguntava só
// `sigef_status IS NOT NULL` — bastava, porque o campo só era preenchido quando o SIGEF tinha
// dado baixa. Com a importação, **1.598 PCs em análise** passaram a ter o campo preenchido e
// caíram na tag: ela saltou de **398 para 1.996** e apareceu em quase toda TR livre do
// estoque. A pergunta certa não é "o campo existe?", é "o que ele diz?".
//
// ⚠️ A COMPARAÇÃO É POR `btrim(upper(...))` NOS DOIS LADOS. O acento fica — 'Secretário' em
// maiúscula continua com acento no Postgres e no JS —, e o que não pode é normalizar um lado
// só. Por isso a constante já está escrita em maiúscula.
const SIGEF_BAIXA = [
  // códigos das parciais
  'AV',                                 // Regular
  'SV',                                 // Regular com Ressalvas
  // códigos das finais — Técnico e Secretário
  'AT',                                 // Regular - Técnico
  'ST',                                 // Regular com Ressalvas - Técnico
  'AS',                                 // Regular - Secretário
  'SS',                                 // Regular com Ressalvas - Secretário
  // textos longos, como a conciliação com a CGE os gravou
  'BAIXA REGULAR',
  'BAIXA REGULAR RESSALVA',
  'REGULAR',
  'REGULAR COM RESSALVAS',
  'REGULAR - TÉCNICO',
  'REGULAR COM RESSALVAS - TÉCNICO',
  'REGULAR - SECRETÁRIO',
  'REGULAR COM RESSALVAS - SECRETÁRIO',
];

// ⚠️ NÃO ENTRAM, e é exatamente o ponto da correção: VA, VR, VT, VS (análise e reanálise),
// DV, DT (diligência), ED (em edição), DA (aguardando documentos) e os irregulares
// IC/IP/IS/IF, CT/PT/LT/FT, CS/PS/LS/FS. **Irregular não é baixa**: é decisão desfavorável, e
// a PC continua aberta aqui dentro.
const SIGEF_BAIXA_SQL = SIGEF_BAIXA.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');

/** O espelho em JS do `IN (...)` do SQL. Um lugar só decide o que é baixa. */
const ehBaixaSigef = v => v != null && SIGEF_BAIXA.includes(String(v).trim().toUpperCase());

// ⚠️ SÓ DUAS DAS TRÊS ACEITAM DECLARAÇÃO. A declaração diz "o parecer está registrado no
// SIGEF" — e no caso âmbar o SIGEF JÁ REGISTROU: o que falta é o parecer aqui dentro.
// Declarar ali não teria o que afirmar, e encheria a coluna de linhas sem sentido nas 401.
// É o que os próprios textos da tela dizem: o vermelho e o azul terminam em "declare abaixo";
// o âmbar termina em "confirme o parecer no sistema".
const TAGS_QUE_DECLARAM = [TAGS.SEM_REGISTRO_SIGEF, TAGS.VERIFICAR_FINAL];

// As duas respostas possíveis. O código é o que se grava; o rótulo é o que a pessoa leu ao
// clicar, e vai junto para que a trilha não dependa de a tela continuar escrevendo igual.
const RESPOSTAS = {
  ja_estava: 'Já estava registrado no SIGEF',
  registrei_agora: 'Não estava; registrei agora',
};

// ─────────────────────────────────────────────────────────────────────────────
// A REGRA, EM SQL
// ─────────────────────────────────────────────────────────────────────────────

// "Tem declaração?" — resistente a lixo. `jsonb_array_length` explode se o valor não for
// array, e a coluna é nova: uma linha gravada à mão como objeto derrubaria o SELECT inteiro
// de todas as telas.
const TEM_DECLARACAO = `
  (jsonb_typeof(COALESCE(p.sigef_declaracao, '[]'::jsonb)) = 'array'
   AND jsonb_array_length(COALESCE(p.sigef_declaracao, '[]'::jsonb)) > 0)`;

// A pendência bruta, ANTES de olhar a declaração. Serve para o `podeDeclarar` e para contar.
const PENDENCIA_SQL = `
  CASE
    WHEN p.baixada = true AND p.tipo = 'parcial' AND p.sigef_status IS NULL
         AND p.data_baixa < TIMESTAMP '${CORTE_EXTRACAO}'
      THEN '${TAGS.SEM_REGISTRO_SIGEF}'
    WHEN p.baixada = true AND p.tipo = 'final' AND p.sigef_status IS NULL
         AND p.data_baixa < TIMESTAMP '${CORTE_EXTRACAO}'
      THEN '${TAGS.VERIFICAR_FINAL}'
    WHEN p.baixada = false AND btrim(upper(p.sigef_status)) IN (${SIGEF_BAIXA_SQL})
      THEN '${TAGS.ABERTA_COM_BAIXA_SIGEF}'
    ELSE NULL
  END`;

// A tag que vai para a tela: a pendência, com o cinza por cima quando já foi declarada.
//
// ⚠️ O CINZA SÓ COBRE O VERMELHO E O AZUL. Uma declaração numa PC âmbar não a apaga — lá o
// pendente é o parecer neste sistema, e nada que o analista declare sobre o SIGEF resolve.
const SQL_TAG = `
  CASE
    WHEN ${PENDENCIA_SQL} IN ('${TAGS.SEM_REGISTRO_SIGEF}', '${TAGS.VERIFICAR_FINAL}')
         AND ${TEM_DECLARACAO}
      THEN '${TAGS.REGISTRO_DECLARADO}'
    ELSE ${PENDENCIA_SQL}
  END`;

// ─────────────────────────────────────────────────────────────────────────────
// A PRODUTIVIDADE, CONCILIADA COM O SIGEF — decisão do Richard, 27/08/2026
//
// A unidade continua a mesma: **PCs distintas** com `baixada = true` OU `enviado_ci = true`.
// O que muda é que as pendências de conferência **saem da contagem enquanto não houver
// declaração do analista**.
//
// ⚠️ POR QUE SAIR É O CERTO, e não é punição: a CGE também não conta essas PCs. O extrato
// oficial do SIGEF não as conhece, então um relatório que as somasse estaria afirmando à CGE
// um número que o SIGEF não sustenta. A conferência é o que devolve a PC à contagem.
//
// ⚠️ DECLAROU, VOLTA NA HORA. A tag vira `REGISTRO_DECLARADO`, que NÃO está na lista de
// desconto — então a PC reentra no mesmo instante, sem esperar a próxima extração da CGE.
// Fazer o analista esperar semanas por um número que ele já corrigiu seria transformar a
// conferência em castigo.
//
// ⚠️ A ÂMBAR NÃO ENTRA AQUI, e não é esquecimento. `ABERTA_COM_BAIXA_SIGEF` já não conta hoje
// pelo motivo de sempre — a PC não está baixada. Ela entra quando o analista registrar o
// parecer neste sistema, pelo caminho normal. Nada nesta regra a toca.
//
// ⚠️ E É UM CÁLCULO SÓ. `SQL_CONTA_PRODUTIVIDADE` é colado no SELECT e volta como
// `sigef_conta` em cada linha; cards, anel de meta, dashboard, relatórios e setorial somam
// esse booleano. A tela NÃO reimplementa a conta — foi o que criou a divergência que este
// ciclo achou: o `mapaStats` contava `status = 'baixada'` para o anel enquanto a regra escrita
// dizia `baixada OU enviado_ci`, e os dois números nunca foram os mesmos.
// ─────────────────────────────────────────────────────────────────────────────

// As duas que descontam. A âmbar não está aqui de propósito; a cinza (declarada) também não.
const TAGS_QUE_DESCONTAM = [TAGS.SEM_REGISTRO_SIGEF, TAGS.VERIFICAR_FINAL];

// A base, sem o desconto — a regra de sempre. Fica separada para a tela poder dizer
// "sua contagem sobe de X para Y" sem recalcular nada por conta própria.
const SQL_BASE_PRODUTIVIDADE = `(p.baixada = true OR p.enviado_ci = true)`;

// ⚠️ `COALESCE(..., '')` porque a tag é NULL na imensa maioria das linhas, e `NULL NOT IN
// (...)` é NULL — que num `WHERE` some, e num `COUNT(*) FILTER` também. Sem o COALESCE esta
// expressão zeraria a produtividade das 13.620 PCs sem tag, em silêncio.
const SQL_CONTA_PRODUTIVIDADE = `(
  ${SQL_BASE_PRODUTIVIDADE}
  AND COALESCE(${SQL_TAG}, '') NOT IN (${TAGS_QUE_DESCONTAM.map((t) => `'${t}'`).join(', ')})
)`;

// "Esta PC está fora da contagem por causa do SIGEF?" — o que o rodapé da faixa soma.
const SQL_DESCONTADA = `(
  ${SQL_BASE_PRODUTIVIDADE}
  AND ${SQL_TAG} IN (${TAGS_QUE_DESCONTAM.map((t) => `'${t}'`).join(', ')})
)`;

// ─────────────────────────────────────────────────────────────────────────────
// A MESMA CONTA, MAS "ATÉ UMA DATA" — para o relatório cumulativo
//
// ⚠️ CADA PERNA TEM A PRÓPRIA DATA. A perna da baixa é `data_baixa`; a do C.I. é
// `dt_envio_ci`. Cortar as duas por `data_baixa` deixava de fora, estruturalmente, a PC que
// conta SÓ por ter ido ao C.I. — e essa PC existe. Era o que faltava para a rota implementar
// a regra escrita por inteiro; até 27/08 ela tinha só a perna da baixa.
//
// ⚠️ E A PERNA DA BAIXA NÃO GANHA `baixada = true`, de propósito. A rota é CUMULATIVA: ela
// responde "o que valia naquela data", e quem responde isso é `data_baixa <= corte` junto com
// `estornada = false OR data_estorno > corte`. `data_baixa` é preservada depois do estorno
// justamente para isso (ver `lib/correcao.js`) — acrescentar `baixada = true` faria a PC
// estornada HOJE sumir de um relatório de ontem, reescrevendo o passado já emitido.
const sqlBaseAte = (p) => `(p.data_baixa <= ${p} OR (p.enviado_ci = true AND p.dt_envio_ci <= ${p}))`;

const sqlContaAte = (p) => `(
  ${sqlBaseAte(p)}
  AND COALESCE(${SQL_TAG}, '') NOT IN (${TAGS_QUE_DESCONTAM.map((t) => `'${t}'`).join(', ')})
)`;

const sqlDescontadaAte = (p) => `(
  ${sqlBaseAte(p)}
  AND ${SQL_TAG} IN (${TAGS_QUE_DESCONTAM.map((t) => `'${t}'`).join(', ')})
)`;

// ─────────────────────────────────────────────────────────────────────────────
// A MESMA REGRA, EM JS
//
// ⚠️ ELA EXISTE PARA SER TESTADA, e para quem já tem a linha na mão. O SELECT continua sendo
// a fonte: duas implementações da mesma regra só se justificam com um teste que prove que as
// duas concordam — e `teste_sigef.js` tem esse teste.
// ─────────────────────────────────────────────────────────────────────────────

/** A data de baixa como texto ISO, aceitando `Date` e string (armadilha 25). */
function paraIso(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

function temDeclaracao(pc) {
  return Array.isArray(pc && pc.sigef_declaracao) && pc.sigef_declaracao.length > 0;
}

/** A pendência bruta, sem olhar a declaração. */
function pendencia(pc) {
  if (!pc) return null;
  const antesDoCorte = () => {
    const d = paraIso(pc.data_baixa);
    return !!d && d < CORTE_EXTRACAO;
  };
  if (pc.baixada === true && pc.tipo === 'parcial' && pc.sigef_status == null && antesDoCorte())
    return TAGS.SEM_REGISTRO_SIGEF;
  if (pc.baixada === true && pc.tipo === 'final' && pc.sigef_status == null && antesDoCorte())
    return TAGS.VERIFICAR_FINAL;
  // ⚠️ "o que ele diz", não "se ele existe" — ver `SIGEF_BAIXA`.
  if (pc.baixada === false && ehBaixaSigef(pc.sigef_status))
    return TAGS.ABERTA_COM_BAIXA_SIGEF;
  return null;
}

/** A tag final — a pendência, com o cinza por cima quando já foi declarada. */
function classificar(pc) {
  const p = pendencia(pc);
  if (TAGS_QUE_DECLARAM.includes(p) && temDeclaracao(pc)) return TAGS.REGISTRO_DECLARADO;
  return p;
}

/** A base da produtividade, sem o desconto: `baixada` OU `enviado_ci`, PC distinta. */
function baseProdutividade(pc) {
  return !!pc && (pc.baixada === true || pc.enviado_ci === true);
}

/** Esta PC conta hoje? — o espelho em JS de `SQL_CONTA_PRODUTIVIDADE`. */
function contaProdutividade(pc) {
  return baseProdutividade(pc) && !TAGS_QUE_DESCONTAM.includes(classificar(pc));
}

/** Esta PC está FORA da contagem por causa do SIGEF? (contaria, se não fosse a pendência) */
function descontadaPeloSigef(pc) {
  return baseProdutividade(pc) && TAGS_QUE_DESCONTAM.includes(classificar(pc));
}

// ─────────────────────────────────────────────────────────────────────────────
// A DECLARAÇÃO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quem pode declarar?
 *
 * ⚠️ SÓ O ANALISTA RESPONSÁVEL PELA PC, OU O SUPERADMIN — e o perfil vem do BANCO, nunca do
 * corpo do pedido. Foi o buraco que as quatro rotas de 14/08 fecharam: bastava mandar
 * `perfil: 'superadmin'` para passar.
 *
 * ⚠️ O superadmin entra por `perfilEfetivo`, e não por `u.perfil`: no papel de analista ele É
 * analista em toda parte, e aqui isso significa que ele só declara nas PCs dele.
 *
 * @param quem    o usuário lido do banco, com `perfil` e `papel_ativo`
 * @param pc      a linha de `prestacoes_contas`
 * @param perfil  o perfil EFETIVO (de `papel.perfilEfetivo`)
 */
function podeDeclarar(quem, pc, perfil) {
  if (!quem || !pc) return false;
  if (perfil === 'superadmin') return true;
  return pc.analista_id != null && String(pc.analista_id) === String(quem.id);
}

/**
 * Vale declarar nesta PC?
 *
 * ⚠️ A REDECLARAÇÃO É PERMITIDA DE PROPÓSITO. "Se o analista errar, ele declara de novo e o
 * histórico guarda as duas" — então `REGISTRO_DECLARADO` também entra aqui. Recusar a segunda
 * declaração deixaria o erro gravado para sempre, que é o oposto do que a coluna serve.
 */
function aceitaDeclaracao(pc) {
  const t = classificar(pc);
  return TAGS_QUE_DECLARAM.includes(t) || t === TAGS.REGISTRO_DECLARADO;
}

/**
 * Valida o corpo do pedido. Devolve a mensagem de erro, ou null.
 *
 * ⚠️ A DATA É CONFERIDA COMO TEXTO ISO, e não com `new Date(...)`. `new Date('31/08/2026')`
 * devolve `Invalid Date` em silêncio em alguns formatos e uma data errada em outros — é a
 * mesma família das armadilhas 18 e 25. Aqui só passa `AAAA-MM-DD` que sobrevive ao
 * ida-e-volta, o que recusa 2026-02-31 sem precisar de tabela de meses.
 */
function validarDeclaracao({ resposta, data_registro }) {
  if (!resposta || !Object.prototype.hasOwnProperty.call(RESPOSTAS, resposta))
    return `Resposta inválida. Use uma de: ${Object.keys(RESPOSTAS).join(', ')}.`;
  if (!data_registro || !/^\d{4}-\d{2}-\d{2}$/.test(String(data_registro)))
    return 'Informe a data do registro no formato AAAA-MM-DD.';
  const d = new Date(`${data_registro}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== String(data_registro))
    return 'Data do registro inexistente.';
  return null;
}

/**
 * Monta a linha que vai para o array do jsonb.
 *
 * ⚠️ O RÓTULO VAI JUNTO COM O CÓDIGO, e não só o código. O código serve para consultar; o
 * rótulo é o que a pessoa leu na tela ao clicar, e é o que responde à CGE meses depois — se
 * o texto do botão mudar, a trilha antiga continua dizendo o que foi afirmado na época.
 * É a mesma decisão do `executado_por`, que marca na coluna E no texto.
 */
function montarDeclaracao({ resposta, data_registro, quem, agora }) {
  return {
    resposta,
    resposta_rotulo: RESPOSTAS[resposta],
    data_registro,
    declarado_por: quem.id,
    declarado_por_nome: quem.nome || null,
    declarado_em: (agora || new Date()).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A DECLARAÇÃO É POR PARCELA — decisão do Richard, 27/08/2026
//
// ⚠️ A UNIDADE É `(setorial_id, tr, parcial_num)`, a MESMA do parecer do analista e da decisão
// do C.I. Até esta data a rota era por `codigo_pc`, e o modal dizia "Vale para a PC
// 2021PC002125": numa parcela de 7 PCs o analista declarava sete vezes o mesmo fato. O parecer
// no SIGEF é um só — quem o registrou registrou a parcela, não uma linha dela.
//
// ⚠️ E A TAG ENTRA NA CHAVE. Uma parcela pode ter PCs em situações diferentes (parciais
// vermelhas ao lado da final azul, por exemplo). A declaração alcança SÓ as PCs que estão na
// mesma tag do modal aberto — misturar `SEM_REGISTRO_SIGEF` com `VERIFICAR_FINAL` afirmaria,
// sobre a prestação final, o que o analista disse sobre as parciais.
// ─────────────────────────────────────────────────────────────────────────────

// As PCs da parcela que a declaração alcança: as da parcela QUE ESTÃO na tag pedida.
//
// ⚠️ `FOR UPDATE` e dentro da transação, como `carregarParcela`. Entre escolher as PCs e
// gravar, outra sessão poderia baixar a parcial e tirar uma delas da situação — e a
// declaração cairia sobre uma PC que já não está mais lá.
//
// ⚠️ A tag é recalculada AQUI, pela mesma `SQL_TAG` da tela. Confiar na tag que o navegador
// mandou seria deixar o cliente escolher em quais linhas escrever: bastaria mandar outra tag
// para alcançar PCs que a tela nunca ofereceu. O corpo nunca provou nada.
const SQL_PCS_DA_PARCELA_NA_TAG = `
  SELECT p.codigo_pc, p.analista_id, p.tipo, p.baixada, p.data_baixa, p.sigef_status,
         p.sigef_declaracao, ${SQL_TAG} AS sigef_tag
    FROM prestacoes_contas p
   WHERE p.setorial_id = $1 AND p.tr = $2 AND p.parcial_num = $3
   ORDER BY p.codigo_pc
     FOR UPDATE`;

// ⚠️ O `||` APENDA, NUNCA SUBSTITUI — é o que faz "a declaração não se desmarca". E o
// `COALESCE` com `'[]'` cobre a primeira, quando a coluna ainda é NULL.
//
// ⚠️ `sigef_registro_em` RECEBE A DATA DA DECLARAÇÃO MAIS RECENTE, e é por isso que ela é uma
// coluna e não um `->>` do jsonb: é dela que a próxima conferência vai ler, e ninguém deveria
// precisar saber a forma do json para responder "quando foi registrado".
//
// ⚠️ E NADA MAIS ENTRA NO `SET`. `baixada`, `enviado_ci`, `data_baixa`, `parecer_tipo` e
// `sigef_status` não aparecem aqui: declarar não baixa, não estorna e não move produtividade.
// Há teste que falha se um destes nomes voltar a este SQL.
//
// ⚠️ A LISTA DE CHAVES É EXPLÍCITA (`= ANY($1)`), e não uma condição derivada de tr/parcial/tag.
// É a armadilha 12: a condição seria reavaliada no momento do UPDATE e poderia casar linha
// que a conferência de quem-pode nunca viu. As chaves são as que foram lidas com `FOR UPDATE`
// logo acima, nesta mesma transação.
const SQL_DECLARAR = `
  UPDATE prestacoes_contas
     SET sigef_declaracao = COALESCE(sigef_declaracao, '[]'::jsonb) || $2::jsonb,
         sigef_registro_em = $3::date
   WHERE codigo_pc = ANY($1)
  RETURNING codigo_pc, sigef_declaracao, sigef_registro_em`;

/**
 * Separa as PCs da parcela entre as que a declaração alcança e as que ficam de fora.
 *
 * @param pcs  as linhas da parcela, já com `sigef_tag` calculado pelo banco
 * @param tag  a tag do modal que o analista abriu
 */
function alvoDaDeclaracao(pcs, tag) {
  const todas = pcs || [];
  const alcanca = todas.filter((p) => p.sigef_tag === tag);
  const fora = todas.filter((p) => p.sigef_tag !== tag);
  return { alcanca, fora, codigos: alcanca.map((p) => p.codigo_pc) };
}

/**
 * Quem pode declarar NA PARCELA?
 *
 * ⚠️ TEM DE PODER EM TODAS AS PCs ALCANÇADAS, e não em uma. Uma parcela com dono misto
 * (acontece: são 78 PCs soltas já corrigidas, mas o caso volta) deixaria um analista gravar
 * no acervo de outro se bastasse ser dono de uma linha. O superadmin passa por cima, como
 * em toda parte.
 */
function podeDeclararParcela(quem, pcs, perfil) {
  if (!quem || !pcs || !pcs.length) return false;
  return pcs.every((pc) => podeDeclarar(quem, pc, perfil));
}

module.exports = {
  CORTE_EXTRACAO, TAGS, TAGS_QUE_DECLARAM, TAGS_QUE_DESCONTAM, RESPOSTAS,
  SIGEF_BAIXA, SIGEF_BAIXA_SQL, ehBaixaSigef,
  SQL_TAG, PENDENCIA_SQL, TEM_DECLARACAO,
  SQL_BASE_PRODUTIVIDADE, SQL_CONTA_PRODUTIVIDADE, SQL_DESCONTADA,
  sqlBaseAte, sqlContaAte, sqlDescontadaAte,
  baseProdutividade, contaProdutividade, descontadaPeloSigef,
  paraIso, temDeclaracao, pendencia, classificar,
  podeDeclarar, podeDeclararParcela, aceitaDeclaracao, validarDeclaracao, montarDeclaracao,
  alvoDaDeclaracao,
  SQL_PCS_DA_PARCELA_NA_TAG, SQL_DECLARAR,
};
