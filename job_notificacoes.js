// CAMINHO: sigpc-api/job_notificacoes.js
//
// AVISO DE PRAZO — o único tipo de notificação que não tem "momento do evento".
//
// Aprovação, diligência e recado nascem de um clique de alguém. Uma PC vence à meia-noite sem
// ninguém tocar em nada. Como a regra do Richard é "gravada no momento do evento, nunca
// calculada na leitura", a única saída é um job que passa de hora em hora e grava o que
// venceu desde a última passagem.
//
// ⚠️ O DEDUPE NÃO É DETALHE: É O QUE MANTÉM O SINO VIVO.
// Sem ele, a mesma PC vencida gera 24 notificações por dia, por PC. Com 11 mil PCs em aberto,
// o sino morre afogado na primeira semana e ninguém abre mais. A chave é
// `destinatario_id + tipo + ref_id`, conferida DENTRO do INSERT (ver lib/notificacao.js).
//
// O `ref_id` leva a faixa junto (`{codigo_pc}|vence` / `|vencida`), então cada PC avisa no
// máximo duas vezes na vida: uma ao entrar na semana do vencimento, outra ao vencer.
//
// USO:
//   node job_notificacoes.js                 grava
//   node job_notificacoes.js --dry-run       só mostra o que gravaria
//   node job_notificacoes.js --limite=50     teto de avisos nesta passagem
//
// CRON no Railway: de hora em hora, ao lado do job_sgpe_links.

const { Pool } = require('pg');
const notificacao = require('./lib/notificacao');

// ═══════════════════════════════════════════════════════════════════════════
//  DATA DE CORTE DO SINO — mude AQUI, é o único lugar
// ═══════════════════════════════════════════════════════════════════════════
// PC com `dt_limite_pc` anterior a esta data NÃO gera aviso de prazo.
//
// ⚠️ NÃO BAIXE ESTA DATA achando que o corte é conservador demais.
//
// O `dt_limite_pc` do acervo antigo NÃO É PRAZO: é cálculo em lote. Decisão do Richard em
// 10/08/2026, e a distribuição não deixa dúvida — 29/07/2024 é a data mais recente de TODOS
// os 44 analistas, e as 231 de 2027 caem TODAS em 30/01/2027. Num acervo de 4.721 PCs, nada
// vence entre ago/2026 e jan/2027.
//
// Prazo real só passa a existir quando o analista inserir a data no sistema, a partir da
// abertura para a equipe. Baixar o corte faria o sino cobrar prazo que ninguém definiu — e
// avisar sobre 4.490 PCs de uma vez, o que mataria o sino no primeiro dia.
//
// ⚠️ O CORTE É SÓ DO SINO. Essas PCs continuam aparecendo normalmente no Estoque e na Minha
// Planilha, e o cálculo de `dias_atraso` não muda. Nada aqui escreve em `prestacoes_contas`.
const CORTE_PRAZO = '2026-08-01';
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
//  RETENÇÃO DA NOTIFICAÇÃO LIDA — mude AQUI
// ═══════════════════════════════════════════════════════════════════════════
// Notificação LIDA é apagada este tanto de dias DEPOIS DA LEITURA.
//
// ⚠️ Não lida NUNCA é apagada, por mais antiga que seja — quem passou um mês fora encontra
// tudo o que perdeu. E o relógio conta da leitura, não da criação: quem volta de férias e lê
// hoje tem 15 dias a partir de hoje, e não um aviso que some amanhã.
//
// O que some é o AVISO, não o fato: a decisão em si (quem aprovou, quando, com que motivo)
// fica em `solicitacao_vaga`, permanente. Por isso não há botão de excluir por item — como
// nos pedidos expirados, o registro pode servir de prova.
const DIAS_GUARDA_LIDA = 15;
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
//  PRAZO DA DILIGÊNCIA — mude AQUI
// ═══════════════════════════════════════════════════════════════════════════
// O prazo que o ANALISTA deu à entidade para responder (`prazo_diligencia`), diferente do
// `dt_limite_pc`, que é o prazo da FCEE para analisar.
//
// Aqui NÃO há corte de data histórica: ao contrário do `dt_limite_pc`, este campo só existe
// quando alguém digita na tela de Situação — e a tela EXIGE o prazo para marcar Diligência.
// Não há acervo antigo para filtrar.
const DILIG_AVISO_PREVIO = 3;    // avisa 3 dias antes de vencer
const DILIG_COBRANCA     = 7;    // cobra 7 dias depois de vencido, se ninguém agiu
// ⚠️ TETO DA COBRANÇA, e ele existe por um motivo concreto:
// o dedupe mora na própria tabela `notificacao`, e notificação lida é apagada em
// DIAS_GUARDA_LIDA. Quando a linha some, o job esquece que já avisou. Sem teto, a PC
// esquecida viraria cobrança a cada 15 dias, para sempre — e o analista aprende a ignorar o
// ícone. Passados 21 dias do prazo, silêncio.
const DILIG_COBRANCA_ATE = 21;
// ═══════════════════════════════════════════════════════════════════════════

