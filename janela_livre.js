// CAMINHO: sigpc-api/janela_livre.js
//
// "Da para gravar agora?" — SOMENTE LEITURA. Nao escreve nada, nunca.
//
// Existe porque em 13/08 a Marisa estava com a 2020TR000624 aberta a 00:01 enquanto se
// media a renumeracao. Renumerar com gente na tela troca os numeros sob os pes de quem
// esta trabalhando: quem abriu um parecer na "parcela 21" grava na que VIROU 21.
//
// Uso:   node janela_livre.js          uma foto agora
//        node janela_livre.js --vigiar  reconsulta a cada 2 min ate dar LIVRE
//
// Tres sinais, e os tres tem de estar limpos:
//   1. ninguem online   — mesma regra do sistema: ativo em 30 min E sem logout depois
//   2. nenhuma PC escrita nos ultimos 30 min
//   3. nenhum evento de parcela (parecer/situacao/CI) nos ultimos 30 min

const VIGIAR = process.argv.includes('--vigiar')
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

const JANELA = "30 minutes"

async function medir(cli) {
  const q = async (s) => (await cli.query(s)).rows

  const online = await q(`
    SELECT nome, perfil, to_char((ultimo_acesso AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') visto
      FROM usuarios
     WHERE ultimo_acesso >= NOW() - INTERVAL '${JANELA}'
       AND (sessao_fim IS NULL OR sessao_fim < ultimo_acesso)
     ORDER BY ultimo_acesso DESC`)

  const [pc] = await q(`
    SELECT COUNT(*)::int n, to_char((MAX(atualizado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') ultima
      FROM prestacoes_contas WHERE atualizado_em >= NOW() - INTERVAL '${JANELA}'`)

  const [hist] = await q(`
    SELECT COUNT(*)::int n, to_char((MAX(criado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') ultima
      FROM parcela_historico WHERE criado_em >= NOW() - INTERVAL '${JANELA}'`)

  const [msg] = await q(`
    SELECT COUNT(*)::int n, to_char((MAX(criado_em) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') ultima
      FROM ci_mensagem WHERE criado_em >= NOW() - INTERVAL '${JANELA}'`).catch(() => [{ n: 0 }])

  // O modo manutenção, se ligado, é o motivo de a janela estar livre — e vale dizer, senão
  // o zero parece sorte. Falha aberta: coluna que não existe não pode derrubar a foto.
  let manutencao = null
  try {
    const [m] = await q(`SELECT modo_manutencao FROM config_sistema WHERE id = 1`)
    manutencao = m ? !!m.modo_manutencao : null
  } catch (e) { manutencao = null }

  // o ultimo sinal de vida, seja de quem for — ajuda a estimar quanto falta esperar
  const [ult] = await q(`
    SELECT to_char((MAX(t) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') quando,
           GREATEST(0, 30 - EXTRACT(EPOCH FROM (NOW() - MAX(t)))/60)::int faltam
      FROM (SELECT MAX(ultimo_acesso) t FROM usuarios
            UNION ALL SELECT MAX(atualizado_em) FROM prestacoes_contas
            UNION ALL SELECT MAX(criado_em) FROM parcela_historico) x`)

  // ⚠️ O SUPERADMIN NÃO BLOQUEIA A JANELA — medido em 12/08, e sem isto o modo manutenção
  // não serviria para nada.
  //
  // Ligar a manutenção carimba `sessao_fim` em todos MENOS no superadmin, de propósito: é
  // ele quem precisa continuar entrando. Só que ele é o mesmo que está com a tela aberta
  // (acabou de clicar no interruptor), então continua contando como online — e a janela
  // nunca daria LIVRE. Justamente o que o modo existe para resolver.
  //
  // Excluí-lo é seguro porque quem grava é ELE, sabendo o que está fazendo, e porque uma
  // escrita real dele ainda aparece nos três contadores abaixo. O que se quer saber aqui é
  // "há mais alguém trabalhando?".
  const bloqueiam = online.filter(u => u.perfil !== 'superadmin')
  const admins    = online.filter(u => u.perfil === 'superadmin')

  return { online, bloqueiam, admins, pc, hist, msg, ult, manutencao,
           livre: !bloqueiam.length && !pc.n && !hist.n && !msg.n }
}

function mostrar(m) {
  const hora = new Date().toLocaleTimeString('pt-BR')
  console.log(`\n──────── ${hora} ────────`)
  if (m.manutencao === true)  console.log('  🔒 MODO MANUTENCAO LIGADO — ninguem alem do superadmin entra')
  if (m.manutencao === false) console.log('  modo manutencao ............... desligado')
  console.log(`  online agora .................. ${m.bloqueiam.length}`)
  m.bloqueiam.forEach(u => console.log(`     · ${u.nome} (${u.perfil}) — visto ${u.visto}`))
  // Mostrado, mas fora da conta: o superadmin é quem grava, e uma escrita dele apareceria
  // nos contadores abaixo. Some-lo da tela faria o número parecer errado.
  m.admins.forEach(u => console.log(`     · ${u.nome} (superadmin — nao bloqueia) — visto ${u.visto}`))
  console.log(`  PCs escritas em 30 min ........ ${m.pc.n}${m.pc.ultima ? '   ultima ' + m.pc.ultima : ''}`)
  console.log(`  eventos de parcela em 30 min .. ${m.hist.n}${m.hist.ultima ? '   ultimo ' + m.hist.ultima : ''}`)
  console.log(`  mensagens do C.I. em 30 min ... ${m.msg.n}${m.msg.ultima ? '   ultima ' + m.msg.ultima : ''}`)
  if (m.livre) {
    console.log(`\n  >> LIVRE. Da para gravar.`)
    console.log(`     node renumerar_parcial_num.js --gravar`)
  } else {
    console.log(`\n  >> OCUPADO. NAO grave.`)
    if (m.ult?.quando) console.log(`     ultimo sinal de vida: ${m.ult.quando} — livre em ~${m.ult.faltam} min se ninguem voltar.`)
  }
}

;(async () => {
  const cli = await pool.connect()
  try {
    for (;;) {
      const m = await medir(cli)
      mostrar(m)
      if (m.livre || !VIGIAR) { process.exitCode = m.livre ? 0 : 1; break }
      await new Promise(r => setTimeout(r, 120000))
    }
  } catch (e) { console.error('ERRO: ' + e.message); process.exitCode = 2 }
  finally { cli.release(); await pool.end() }
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(2) })
