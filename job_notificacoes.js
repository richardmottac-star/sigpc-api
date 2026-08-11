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
  const { rows } = await pool.query(
    `SELECT codigo_pc, tr, entidade, analista_id, setorial_id, dt_limite_pc,
            (dt_limite_pc::date - CURRENT_DATE) AS dias
       FROM prestacoes_contas
      WHERE analista_id IS NOT NULL
        AND baixada = false
        AND dt_limite_pc IS NOT NULL
        AND dt_limite_pc::date <= CURRENT_DATE + $1
      ORDER BY dt_limite_pc
      LIMIT $2`, [DIAS_AVISO_PREVIO, LIMITE]);
  return rows;
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
    console.log(`${alvos.length} PC(s) dentro da faixa de aviso (${DIAS_AVISO_PREVIO} dias)${DRY ? ' — DRY RUN' : ''}`);

    for (const pc of alvos) {
      const aviso = montarAviso(pc);
      if (DRY) { console.log(`  [dry] ${aviso.titulo}: ${aviso.mensagem}`); continue; }
      // `criar` devolve null quando o dedupe barrou — é o caso normal a partir da segunda
      // passagem, e não é erro.
      const r = await notificacao.criar(pool, aviso);
      r ? gravadas++ : repetidas++;
    }

    const seg = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`gravadas: ${gravadas} · já avisadas antes: ${repetidas} · ${seg}s`);
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) rodar();

module.exports = { buscarAlvos, montarAviso, rodar, DIAS_AVISO_PREVIO };