const DIAS_AVISO_PREVIO = 7;

const args = process.argv.slice(2);
const temArg = (n) => args.includes(n);
const valorArg = (n, padrao) => {
  const a = args.find(x => x.startsWith(`${n}=`));
  return a ? parseInt(a.split('=')[1]) : padrao;
};

const DRY = temArg('--dry-run');
const LIMITE = valorArg('--limite', 500);

/**
 * As PCs que merecem aviso agora.
 *
 * Só PC de analista, não baixada e com data limite. `dt_limite_pc` é a data oficial — não
 * recalculo nada aqui, e não escrevo em `prestacoes_contas`: este job só lê de lá.
 */
async function buscarAlvos(pool) {
  // ⚠️ Os `::int` NÃO são enfeite — sem eles isto morre com
  // "operator is not unique: date + unknown". `CURRENT_DATE + $1` é ambíguo: o Postgres tem
  // `date + integer` (dias) e `date + interval`, e com o parâmetro sem tipo não sabe qual
  // usar. Aconteceu em produção em 10/08, e é o mesmo defeito do INSERT de mais cedo:
  // parâmetro sem tipo declarado. A regra aqui virou: todo parâmetro em conta aritmética
  // leva o tipo escrito.
  const { rows } = await pool.query(
    `SELECT codigo_pc, tr, entidade, analista_id, setorial_id, dt_limite_pc,
            (dt_limite_pc::date - CURRENT_DATE) AS dias
       FROM prestacoes_contas
      WHERE analista_id IS NOT NULL
        AND baixada = false
        AND dt_limite_pc IS NOT NULL
        AND dt_limite_pc::date <= CURRENT_DATE + $1::int
        AND dt_limite_pc::date >= $3::date
      ORDER BY dt_limite_pc
      LIMIT $2::int`, [DIAS_AVISO_PREVIO, LIMITE, CORTE_PRAZO]);
  return rows;
}

/**
 * As diligências que merecem aviso agora — as três faixas de uma vez.
 *
 * `faixa` sai da própria consulta ('previo' | 'hoje' | 'cobranca'), para a regra de qual
 * aviso cabe a cada PC viver num lugar só, junto do filtro que a seleciona.
 *
 * ⚠️ O `NOT EXISTS` é o gatilho combinado com o Richard: a cobrança NÃO sai se, DEPOIS do
 * início desta rodada de diligência (`dt_situacao`), houve
 *   · `resposta_diligencia` — a entidade respondeu, ou
 *   · `situacao`            — o analista já moveu a parcial.
 *
 * Comparar com `dt_situacao` resolve a segunda diligência de graça: abrir uma rodada nova
 * reescreve `dt_situacao`, e a resposta da rodada anterior fica para trás — não silencia a
 * cobrança nova.
 */
async function buscarDiligencias(pool) {
  const { rows } = await pool.query(
    `SELECT p.codigo_pc, p.tr, p.parcial_num, p.entidade, p.analista_id, p.setorial_id,
            p.prazo_diligencia,
            (p.prazo_diligencia - CURRENT_DATE) AS dias,
            CASE WHEN p.prazo_diligencia = CURRENT_DATE            THEN 'hoje'
                 WHEN p.prazo_diligencia > CURRENT_DATE            THEN 'previo'
                 ELSE 'cobranca' END AS faixa
       FROM prestacoes_contas p
      WHERE p.analista_id IS NOT NULL
        AND p.baixada = false
        AND p.prazo_diligencia IS NOT NULL
        AND (p.situacao_atual = 'Diligência' OR p.status = 'diligencia')
        AND (
              p.prazo_diligencia = CURRENT_DATE + $1::int          -- 3 dias antes
           OR p.prazo_diligencia = CURRENT_DATE                    -- no dia
           OR ( p.prazo_diligencia <= CURRENT_DATE - $2::int       -- vencida, dentro da janela
            AND p.prazo_diligencia >= CURRENT_DATE - $3::int
            AND NOT EXISTS (
                  SELECT 1 FROM parcela_historico h
                   WHERE h.tr = p.tr AND h.parcial_num = p.parcial_num
                     AND h.evento IN ('resposta_diligencia','situacao')
                     -- ATENCAO: o ramo dt_situacao IS NULL nao e zelo. As 1.236 diligencias
                     -- vindas da carga de 05/08 tem dt_situacao VAZIO. Sem ele, a comparacao
                     -- daria NULL, o NOT EXISTS nunca acharia nada, e o "Entidade respondeu"
                     -- jamais silenciaria a cobranca justamente nessas: o analista clicaria
                     -- e continuaria sendo cobrado, sem entender por que.
                     -- (Sem crase neste comentario: ele vive dentro de um template literal,
                     --  e uma crase aqui encerra a string e quebra o arquivo inteiro.)
                     AND (p.dt_situacao IS NULL OR h.criado_em > p.dt_situacao)) )
        )
      ORDER BY p.prazo_diligencia
      LIMIT $4::int`,
    [DILIG_AVISO_PREVIO, DILIG_COBRANCA, DILIG_COBRANCA_ATE, LIMITE]);
  return rows;
}

/**
 * Data de coluna `date` em AAAA-MM-DD.
 *
 * ⚠️ O driver devolve `date` como OBJETO Date, não como texto. `String(d).slice(0,10)` dava
 * "Fri Aug 14" — apareceu na primeira notificação real, em 11/08. Pior que o texto feio: essa
 * forma ia junto no `ref_id` do dedupe.
 *
 * Usa os getters LOCAIS, e não `toISOString()`: a data vem como meia-noite local, e converter
 * para UTC pode empurrar o dia para trás dependendo do fuso.
 */
function dataIso(d) {
  if (!d) return '';
  if (d instanceof Date)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(d).slice(0, 10);
}

function montarAvisoDiligencia(pc) {
  const onde = `${pc.codigo_pc}${pc.tr ? ` (TR ${pc.tr})` : ''} — ${pc.entidade || 'entidade não informada'}`;
  const prazoIso = dataIso(pc.prazo_diligencia);
  const prazoBr = prazoIso.split('-').reverse().join('/');
  const m = {
    previo:   { t: `Diligência vence em ${pc.dias} dia${pc.dias === 1 ? '' : 's'}`,
                msg: `${onde}. Prazo dado à entidade: ${prazoBr}.`, urgente: false },
    hoje:     { t: 'Diligência vence hoje',
                msg: `${onde}. É o último dia do prazo dado à entidade.`, urgente: true },
    cobranca: { t: `Diligência vencida há ${Math.abs(pc.dias)} dias, sem resposta`,
                msg: `${onde}. Venceu em ${prazoBr} e a entidade não respondeu.`, urgente: true },
  }[pc.faixa];
  return {
    destinatario_id: pc.analista_id,
    tipo: 'diligencia',
    urgente: m.urgente,
    titulo: m.t,
    mensagem: m.msg,
    link: '#planilha',
    ref_tipo: 'pc',
    // O prazo entra na chave: cada RODADA de diligência avisa por conta própria, e a segunda
    // não é confundida com a primeira. A faixa também, senão o aviso do dia seria engolido
    // pelo de 3 dias antes.
    ref_id: `${pc.codigo_pc}|dilig-${pc.faixa}|${prazoIso}`,
    setorial_id: pc.setorial_id || null,
  };
}

function montarAviso(pc) {
  const vencida = pc.dias < 0;
  const onde = `${pc.codigo_pc}${pc.tr ? ` (TR ${pc.tr})` : ''} — ${pc.entidade || 'entidade não informada'}`;
  return {
    destinatario_id: pc.analista_id,
    tipo: 'prazo',
    // Vencida é urgente; a que ainda vai vencer, não. Se as duas fossem urgentes, o vermelho
    // deixaria de significar alguma coisa.
    urgente: vencida,
    titulo: vencida ? 'PC vencida' : 'PC perto do prazo',
    mensagem: vencida
      ? `${onde}. Venceu há ${Math.abs(pc.dias)} dia${Math.abs(pc.dias) === 1 ? '' : 's'}.`
      : `${onde}. Vence em ${pc.dias} dia${pc.dias === 1 ? '' : 's'}.`,
    link: '#planilha',
    ref_tipo: 'pc',
    // A faixa entra na chave: a mesma PC avisa uma vez ao se aproximar e outra ao vencer.
    // Só o `codigo_pc` faria o aviso de vencida nunca sair, engolido pelo de "perto do prazo".
    ref_id: `${pc.codigo_pc}|${vencida ? 'vencida' : 'vence'}`,
    setorial_id: pc.setorial_id || null,
  };
}

async function rodar() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const t0 = Date.now();
  let gravadas = 0, repetidas = 0;

  try {
    const alvos = await buscarAlvos(pool);
    // O corte sai impresso em toda passagem, de propósito: quem for investigar "por que não
    // avisou da PC X" precisa ver a data na hora, sem ter de abrir o código.
    console.log(`corte: ${CORTE_PRAZO} (PC anterior a esta data não gera aviso) · `
              + `faixa: ${DIAS_AVISO_PREVIO} dias · guarda da lida: ${DIAS_GUARDA_LIDA} dias · `
              + `diligência: -${DILIG_AVISO_PREVIO}d / dia / +${DILIG_COBRANCA}d até +${DILIG_COBRANCA_ATE}d`
              + `${DRY ? ' · DRY RUN' : ''}`);
    console.log(`${alvos.length} PC(s) dentro da faixa`);

    for (const pc of alvos) {
      const aviso = montarAviso(pc);
      if (DRY) { console.log(`  [dry] ${aviso.titulo}: ${aviso.mensagem}`); continue; }
      // `criar` devolve null quando o dedupe barrou — é o caso normal a partir da segunda
      // passagem, e não é erro.
      const r = await notificacao.criar(pool, aviso);
      r ? gravadas++ : repetidas++;
    }

    // ── Prazo da diligência ──────────────────────────────────────────────────
    const diligs = await buscarDiligencias(pool);
    console.log(`${diligs.length} diligência(s) na faixa de aviso`);
    for (const pc of diligs) {
      const aviso = montarAvisoDiligencia(pc);
      if (DRY) { console.log(`  [dry] ${aviso.titulo}: ${aviso.mensagem}`); continue; }
      const r = await notificacao.criar(pool, aviso);
      r ? gravadas++ : repetidas++;
    }

    // Limpeza das lidas, na mesma passagem — sem cron novo. Vem DEPOIS de gravar: se a
    // ordem fosse inversa e o job caísse no meio, a limpeza teria rodado sem os avisos novos
    // terem entrado, e a passagem seguinte gastaria uma hora a mais para se acertar.
    let apagadas = 0;
    if (DRY) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int n FROM notificacao
          WHERE lida_em IS NOT NULL AND lida_em < NOW() - (INTERVAL '1 day' * $1::int)`,
        [DIAS_GUARDA_LIDA]);
      console.log(`  [dry] apagaria ${rows[0].n} notificação(ões) lida(s) há mais de ${DIAS_GUARDA_LIDA} dias`);
    } else {
      apagadas = await notificacao.limparLidas(pool, DIAS_GUARDA_LIDA);
    }

    const seg = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`gravadas: ${gravadas} · já avisadas antes: ${repetidas} · `
              + `lidas apagadas: ${apagadas} · ${seg}s`);
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) rodar();

module.exports = {
  buscarAlvos, montarAviso, buscarDiligencias, montarAvisoDiligencia, rodar,
  DIAS_AVISO_PREVIO, CORTE_PRAZO, DIAS_GUARDA_LIDA,
  DILIG_AVISO_PREVIO, DILIG_COBRANCA, DILIG_COBRANCA_ATE,
};
