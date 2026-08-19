const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const compression = require('compression');
const {
  normalizarProcesso, formatarProcesso, siglaConhecida, montarUrlSgpe,
  ProcessoNaoEncontrado, SessaoExpirada,
} = require('./lib/sgpe-link');
const { resolverNoSgpe, temSessaoSgpe } = require('./lib/sgpe-dwr');
const { linksDeLinhas, gravarResolvido, gravarNegativa } = require('./lib/sgpe-lote');

const { semAcento, condicaoBusca } = require('./lib/busca');
const limiteTr = require('./lib/limite-tr');
const notif = require('./lib/notificacao');
const { HOJE_BR } = require('./lib/datas');
const faixa = require('./lib/faixa');
const auth = require('./lib/auth');
const prep = require('./lib/preparacao');
const manut = require('./lib/manutencao');
const ci = require('./lib/ci');
const devol = require('./lib/devolucao');
// ⚠️ NÃO É A MESMA COISA que `devol`: aquela é a devolução do superadmin, que executa na
// hora; esta é o PEDIDO do analista, que espera decisão. Quando o pedido é aprovado, quem
// devolve de fato continua sendo a `devol` — na mesma transação.
const devolPed = require('./lib/devolucao-pedido');
const autoria = require('./lib/autoria');
const papel = require('./lib/papel');

/**
 * O usuário, lido do BANCO — inclusive o `papel_ativo`.
 *
 * ⚠️ Declarada AQUI, no topo, porque a guarda de papel a usa em rotas que vêm muito antes da
 * seção do pedido de devolução. Função declarada com `function` sobe (hoisting); a antiga,
 * lá embaixo, foi removida para não haver duas.
 */
async function lerUsuario(cli, id) {
  const { rows } = await cli.query(
    `SELECT id, nome, perfil, grupo, ativo, papel_ativo FROM usuarios WHERE id = $1`,
    [parseInt(id) || 0]);
  return rows[0] || null;
}
const procEdit = require('./lib/processo-edit');
const assumir = require('./lib/assumir');
const bg = require('./lib/busca-global');
const dup = require('./lib/duplicata');
// As quatro frentes de 18/08/2026: corrigir situação, puxar do C.I., cadastrar PC e o
// pedido de correção ao coordenador. A regra mora nas libs; aqui só a transação e o perfil.
const correcao = require('./lib/correcao');
const pcNova = require('./lib/pc-nova');
const solCor = require('./lib/solicitacao-correcao');

const app = express();
app.use(cors());

// ⚠️ COMPRESSÃO — medido em 11/08, véspera da abertura aos 47 analistas:
//     GET /prestacoes_contas  →  11.330.330 bytes · 3,1 s
// SEIS telas do `index.html` chamam `fetchTodasPCs()`, que baixa as 14.652 linhas inteiras.
// Com 47 pessoas entrando na mesma manhã, era a primeira coisa que ia doer. Com gzip o
// mesmo corpo cai para ~1 MB.
//
// Vem ANTES de `express.json` e das rotas: o middleware precisa envolver a resposta antes
// de qualquer handler escrever nela.
app.use(compression());

app.use(express.json({ limit: '5mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

// ══════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'ok', sistema: 'SIGPC-GT API', versao: '1.0.0' });
});

// ══════════════════════════════════════
//  HELPER: montar WHERE dinâmico
// ══════════════════════════════════════
function buildWhere(filters) {
  const conditions = [];
  const values = [];
  let i = 1;
  for (const [col, val] of Object.entries(filters)) {
    if (val === undefined || val === null || val === '') continue;
    if (typeof val === 'object' && val.op === 'ilike') {
      conditions.push(`${col} ILIKE $${i++}`);
      values.push(`%${val.val}%`);
    } else if (typeof val === 'object' && val.op === 'or_ilike') {
      const cols = val.cols.map(c => `${c} ILIKE $${i++}`);
      val.cols.forEach(() => values.push(`%${val.val}%`));
      conditions.push(`(${cols.join(' OR ')})`);
    } else if (typeof val === 'object' && val.op === 'in') {
      conditions.push(`${col} = ANY($${i++})`);
      values.push(val.vals);
    } else {
      conditions.push(`${col} = $${i++}`);
      values.push(val);
    }
  }
  return {
    where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '',
    values
  };
}

// ══════════════════════════════════════
//  USUARIOS
// ══════════════════════════════════════
app.get('/usuarios', async (req, res) => {
  try {
    const { cpf, setorial_id, perfil, grupo, ativo, aguardando_aprovacao } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (cpf) { conditions.push(`cpf = $${i++}`); values.push(cpf); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (perfil) { conditions.push(`perfil = $${i++}`); values.push(perfil); }
    if (grupo) { conditions.push(`grupo = $${i++}`); values.push(grupo); }
    if (ativo !== undefined) { conditions.push(`ativo = $${i++}`); values.push(ativo === 'true'); }
    if (aguardando_aprovacao !== undefined) { conditions.push(`aguardando_aprovacao = $${i++}`); values.push(aguardando_aprovacao === 'true'); }
    // Suporte a _gte_ultimo_acesso para "online agora"
    const gteUltimoAcesso = req.query['_gte_ultimo_acesso'];
    if (gteUltimoAcesso) { conditions.push(`ultimo_acesso >= $${i++}`); values.push(gteUltimoAcesso); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(`SELECT * FROM usuarios ${where} ORDER BY nome`, values);
    // ⚠️ `senha_hash` NUNCA sai daqui — ver o cabeçalho de lib/auth.js. Até 11/08 esta rota
    // devolvia as 49 senhas em texto puro a quem pedisse, sem nenhuma credencial.
    res.json({ data: rows.map(auth.semSegredo), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  QUEM ESTÁ ONLINE
// ══════════════════════════════════════
// ⚠️ TAMBÉM ANTES DE "/usuarios/:id" — ver o aviso longo logo abaixo.
//
// "Online" é: esteve ativo nos últimos 30 min **E** não encerrou a sessão depois disso.
//
// A segunda metade é a novidade de 12/08. Antes, quem clicava em Sair continuava na lista
// por meia hora, porque `ultimo_acesso` não sabia que a sessão tinha acabado.
//
// ⚠️ POR QUE UMA COLUNA NOVA, E NÃO RECUAR `ultimo_acesso` NO LOGOUT:
// o Painel ADMIN mostra "Último Acesso" numa coluna. Recuá-lo resolveria a lista e faria
// aquela coluna mentir — trocar informação verdadeira por efeito de tela.
//
// E o estado se cura sozinho: ao entrar de novo, `ultimo_acesso` passa a ser maior que
// `sessao_fim` e a pessoa volta à lista. Não há nada para limpar.
const ONLINE_MIN = 30;

app.get('/usuarios/online', async (req, res) => {
  try {
    const cond = [`ultimo_acesso >= NOW() - INTERVAL '${ONLINE_MIN} minutes'`,
                  `(sessao_fim IS NULL OR sessao_fim < ultimo_acesso)`,
                  `ativo = true`];
    const val = [];
    if (req.query.setorial_id) { val.push(req.query.setorial_id); cond.push(`setorial_id = $${val.length}`); }
    // Só o que a lista desenha. `foto_base64` é pesado (até 200 KB por pessoa) e por isso
    // vem apenas de quem está online — tipicamente menos de dez.
    const { rows } = await pool.query(
      `SELECT id, nome, perfil, grupo, foto_base64, ultimo_acesso
         FROM usuarios WHERE ${cond.join(' AND ')} ORDER BY nome`, val);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    // A lista é adorno do cabeçalho: erro nela não pode derrubar nada.
    res.json({ data: [], count: 0, error: null });
  }
});

// POST /usuarios/logout  body { id } — encerra a sessão e tira da lista na hora.
app.post('/usuarios/logout', async (req, res) => {
  try {
    const id = parseInt((req.body || {}).id) || 0;
    if (!id) return res.status(400).json({ data: null, error: { message: 'id é obrigatório' } });
    // ⚠️ clock_timestamp(), nao NOW(): no Postgres o NOW() e o instante em que a
    // TRANSACAO comecou, e nao o do comando. Com NOW() dos dois lados, sair e entrar no
    // mesmo instante daria carimbos IGUAIS e o `sessao_fim < ultimo_acesso` nao valeria —
    // a pessoa ficaria fora da lista mesmo tendo voltado. Apareceu no teste contra o banco.
    await pool.query(`UPDATE usuarios SET sessao_fim = clock_timestamp() WHERE id = $1`, [id]);
    res.json({ data: { id }, error: null });
  } catch (e) {
    // Sair nunca pode falhar por causa disto — quem sai, sai.
    res.json({ data: null, error: null });
  }
});

// ⚠️ ESTA ROTA TEM DE VIR ANTES DE "/usuarios/:id" — NÃO É ESTILO, É OBRIGATÓRIO.
//
// O Express casa na ORDEM em que as rotas são declaradas. Com "/usuarios/:id" declarada
// primeiro, "/usuarios/pendentes" caía nela com id = "pendentes", e o Postgres respondia
// `invalid input syntax for type integer`.
//
// Foi exatamente o que aconteceu no deploy de 12/08: HTTP 500 em produção. O teste com
// dublê não pegou porque dublê não roteia — quem roteia é o Express. Há teste em
// teste_duplicata.js que falha se a ordem inverter, e um HTTP em teste_http_auth.js.
// GET /usuarios/pendentes — os que aguardam aprovação, já com os candidatos a duplicata
// e a contagem de PCs de cada lado. É o que a fila do Painel ADMIN consome.
app.get('/usuarios/pendentes', async (req, res) => {
  try {
    // ⚠️ O FILTRO DE SETORIAL NÃO ESCONDE PENDENTE. Ele recorta só o universo em que se
    // procura duplicata.
    //
    // Em 12/08 a Marlene escolheu "SED" no Primeiro Acesso — a única SED de um cadastro
    // com 56 pessoas, num sistema em que a setorial é sempre FCEE. Com o filtro no WHERE,
    // ela SUMIU da fila de aprovação: ninguém ia aprová-la, e ninguém ia saber por quê.
    //
    // Quem espera aprovação sempre aparece. O que a setorial diferente vira é um AVISO.
    const { rows } = await pool.query(`
      SELECT u.*,
             (SELECT COUNT(*)::int FROM prestacoes_contas WHERE analista_id = u.id) AS pcs,
             (SELECT COUNT(*)::int FROM prestacoes_contas WHERE analista_id = u.id AND baixada) AS baixas
        FROM usuarios u
       ORDER BY u.criado_em`);

    const setorial = req.query.setorial_id || null;
    const pendentes = rows
      .filter(u => u.aguardando_aprovacao)
      .map(u => ({ ...u, outra_setorial: !!(setorial && u.setorial_id !== setorial) }));
    // A busca por duplicata varre o cadastro INTEIRO, e não só a setorial filtrada: a conta
    // antiga da Marlene é FCEE e a nova é SED — recortar por setorial esconderia justamente
    // a duplicata que interessa.
    const analisados = dup.analisar(pendentes, rows).map(p => ({
      ...auth.semSegredo(p),
      candidatos: p.candidatos.map(c => ({
        nivel: c.nivel, motivo: c.motivo, usuario: auth.semSegredo(c.usuario),
      })),
    }));
    res.json({ data: analisados, count: analisados.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.get('/usuarios/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
    res.json({ data: rows.map(auth.semSegredo), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════
// POST /usuarios/login  body { cpf, senha, setorial }
//
// ⚠️ ESTA ROTA NÃO EXISTIA ANTES DE 11/08/2026. O login inteiro acontecia no navegador: o
// front pedia a linha do usuário — com a senha — e comparava em JavaScript. Ver o cabeçalho
// de lib/auth.js para o que isso significava na prática.
//
// A conferência do CPF é por DÍGITOS, e não pelo texto: o mesmo CPF aparece formatado de
// jeitos diferentes conforme tenha vindo da planilha ou do formulário. É a mesma regra que
// `primeiro_acesso` já usava — o login usava igualdade exata e recusava quem tivesse o CPF
// gravado noutro formato.
app.post('/usuarios/login', async (req, res) => {
  try {
    const { cpf, senha, setorial } = req.body || {};
    if (!cpf || !senha || !setorial)
      return res.status(400).json({ data: null, error: { message: 'Preencha todos os campos.' } });

    const { rows } = await pool.query(
      `SELECT * FROM usuarios
        WHERE regexp_replace(cpf, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')
        LIMIT 1`, [String(cpf)]);
    const u = rows[0];

    // Mesma resposta para CPF inexistente e senha errada. Respostas diferentes contariam a
    // quem tentasse quais CPFs existem no sistema.
    const RECUSA = 'CPF ou senha incorretos.';
    if (!u) return res.status(401).json({ data: null, error: { message: RECUSA } });

    const { ok, precisaRehash } = await auth.conferir(senha, u.senha_hash);
    if (!ok) return res.status(401).json({ data: null, error: { message: RECUSA } });

    // A senha confere. Agora as regras de entrada — que davam mensagem própria antes e
    // continuam dando: quem acertou a senha merece saber por que ainda não entrou.
    //
    // ⚠️ A MANUTENÇÃO É CONFERIDA AQUI, e não antes da senha: a recusa por manutenção conta
    // que o sistema está fechado, e contar isso a quem nem provou a senha entrega estado do
    // sistema a qualquer um que bata na porta. Quem errou a senha continua lendo só
    // "CPF ou senha incorretos".
    const cfg = await prep.ler(pool);
    const emManutencao = manut.barra(cfg, u) ? manut.recusa(cfg) : null;
    const recusa = auth.podeEntrar(u, setorial, emManutencao);
    if (recusa)
      return res.status(403).json({
        data: null,
        // `manutencao: true` é o que faz a tela de login desenhar o cadeado em vez de uma
        // faixa de erro vermelha. É recado do sistema, não erro da pessoa.
        error: { message: recusa, manutencao: !!emManutencao },
      });

    // ⚠️ A SENHA EM TEXTO PURO VIRA HASH AQUI, no login que a provou.
    //
    // É o que migra as 49 senhas antigas sem exigir um dia de parada: cada pessoa que entra
    // converte a sua. A escrita grava exatamente a senha que a pessoa acabou de digitar
    // certo, na linha dela — não muda o que ninguém sabe, nem exige que decorem outra.
    //
    // Falhar aqui não pode barrar a entrada: se o UPDATE não for, ela entra igual e a
    // conversão acontece no próximo login.
    if (precisaRehash) {
      try {
        await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2',
                         [await auth.hashSenha(senha), u.id]);
      } catch (e) {
        console.error('Falha ao converter senha para hash (usuario ' + u.id + '):', e.message);
      }
    }

    // Carimba o acesso aqui, e não numa chamada separada da tela: é o servidor que sabe que
    // o login aconteceu de verdade.
    pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [u.id]).catch(() => {});

    // ⚠️ O PAPEL VOLTA PARA 'analista' A CADA LOGIN. Se ele sobrevivesse à sessão, uma
    // entrada de manhã continuaria com o acesso de ontem à noite, e trocar deixaria de ser
    // ato deliberado. O reset é do SERVIDOR: o navegador não tem como esquecer de fazê-lo.
    if (u.perfil === papel.PERFIL_COM_PAPEL) {
      try {
        const { rows: mudou } = await pool.query(papel.SQL_RESETAR_NO_LOGIN, [u.id]);
        u.papel_ativo = papel.PADRAO;
        // Só registra quando REALMENTE mudou: uma linha por login normal encheria a trilha
        // de ruído e esconderia a troca deliberada, que é o que se quer enxergar.
        if (mudou.length) await pool.query(papel.SQL_REGISTRAR, [u.id, papel.PADRAO, 'login']);
      } catch (e) { console.error('Falha ao resetar papel no login:', e.message); }
    }

    res.json({ data: auth.semSegredo(u), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /usuarios/trocar_senha  body { id, senha_atual, senha_nova }
//
// Troca a própria senha, provando a atual. É por aqui que passa a troca obrigatória do
// primeiro acesso — em 11/08, 44 dos 50 usuários compartilhavam UMA senha.
//
// Exige a senha atual mesmo na troca obrigatória: sem isso, bastaria conhecer o `id` de
// alguém para trocar a senha dele por uma rota pública.
app.post('/usuarios/trocar_senha', async (req, res) => {
  try {
    const { id, senha_atual, senha_nova } = req.body || {};
    if (!id) return res.status(400).json({ data: null, error: { message: 'id é obrigatório' } });

    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [parseInt(id) || 0]);
    const u = rows[0];
    if (!u) return res.status(404).json({ data: null, error: { message: 'Usuário não encontrado' } });

    const { ok } = await auth.conferir(senha_atual, u.senha_hash);
    if (!ok) return res.status(401).json({ data: null, error: { message: 'A senha atual está incorreta.' } });

    const erro = auth.validarSenhaNova(senha_nova, senha_atual);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    const atualizado = await pool.query(
      `UPDATE usuarios SET senha_hash = $1, senha_provisoria = false WHERE id = $2 RETURNING *`,
      [await auth.hashSenha(senha_nova), u.id]);

    res.json({ data: auth.semSegredo(atualizado.rows[0]), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/usuarios', async (req, res) => {
  try {
    const b = req.body;
    // A senha chega em texto e sai daqui como hash. O campo continua se chamando
    // `senha_hash` no corpo do pedido — o nome sempre foi esse, o que mudou é ele passar a
    // ser verdade. Nasce provisória: quem escolheu a senha foi o admin, não a pessoa.
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, cpf, senha_hash, perfil, setorial_id, grupo, ativo,
                             matricula, portaria, data_ingresso, data_saida, meta_mensal,
                             senha_provisoria, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,NOW()) RETURNING *`,
      [b.nome, b.cpf, b.senha_hash ? await auth.hashSenha(b.senha_hash) : null,
       b.perfil, b.setorial_id, b.grupo ?? null, b.ativo ?? true,
       b.matricula ?? null, b.portaria ?? null, b.data_ingresso ?? null, b.data_saida ?? null, b.meta_mensal ?? 10]
    );
    res.json({ data: auth.semSegredo(rows[0]), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Campos que podem ser alterados via PATCH /usuarios/:id
const USUARIOS_PATCH_PERMITIDOS = [
  'nome', 'cpf', 'perfil', 'setorial_id', 'grupo', 'ativo', 'senha_hash', 'ultimo_acesso',
  'regiao', 'municipio', 'telefone', 'email', 'nucleo', 'foto_base64', 'aprovado', 'aguardando_aprovacao',
  'matricula', 'portaria', 'data_ingresso', 'data_saida', 'meta_mensal', 'senha_provisoria'
];

app.patch('/usuarios/:id', async (req, res) => {
  try {
    // ⚠️ ESTA ROTA É O HEARTBEAT, E SEM ESTA TRAVA O MODO MANUTENÇÃO NÃO SEGURA.
    //
    // `onlineCarregar()` no index.html roda de 5 em 5 minutos e a primeira coisa que faz é
    // PATCH /usuarios/:id com `ultimo_acesso = agora`. Ligar a manutenção carimba
    // `sessao_fim` em todo mundo e zera a lista de online — mas o próximo heartbeat de
    // QUALQUER aba ainda aberta levantaria `ultimo_acesso` acima de `sessao_fim` e a pessoa
    // reapareceria online, sem ninguém ter feito nada. A janela de escrita se fecharia
    // sozinha em até cinco minutos.
    //
    // Barrando aqui, o carimbo não se desfaz e o zero é estável.
    //
    // Barra pelo ALVO do PATCH (`:id`), não por quem pediu: o corpo não traz autor, e o
    // heartbeat de cada pessoa escreve na própria linha. O superadmin segue passando —
    // inclusive para redefinir a senha de alguém durante a manutenção, se precisar.
    const cfgM = await prep.ler(pool);
    const barrado = await manut.bloqueio(pool, cfgM, req.params.id);
    if (barrado) return res.status(503).json({ data: null, error: { message: barrado, manutencao: true } });

    const b = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(b)) {
      if (!USUARIOS_PATCH_PERMITIDOS.includes(k)) continue;
      if (k === 'senha_hash') {
        // ⚠️ Senha que entra por aqui é o admin redefinindo a de outra pessoa. Vira hash, e
        // vira PROVISÓRIA: quem escolheu não foi o dono. Sem esta linha, a redefinição pelo
        // painel devolveria o usuário à situação que estamos justamente desfazendo.
        if (v === null || v === undefined || String(v) === '') continue;
        sets.push(`senha_hash = $${i++}`);
        values.push(await auth.hashSenha(v));
        if (b.senha_provisoria === undefined) {
          sets.push(`senha_provisoria = $${i++}`);
          values.push(true);
        }
        continue;
      }
      sets.push(`${k} = $${i++}`);
      values.push(v);
    }
    if (sets.length === 0)
      return res.status(400).json({ data: null, error: { message: 'Nenhum campo permitido informado' } });
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: auth.semSegredo(rows[0]), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// DELETE /usuarios/:id — só exclui se não houver PC vinculada (analista_id) em prestacoes_contas
// body { perfil } — só superadmin pode excluir
app.delete('/usuarios/:id', async (req, res) => {
  try {
    // ⚠️ O perfil vem do BANCO, pelo usuario_id — o `perfil` do corpo nunca provou nada,
    // e com a troca de papel ele passaria por cima da guarda inteira.
    const quem = await lerUsuario(pool, (req.body || {}).usuario_id);
    if (papel.perfilEfetivo(quem) !== 'superadmin')
      return res.status(403).json({ data: null, error: { message: 'Apenas superadmin pode excluir usuários' } });
    const id = parseInt(req.params.id);
    const vinc = await pool.query('SELECT COUNT(*) FROM prestacoes_contas WHERE analista_id = $1', [id]);
    const qtd = parseInt(vinc.rows[0].count);
    if (qtd > 0)
      return res.status(409).json({
        data: null,
        error: { message: `Este usuário tem ${qtd} PC${qtd > 1 ? 's' : ''} vinculada${qtd > 1 ? 's' : ''} e não pode ser excluído. Use Desativar para bloquear o acesso sem perder o histórico.` }
      });
    const { rows } = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [id]);
    if (!rows.length)
      return res.status(404).json({ data: null, error: { message: 'Usuário não encontrado' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /usuarios/primeiro_acesso — rota pública de autocadastro do analista, fica aguardando aprovação
app.post('/usuarios/primeiro_acesso', async (req, res) => {
  try {
    const { nome, cpf, email, telefone, regiao, municipio, nucleo, senha_hash, setorial_id } = req.body;
    if (!nome || !cpf || !senha_hash || !setorial_id)
      return res.status(400).json({ data: null, error: { message: 'Preencha nome, CPF, senha e setorial.' } });

    // A pessoa escolhe a própria senha aqui — então ela NÃO nasce provisória, ao contrário
    // da criada pelo admin em POST /usuarios. Mas passa pela mesma régua: quem se cadastra
    // hoje não pode entrar com '123456'.
    const erroSenha = auth.validarSenhaNova(senha_hash, null);
    if (erroSenha) return res.status(400).json({ data: null, error: { message: erroSenha } });
    const senhaGuardar = await auth.hashSenha(senha_hash);

    // Compara só os dígitos do CPF — planilha e formulário podem formatar diferente
    const existente = await pool.query(
      `SELECT id, senha_hash, ativo, aprovado, aguardando_aprovacao
       FROM usuarios
       WHERE regexp_replace(cpf, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')`,
      [cpf]
    );

    // ⚠️ CPF QUE JÁ EXISTE É RECUSADO, EM QUALQUER ESTADO (12/08/2026).
    //
    // Antes, só o cadastro "completo e ativo" era recusado; o resto era atualizado em
    // silêncio, e a pessoa não entendia o que tinha acontecido. Agora a recusa é sempre, e
    // a frase diz o caminho: voltar ao login e usar a senha provisória.
    //
    // A conferência é AQUI, e não só na tela: a tela pode ser contornada, e é este INSERT
    // que cria a conta duplicada.
    //
    // ⚠️ ISTO NÃO RESOLVE SOZINHO O CASO DE 12/08. As três duplicatas nasceram porque as
    // contas antigas NÃO TÊM CPF — a busca por CPF não achava nada e o INSERT seguia. Quem
    // pega esse caso é o aviso de duplicidade na fila de aprovação, por nome.
    if (existente.rows.length > 0) {
      return res.status(409).json({
        data: null,
        error: {
          message: 'Você já tem cadastro no SIGPC-GT. Não é preciso solicitar acesso — volte à ' +
                   'tela de entrada e use este CPF com a senha Sigpc@2026. O sistema vai pedir ' +
                   'uma senha nova, e depois você atualiza seus dados em Meu Perfil.',
          ja_cadastrado: true,
        },
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO usuarios
         (nome, cpf, email, telefone, regiao, municipio, nucleo, senha_hash, setorial_id,
          perfil, ativo, aprovado, aguardando_aprovacao, grupo, senha_provisoria, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'analista',false,false,true,NULL,false,NOW())
       RETURNING id, nome, cpf`,
      [nome, cpf, email || null, telefone || null, regiao || null, municipio || null, nucleo || null, senhaGuardar, setorial_id]
    );
    res.json({
      data: rows[0],
      error: null,
      message: 'Cadastro realizado! Aguarde a aprovação do seu coordenador para acessar o sistema.'
    });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  DUPLICIDADE DE CADASTRO
// ══════════════════════════════════════
// A regra e o porquê estão em lib/duplicata.js — inclusive o falso positivo que ela evita.

// POST /usuarios/mesclar  body { id_novo, id_existente, autor_id }
//
// Copia para o cadastro ANTIGO o que ele não tem (CPF, e-mail, telefone) e apaga o novo.
// O antigo é o que carrega as PCs e as baixas — é ele que sobrevive, sempre.
app.post('/usuarios/mesclar', async (req, res) => {
  const cli = await pool.connect();
  try {
    const { id_novo, id_existente, autor_id } = req.body || {};

    const q = await pool.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(autor_id) || 0]);
    const autor = q.rows[0];
    if (!autor || !['coordenador', 'superadmin'].includes(papel.perfilEfetivo(autor)))
      return res.status(403).json({ data: null, error: { message: 'Só coordenador ou superadmin pode mesclar cadastros.' } });

    await cli.query('BEGIN');
    const { rows } = await cli.query(`
      SELECT u.*, (SELECT COUNT(*)::int FROM prestacoes_contas WHERE analista_id = u.id) AS pcs
        FROM usuarios u WHERE u.id = ANY($1) FOR UPDATE`,
      [[parseInt(id_novo) || 0, parseInt(id_existente) || 0]]);

    const novo  = rows.find(u => u.id === parseInt(id_novo));
    const velho = rows.find(u => u.id === parseInt(id_existente));
    const plano = dup.planoMesclagem(novo, velho);
    if (plano.erro) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: plano.erro } });
    }

    // ⚠️ A ORDEM IMPORTA: APAGA PRIMEIRO, COPIA DEPOIS.
    //
    // `usuarios` tem `UNIQUE (cpf)`. Copiando o CPF para a conta antiga antes de apagar a
    // nova, as duas ficam com o mesmo CPF por um instante e o Postgres recusa com
    // `duplicate key value violates unique constraint "usuarios_cpf_key"`. Foi o que
    // aconteceu na primeira tentativa real, em 12/08 — a transação desfez tudo, mas a
    // mesclagem não acontecia nunca.
    //
    // Apagar primeiro é seguro porque o plano já provou que o cadastro novo tem 0 PC: não
    // há histórico para perder, e as duas operações estão na mesma transação.

    // Lista explícita de id — regra 12 do CLAUDE.md, WHERE de exclusão nunca derivado.
    await cli.query(`DELETE FROM usuarios WHERE id = $1`, [novo.id]);

    const sets = [], vals = [];
    Object.entries(plano.copiar).forEach(([k, v]) => { sets.push(`${k} = $${sets.length + 1}`); vals.push(v); });
    if (sets.length) {
      vals.push(velho.id);
      await cli.query(`UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    }

    await cli.query('COMMIT');

    res.json({ data: { copiado: plano.copiar, excluido: novo.id, mantido: velho.id }, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// PATCH /usuarios/:id/aprovar — body opcional { grupo }
// ══════════════════════════════════════
//  TROCA DE PAPEL DO SUPERADMIN  (14/08/2026)
// ══════════════════════════════════════
// ⚠️ ROTA DE NOME FIXO ANTES DA `/usuarios/:id` genérica? Não é o caso aqui: `:id/papel` tem
// um segmento a mais, e o Express casa pelo formato inteiro. Mas fica ao lado das outras
// `/:id/...` de propósito, para não se perder no meio das rotas de trabalho.
//
// PATCH /usuarios/:id/papel — body { papel, usuario_id }
app.patch('/usuarios/:id/papel', async (req, res) => {
  const b = req.body || {};
  const cli = await pool.connect();
  try {
    // Quem pede é lido do BANCO. O corpo diz o que quer; o banco diz quem é.
    const quem = await lerUsuario(cli, b.usuario_id);
    const erro = papel.validarTroca(quem, req.params.id, b.papel);
    if (erro) return res.status(quem ? 403 : 401).json({ data: null, error: { message: erro } });

    await cli.query('BEGIN');
    const { rows } = await cli.query(papel.SQL_TROCAR, [quem.id, b.papel]);
    if (!rows.length) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Usuário não encontrado.' } });
    }
    // ⚠️ O registro vai na MESMA transação da troca. Fora dela, uma falha depois do UPDATE
    // deixaria o papel trocado sem nada dizendo quando — e é justamente o quando que o
    // Richard pediu para registrar.
    await cli.query(papel.SQL_REGISTRAR, [quem.id, b.papel, 'troca']);
    await cli.query('COMMIT');

    res.json({ data: rows[0], error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// GET /usuarios/:id/papel — o papel de agora e as últimas trocas.
app.get('/usuarios/:id/papel', async (req, res) => {
  try {
    const u = await lerUsuario(pool, req.params.id);
    if (!u) return res.status(404).json({ data: null, error: { message: 'Usuário não encontrado.' } });
    const { rows } = await pool.query(
      `SELECT papel, origem, criado_em FROM papel_historico
        WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT 20`, [u.id]);
    res.json({ data: { papel_ativo: u.papel_ativo || papel.PADRAO,
                       pode_trocar: papel.podeTrocar(u), historico: rows }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.patch('/usuarios/:id/aprovar', async (req, res) => {
  try {
    const { grupo } = req.body || {};
    const sets = ['ativo = true', 'aprovado = true', 'aguardando_aprovacao = false'];
    const values = [];
    let i = 1;
    if (grupo !== undefined && grupo !== null && grupo !== '') {
      sets.push(`grupo = $${i++}`);
      values.push(parseInt(grupo));
    }
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!rows.length)
      return res.status(404).json({ data: null, error: { message: 'Usuário não encontrado' } });
    res.json({ data: auth.semSegredo(rows[0]), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /usuarios/:id/rejeitar — remove o cadastro pendente (permite que a pessoa se cadastre de novo)
app.patch('/usuarios/:id/rejeitar', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM usuarios WHERE id = $1 AND aguardando_aprovacao = true RETURNING id',
      [req.params.id]
    );
    if (!rows.length)
      return res.status(404).json({ data: null, error: { message: 'Usuário não encontrado ou não está aguardando aprovação' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  SETORIAIS
// ══════════════════════════════════════
app.get('/setoriais', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM setoriais ORDER BY nome');
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  ESTOQUE
// ══════════════════════════════════════
app.get('/estoque', async (req, res) => {
  try {
    const { setorial_id, status, busca, tr, parcela, limit = 9999, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (status) { conditions.push(`status = $${i++}`); values.push(status); }
    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    if (parcela) { conditions.push(`parcela = $${i++}`); values.push(parcela); }
    if (busca) {
      conditions.push(`(tr ILIKE $${i} OR beneficiario ILIKE $${i})`);
      values.push(`%${busca}%`); i++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM estoque ${where}`, values);
    const { rows } = await pool.query(
      `SELECT * FROM estoque ${where} ORDER BY tr LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.get('/estoque/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM estoque WHERE id = $1', [req.params.id]);
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.patch('/estoque/:id', async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(b)) {
      sets.push(`${k} = $${i++}`);
      values.push(v);
    }
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE estoque SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  PLANILHA_ANALISTA
// ══════════════════════════════════════
app.get('/planilha_analista', async (req, res) => {
  try {
    const { analista, setorial_id, situacao, busca, limit = 9999, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (analista) { conditions.push(`analista ILIKE $${i++}`); values.push(`${analista}%`); }
    if (situacao) { conditions.push(`situacao = $${i++}`); values.push(situacao); }
    if (busca) {
      conditions.push(`(tr ILIKE $${i} OR beneficiario ILIKE $${i} OR processo_sgp ILIKE $${i})`);
      values.push(`%${busca}%`); i++;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM planilha_analista ${where}`, values);
    const { rows } = await pool.query(
      `SELECT * FROM planilha_analista ${where} ORDER BY analista, tr LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.patch('/planilha_analista/:id', async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(b)) {
      sets.push(`${k} = $${i++}`);
      values.push(v);
    }
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE planilha_analista SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});


// POST /planilha_analista — inserir registro (usado ao assumir TR)
app.post('/planilha_analista', async (req, res) => {
  try {
    const b = req.body;
    const cols = Object.keys(b);
    const vals = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map(k => b[k]);
    const { rows } = await pool.query(
      `INSERT INTO planilha_analista (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Rota dedicada: grupos por analista (para produtividade)
app.get('/estoque/grupos-analistas', async (req, res) => {
  try {
    const { setorial_id } = req.query;
    const where = setorial_id ? 'WHERE setorial_id = $1 AND tecnico_nome IS NOT NULL' : 'WHERE tecnico_nome IS NOT NULL';
    const values = setorial_id ? [setorial_id] : [];
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (tecnico_nome) tecnico_nome, grupo FROM estoque ${where} ORDER BY tecnico_nome, grupo`,
      values
    );
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Rota planilha com JOIN no estoque (para Minha Planilha completa)
app.get('/planilha_analista/completa', async (req, res) => {
  try {
    const { analista, setorial_id, situacao, limit = 9999, offset = 0 } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (setorial_id) { conditions.push(`p.setorial_id = $${i++}`); values.push(setorial_id); }
    if (analista) { conditions.push(`p.analista ILIKE $${i++}`); values.push(`${analista}%`); }
    if (situacao) { conditions.push(`p.situacao = $${i++}`); values.push(situacao); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM planilha_analista p ${where}`, values
    );
    const { rows } = await pool.query(
      `SELECT p.*, 
        e.beneficiario AS entidade,
        e.processo_sgp AS sgpe,
        e.processo_mae,
        e.valor_repasse,
        e.grupo
       FROM planilha_analista p
       LEFT JOIN estoque e ON e.tr = p.tr AND e.parcela = p.parcela AND e.setorial_id = p.setorial_id
       ${where}
       ORDER BY p.tr, p.parcela
       LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Contagem para produtividade
app.get('/planilha_analista/baixadas/:analista', async (req, res) => {
  try {
    const nome = req.params.analista;
    const { rows } = await pool.query(
      `SELECT baixada FROM planilha_analista WHERE analista ILIKE $1`,
      [`${nome}%`]
    );
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  NOTAS_LIQUIDACAO
// ══════════════════════════════════════
// GET /notas_liquidacao?tr=X&parcela=Y&baixada=true&limit=1&setorial_id=FCEE&trs=A,B,C
app.get('/notas_liquidacao', async (req, res) => {
  try {
    const { tr, parcela, trs, baixada, limit, setorial_id } = req.query;
    if (trs) {
      const lista = trs.split(',');
      const { rows } = await pool.query(
        `SELECT * FROM notas_liquidacao WHERE tr = ANY($1) ORDER BY tr`,
        [lista]
      );
      return res.json({ data: rows, count: rows.length, error: null });
    }
    const conditions = [];
    const values = [];
    let i = 1;
    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    if (parcela) { conditions.push(`parcela = $${i++}`); values.push(parseInt(parcela)); }
    if (baixada !== undefined) { conditions.push(`baixada = $${i++}`); values.push(baixada === 'true'); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    let sql = `SELECT * FROM notas_liquidacao ${where} ORDER BY parcela, codigo_nl`;
    if (limit) { sql += ` LIMIT $${i++}`; values.push(parseInt(limit)); }
    const { rows } = await pool.query(sql, values);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, count: 0, error: { message: e.message } });
  }
});

// PATCH /notas_liquidacao/baixar-parcela — baixa TODAS NLs de um TR+PARCELA
// (precisa vir antes de /:id, senão "baixar-parcela" seria capturado como id)
app.patch('/notas_liquidacao/baixar-parcela', async (req, res) => {
  try {
    const { tr, parcela, baixada } = req.body;
    if (!tr || parcela === undefined)
      return res.status(400).json({ error: { message: 'tr e parcela são obrigatórios' } });
    const { rows, rowCount } = await pool.query(
      `UPDATE notas_liquidacao SET baixada = $1, atualizado_em = NOW()
       WHERE tr = $2 AND parcela = $3 RETURNING *`,
      [baixada !== false, tr, parseInt(parcela)]
    );
    res.json({ data: rows, count: rowCount, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /notas_liquidacao/:id
app.patch('/notas_liquidacao/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const campos = req.body;
    const sets = [];
    const params = [];
    let p = 1;
    const permitidos = ['baixada', 'situacao_pc', 'setorial_id'];
    permitidos.forEach(c => {
      if (campos[c] !== undefined) {
        sets.push(`${c} = $${p++}`);
        params.push(campos[c]);
      }
    });
    sets.push(`atualizado_em = NOW()`);
    params.push(parseInt(id));
    const sql = `UPDATE notas_liquidacao SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`;
    const { rows } = await pool.query(sql, params);
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  REPOSITORIO
// ══════════════════════════════════════
app.get('/repositorio', async (req, res) => {
  try {
    const { setorial_id } = req.query;
    const conditions = [];
    const values = [];

    if (setorial_id) {
      values.push(setorial_id);
      conditions.push(`setorial_id = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM repositorio ${where} ORDER BY id`, values);
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/repositorio', async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO repositorio (nome, descricao, url, categoria, setorial_id, adicionado_por)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.nome, b.descricao, b.url, b.categoria, b.setorial_id, b.adicionado_por]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.delete('/repositorio/:id', async (req, res) => {
  try {
    const quem = await lerUsuario(pool, (req.body || {}).usuario_id);
    const pe = papel.perfilEfetivo(quem);
    if (pe !== 'superadmin' && pe !== 'coordenador')
      return res.status(403).json({ data: null, error: { message: 'Apenas superadmin ou coordenador podem excluir itens do repositório' } });
    const { rows } = await pool.query('DELETE FROM repositorio WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length)
      return res.status(404).json({ data: null, error: { message: 'Item não encontrado' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  CONTADORES (dashboard)
// ══════════════════════════════════════
app.get('/contadores', async (req, res) => {
  try {
    const { setorial_id } = req.query;
    const where = setorial_id ? `WHERE setorial_id = $1` : '';
    const values = setorial_id ? [setorial_id] : [];

    const tabelas = ['estoque', 'planilha_analista', 'notas_liquidacao', 'usuarios', 'repositorio'];
    const resultado = {};
    for (const t of tabelas) {
      const r = await pool.query(`SELECT COUNT(*) FROM ${t} ${t === 'estoque' || t === 'planilha_analista' ? where : ''}`, values);
      resultado[t] = parseInt(r.rows[0].count);
    }
    res.json({ data: resultado, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});


// ══════════════════════════════════════
//  MIGRAÇÃO DE DADOS
// ══════════════════════════════════════

app.delete('/migracao/limpar-estoque', async (req, res) => {
  try {
    await pool.query("DELETE FROM estoque WHERE setorial_id = 'FCEE'");
    res.json({ ok: true, msg: 'Estoque FCEE removido' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/migracao/limpar-planilha', async (req, res) => {
  try {
    await pool.query("DELETE FROM planilha_analista WHERE setorial_id = 'FCEE'");
    res.json({ ok: true, msg: 'Planilha FCEE removida' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/migracao/estoque', async (req, res) => {
  const registros = req.body;
  if (!Array.isArray(registros) || registros.length === 0)
    return res.status(400).json({ erro: 'Body deve ser array' });
  try {
    const cols = ['tr','beneficiario','cnpj_cpf','parcela','processo_sgp','processo_mae',
                  'valor_repasse','data_limite_pc','prazo_analise','situacao',
                  'status','tecnico_nome','setorial_id','atualizado_em'];
    const vals = registros.map((r, i) => {
      const base = i * cols.length;
      return `(${cols.map((_,j) => `$${base+j+1}`).join(',')})`;
    });
    const params = registros.flatMap(r => [
      r.tr, r.beneficiario, r.cnpj_cpf, r.parcela, r.processo_sgp, r.processo_mae,
      r.valor_repasse, r.data_limite_pc, r.prazo_analise, r.situacao,
      r.status, r.tecnico_nome, r.setorial_id, new Date().toISOString(),
    ]);
    await pool.query(`INSERT INTO estoque (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
    res.json({ ok: true, inseridos: registros.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/migracao/planilha-analista', async (req, res) => {
  const registros = req.body;
  if (!Array.isArray(registros) || registros.length === 0)
    return res.status(400).json({ erro: 'Body deve ser array' });
  try {
    const cols = ['analista','setorial_id','tr','parcela','beneficiario',
                  'processo_sgp','situacao','baixada','atualizado_em'];
    const vals = registros.map((r, i) => {
      const base = i * cols.length;
      return `(${cols.map((_,j) => `$${base+j+1}`).join(',')})`;
    });
    const params = registros.flatMap(r => [
      r.analista, r.setorial_id, r.tr, r.parcela, r.beneficiario,
      r.processo_sgp, r.situacao, r.baixada, new Date().toISOString(),
    ]);
    await pool.query(`INSERT INTO planilha_analista (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
    res.json({ ok: true, inseridos: registros.length });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ══════════════════════════════════════
//  PRESTACOES_CONTAS (SIGPC-GT)
// ══════════════════════════════════════
app.get('/prestacoes_contas', async (req, res) => {
  try {
    const {
      tr, codigo_pc, codigo_nl, analista_id, analista_nome, grupo,
      status, baixada, setorial_id, conflito, estornada, enviado_ci, busca,
      limit = 9999, offset = 0
    } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;

    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    if (codigo_pc) { conditions.push(`codigo_pc = $${i++}`); values.push(codigo_pc); }
    if (codigo_nl) { conditions.push(`codigo_nl = $${i++}`); values.push(codigo_nl); }
    if (analista_id) { conditions.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    if (analista_nome) { conditions.push(`analista_nome = $${i++}`); values.push(analista_nome); }
    if (grupo) { conditions.push(`grupo = $${i++}`); values.push(parseInt(grupo)); }
    if (status) { conditions.push(`status = $${i++}`); values.push(status); }
    if (baixada !== undefined) { conditions.push(`baixada = $${i++}`); values.push(baixada === 'true'); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (conflito !== undefined) { conditions.push(`conflito = $${i++}`); values.push(conflito === 'true'); }
    if (estornada !== undefined) { conditions.push(`estornada = $${i++}`); values.push(estornada === 'true'); }
    if (enviado_ci !== undefined) { conditions.push(`enviado_ci = $${i++}`); values.push(enviado_ci === 'true'); }

    // BUSCA LIVRE — parcial, sem acento, sobre os sete campos que identificam uma PC na tela.
    // Os demais filtros acima são igualdade exata e continuam sendo: `tr=2019TR000168` casa
    // uma TR só, `busca=000168` casa qualquer coisa que contenha esse pedaço.
    //
    // A ordem dos campos é a de quem procura: primeiro o que a pessoa tem na mão (TR, número
    // do SGPe), depois o que ela lembra (entidade), por último os códigos internos.
    if (busca) {
      const r = condicaoBusca(busca, values, i);
      conditions.push(r.condicao);
      i = r.proximo;
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const countRes = await pool.query(`SELECT COUNT(*) FROM prestacoes_contas ${where}`, values);
    const { rows } = await pool.query(
      `SELECT * FROM prestacoes_contas ${where} ORDER BY tr LIMIT $${i++} OFFSET $${i++}`,
      [...values, parseInt(limit), parseInt(offset)]
    );
    // Link do SGPe junto com os dados — ver o cabeçalho de lib/sgpe-lote.js. Só cache, nunca
    // consulta o SGPe: quem consulta é o job. Chave do mapa = o valor CRU da linha.
    const links = await linksDeLinhas(pool, rows, ['processo_pc', 'processo_mae']);
    res.json({ data: rows, count: parseInt(countRes.rows[0].count), links, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /prestacoes_contas/resumo_tr?analista_id=X&setorial_id=X&busca=X — agrupado por TR
//
// ⚠️ A BUSCA ESCOLHE QUAIS TRs APARECEM. Ela NÃO pode entrar no mesmo WHERE das agregações.
//
// Era esse o defeito até 09/08/2026: o filtro da busca ficava no WHERE, que roda ANTES do
// GROUP BY, então `total_pcs`, `total_nls`, `baixadas` e `status` passavam a contar só as
// linhas que casaram com o termo. Medido em produção: a TR 2019TR000168 tem 20 PCs e
// aparecia com 2 ao buscar "FCEE5830".
//
// E não parava na contagem — a tela deriva o status de `baixadas >= total_pcs`
// (index.html, renderEst), então uma TR de 20 PCs com 2 baixadas era exibida como BAIXADA.
// 1.500 das 1.559 TRs têm mais de uma PC, ou seja, quase todas estavam sujeitas.
//
// A correção é a busca virar `tr IN (subconsulta)`: ela seleciona o conjunto de TRs, e as
// agregações continuam vendo todas as linhas de cada TR.
app.get('/prestacoes_contas/resumo_tr', async (req, res) => {
  try {
    const { analista_id, setorial_id, busca } = req.query;
    // Escopo: recorta o universo de linhas e, portanto, também as contagens. É intencional —
    // um analista vê os números das SUAS PCs.
    const escopo = [];
    const values = [];
    let i = 1;
    if (analista_id) { escopo.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    if (setorial_id) { escopo.push(`setorial_id = $${i++}`); values.push(setorial_id); }

    const conditions = [...escopo];
    if (busca) {
      // Mesma condição do GET /prestacoes_contas — a mesma palavra tem de achar a mesma coisa
      // nas duas rotas. Buscar a NL "2022NL008336", a PC "2020PC000845" ou "SCC 2511" traz a
      // TR delas: basta UMA linha casar para a TR aparecer, e as contagens continuam vendo
      // todas as linhas dela (ver o aviso sobre o GROUP BY acima).
      const r = condicaoBusca(busca, values, i);
      i = r.proximo;
      // O mesmo escopo vale dentro da subconsulta: buscar não pode revelar TR de fora do
      // recorte do usuário.
      const escopoSub = escopo.length ? `${escopo.join(' AND ')} AND ` : '';
      conditions.push(
        `tr IN (SELECT tr FROM prestacoes_contas WHERE ${escopoSub}${r.condicao})`
      );
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT tr, MAX(entidade) AS entidade, MAX(analista_nome) AS analista_nome,
              MAX(processo_mae) AS processo_mae,
              COUNT(*) AS total_pcs,
              COUNT(DISTINCT codigo_nl) AS total_nls,
              COUNT(*) FILTER (WHERE baixada) AS baixadas,
              -- ⚠️ pcs_livres VEM DA MESMA REGRA DO ASSUMIR (16/08/2026).
              --
              -- A tela derivava "livre" de !analista_nome, e o assumir exige sem dono E
              -- status='livre'. Sem dono com status='analise' caia no vao: 87 PCs em 6 TRs
              -- apareciam como Livre e recusavam com "Nenhuma PC livre nesta TR".
              --
              -- Agora a contagem sai de assumir.PC_LIVRE_SQL, a MESMA string que o
              -- SQL_LIVRES usa. Duas implementacoes da mesma pergunta e o que abriu o vao.
              COUNT(*) FILTER (WHERE ${assumir.PC_LIVRE_SQL}) AS pcs_livres,
              array_agg(DISTINCT status) AS status
       FROM prestacoes_contas
       ${where}
       GROUP BY tr
       ORDER BY tr`,
      values
    );
    // Tela Estoque — a coluna SGPe MÃE. Mesmo contrato das outras rotas: `links` ao lado de `data`.
    const links = await linksDeLinhas(pool, rows, ['processo_mae']);
    res.json({ data: rows, count: rows.length, links, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /prestacoes_contas/alertas_prazo?analista_id=X — alertas de prazo do analista, calculados em tempo real
// (dias = hoje_BR - dt_limite_pc: positivo = vencida, negativo = a vencer)
app.get('/prestacoes_contas/alertas_prazo', async (req, res) => {
  try {
    const { analista_id, setorial_id } = req.query;
    if (!analista_id)
      return res.status(400).json({ data: null, error: { message: 'analista_id é obrigatório' } });
    const conditions = [`analista_id = $1`, `status <> 'baixada'`, `dt_limite_pc IS NOT NULL`, `(${HOJE_BR} - dt_limite_pc) >= -30`];
    const values = [parseInt(analista_id)];
    let i = 2;
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    const { rows } = await pool.query(
      `SELECT tr, entidade, codigo_pc, processo_pc, dt_limite_pc,
              (${HOJE_BR} - dt_limite_pc) AS dias
       FROM prestacoes_contas
       WHERE ${conditions.join(' AND ')}
       ORDER BY dias DESC`,
      values
    );
    const vencida365 = rows.filter(r => r.dias > 365);
    const vencidaMenos365 = rows.filter(r => r.dias > 0 && r.dias <= 365);
    const aVencer30 = rows.filter(r => r.dias <= 0);
    const top10 = rows.slice(0, 10);
    // Só as 10 linhas que a tela mostra — as demais nunca são renderizadas.
    const links = await linksDeLinhas(pool, top10, ['processo_pc']);
    res.json({
      data: {
        contagem: { vencida365: vencida365.length, vencidaMenos365: vencidaMenos365.length, aVencer30: aVencer30.length },
        top10
      },
      links,
      error: null
    });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /prestacoes_contas/nl_compartilhada?codigo_nl=X — PCs que compartilham a NL
// GET /prestacoes_contas/nl_compartilhada?codigo_pc=X — quantas outras PCs da mesma NL ainda não foram baixadas
app.get('/prestacoes_contas/nl_compartilhada', async (req, res) => {
  try {
    const { codigo_nl, codigo_pc } = req.query;

    if (codigo_pc) {
      const pcRes = await pool.query('SELECT codigo_nl FROM prestacoes_contas WHERE codigo_pc = $1', [codigo_pc]);
      if (pcRes.rows.length === 0)
        return res.status(404).json({ data: null, error: { message: 'PC não encontrada' } });
      const nl = pcRes.rows[0].codigo_nl;
      if (!nl)
        return res.json({ data: { codigo_nl: null, outras_nao_baixadas: 0 }, error: null });
      const outrasRes = await pool.query(
        `SELECT COUNT(*) FROM prestacoes_contas WHERE codigo_nl = $1 AND codigo_pc != $2 AND baixada = false`,
        [nl, codigo_pc]
      );
      return res.json({ data: { codigo_nl: nl, outras_nao_baixadas: parseInt(outrasRes.rows[0].count) }, error: null });
    }

    if (!codigo_nl)
      return res.status(400).json({ data: null, error: { message: 'codigo_nl ou codigo_pc é obrigatório' } });
    const { rows } = await pool.query(
      `SELECT * FROM prestacoes_contas WHERE codigo_nl = $1 ORDER BY tr`,
      [codigo_nl]
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /prestacoes_contas/produtividade?corte=YYYY-MM-DD&analista_id=X
app.get('/prestacoes_contas/produtividade', async (req, res) => {
  try {
    const { corte, analista_id } = req.query;
    if (!corte)
      return res.status(400).json({ data: null, error: { message: 'corte é obrigatório' } });
    const conditions = ['data_baixa <= $1', '(estornada = false OR data_estorno > $1)'];
    const values = [corte];
    let i = 2;
    if (analista_id) { conditions.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    const where = 'WHERE ' + conditions.join(' AND ');
    const { rows } = await pool.query(
      `SELECT COUNT(*) FROM prestacoes_contas ${where}`,
      values
    );
    res.json({ data: { total: parseInt(rows[0].count) }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ⚠️ `PATCH /prestacoes_contas/baixar` FOI REMOVIDA em 18/08/2026, e não comentada — código
// que ninguém chama é código que ninguém revisa. Conferido antes de apagar: ZERO chamadas no
// `index.html`, nos testes dos dois repositórios e nos scripts. (A única ocorrência do texto
// era um *fixture* de host falso — `http://api.teste/...` — no `teste_front_vercomo.js`.)
//
// POR QUE ELA TINHA DE SAIR. Ela baixava por lista de `codigo_pc` sem transação, sem linha em
// `parcela_historico`, sem `AND baixada = false` e — depois de 18/08 — sem gravar
// `baixado_por`. Era o terceiro caminho de baixa do sistema, e o único que continuaria
// criando baixa sem autoria depois de as outras quatro rotas passarem a gravá-la. Uma rota
// morta não incomoda ninguém até o dia em que alguém a religa.
//
// Quem baixa hoje: `POST /parcela/parecer` (o cartão) e `POST
// /prestacoes_contas/registrar_parecer` (o detalhe da TR). As duas são transacionais, gravam
// histórico e gravam o autor.
//
// ⚠️ EFEITO COLATERAL A SABER: sem esta rota, um `PATCH /prestacoes_contas/baixar` cai no
// `PATCH /prestacoes_contas/:codigo_pc` logo abaixo, com `codigo_pc = 'baixar'` — não acha
// PC nenhuma e responde 200 com zero linhas, em vez de 404. É a armadilha 13 pelo avesso.
// Nenhum cliente faz esse pedido hoje; se um dia fizer, o silêncio é o sintoma.

// PATCH /prestacoes_contas/estornar — body { codigos_pc: [], motivo, usuario_id, usuario_nome }
//
// ⚠️ SÓ SUPERADMIN, desde 18/08/2026 — decisão do Richard. Antes: analista (as PCs dele),
// coordenador (o grupo dele) e superadmin.
//
// O MOTIVO É QUE ESTE É O CAMINHO SEM RASTRO. Ele grava `motivo_estorno`/`estornado_por` na
// própria PC, mas **não abre linha em `parcela_historico`** — então o estorno em lote não
// aparece no histórico da parcial e não responde "quem desfez esta baixa, e quando". O
// `POST /parcela/corrigir_situacao` faz o mesmo com motivo obrigatório, destino escolhido e
// trilha; é por lá que analista e coordenador passam agora.
//
// ⚠️ E O `perfil`/`grupo` DO CORPO SUMIRAM DAQUI. Eram lidos do body: bastava mandar
// `perfil: 'superadmin'` para o ramo do 403 não disparar — o mesmo buraco que as quatro
// rotas de 14/08 fecharam. Agora o único perfil que vale é o do BANCO.
app.patch('/prestacoes_contas/estornar', async (req, res) => {
  try {
    const { codigos_pc, motivo, usuario_id, usuario_nome } = req.body;
    if (!Array.isArray(codigos_pc) || codigos_pc.length === 0)
      return res.status(400).json({ data: null, error: { message: 'codigos_pc é obrigatório' } });
    if (!motivo || motivo.trim().length < 15)
      return res.status(400).json({ data: null, error: { message: 'motivo deve ter no mínimo 15 caracteres' } });

    // ⚠️ Perfil EFETIVO, lido do BANCO: no papel analista o superadmin também leva 403 —
    // é o mesmo princípio das outras dez rotas, e sem ele trocar de papel não significaria nada.
    const quemLote = await lerUsuario(pool, usuario_id);
    if (papel.perfilEfetivo(quemLote) !== 'superadmin')
      return res.status(403).json({ data: null, error: {
        message: 'Apenas o técnico do sistema estorna em lote. '
               + 'Use "Corrigir situação" — ela desfaz a baixa e fica no histórico da parcial.' } });

    const params = [motivo, usuario_nome, codigos_pc];
    const where = 'codigo_pc = ANY($3)';

    const { rows } = await pool.query(
      `UPDATE prestacoes_contas
       SET estornada = true, data_estorno = NOW(), status = 'analise', baixada = false,
           motivo_estorno = $1, estornado_por = $2,
           -- ⚠️ LIMPA O AUTOR DA BAIXA — a baixa deixou de existir. Ver o par desta linha
           -- em POST /parcela/estornar. (Sem crase: comentario dentro de template literal
           -- nao leva crase, e uma so' fecha a string — armadilha 10.)
           baixado_por = NULL,
           atualizado_em = NOW()
       WHERE ${where}
       RETURNING codigo_pc`,
      params
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  FAIXA DE AVISOS (rodapé)
// ══════════════════════════════════════
// A regra e o porquê estão em lib/faixa.js.

// GET /faixa_aviso/ativas?grupo=3 — o que passa agora. É a rota que TODA tela chama.
app.get('/faixa_aviso/ativas', async (req, res) => {
  const rows = await faixa.ativas(pool, req.query.grupo);
  res.json({ data: rows, count: rows.length, error: null });
});

// GET /faixa_aviso — tudo, para a tela de gestão
app.get('/faixa_aviso', async (req, res) => {
  const rows = await faixa.listar(pool, req.query.grupo);
  res.json({ data: rows, count: rows.length, error: null });
});

// POST /faixa_aviso  body { texto, escopo, inicio, fim, ordem, grupo, autor_id }
app.post('/faixa_aviso', async (req, res) => {
  try {
    const b = req.body || {};
    const erro = faixa.validar(b);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    const a = await pool.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(b.autor_id) || 0]);
    const autor = a.rows[0];
    if (!autor || !['coordenador', 'superadmin'].includes(papel.perfilEfetivo(autor)))
      return res.status(403).json({ data: null, error: { message: 'Só coordenador ou superadmin escreve na faixa.' } });

    // Coordenador só alcança o próprio grupo, e isso é decidido AQUI — a tela pode ser
    // contornada. Mesma regra do recado do sino.
    const grupo = papel.perfilEfetivo(autor) === 'coordenador' ? autor.grupo : (b.grupo || null);

    const { rows } = await pool.query(
      `INSERT INTO faixa_aviso (texto, escopo, ativo, inicio, fim, ordem, grupo, autor_id, autor_nome)
       VALUES ($1::text, $2::text, $3::boolean, $4::date, $5::date, $6::int, $7::text, $8::int, $9::text)
       RETURNING *`,
      [String(b.texto).trim(), b.escopo || 'inicial', b.ativo !== false,
       b.inicio || null, b.fim || null, parseInt(b.ordem) || 0,
       grupo || null, autor.id, autor.nome]);
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /faixa_aviso/:id — manda só o que mudou
app.patch('/faixa_aviso/:id', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.texto !== undefined || b.escopo !== undefined || b.inicio !== undefined || b.fim !== undefined) {
      const erro = faixa.validar({ texto: b.texto ?? 'x', escopo: b.escopo, inicio: b.inicio, fim: b.fim });
      if (erro) return res.status(400).json({ data: null, error: { message: erro } });
    }
    // Par (informou, valor) em vez de COALESCE: `inicio = null` significa "sem data de
    // início", e COALESCE trataria isso como "não informado" — a data nunca sairia.
    const { rows } = await pool.query(
      `UPDATE faixa_aviso
          SET texto  = CASE WHEN $1::boolean  THEN $2::text    ELSE texto  END,
              escopo = CASE WHEN $3::boolean  THEN $4::text    ELSE escopo END,
              ativo  = CASE WHEN $5::boolean  THEN $6::boolean ELSE ativo  END,
              inicio = CASE WHEN $7::boolean  THEN $8::date    ELSE inicio END,
              fim    = CASE WHEN $9::boolean  THEN $10::date   ELSE fim    END,
              ordem  = CASE WHEN $11::boolean THEN $12::int    ELSE ordem  END,
              atualizado_em = NOW()
        WHERE id = $13::int
        RETURNING *`,
      [b.texto !== undefined, b.texto !== undefined ? String(b.texto).trim() : null,
       b.escopo !== undefined, b.escopo ?? null,
       b.ativo !== undefined, b.ativo ?? null,
       b.inicio !== undefined, b.inicio || null,
       b.fim !== undefined, b.fim || null,
       b.ordem !== undefined, b.ordem ?? null,
       parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ data: null, error: { message: 'Faixa não encontrada.' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.delete('/faixa_aviso/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`DELETE FROM faixa_aviso WHERE id = $1 RETURNING *`, [parseInt(req.params.id)]);
    res.json({ data: rows[0] || null, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  NOTIFICAÇÕES (o sino)
// ══════════════════════════════════════
// A regra e o porquê do dedupe estão em lib/notificacao.js.

// GET /notificacao?destinatario_id=X&limite=15
app.get('/notificacao', async (req, res) => {
  try {
    const { destinatario_id, limite, apenas_nao_lidas } = req.query;
    if (!destinatario_id)
      return res.status(400).json({ data: null, error: { message: 'destinatario_id é obrigatório' } });
    const id = parseInt(destinatario_id);
    // O sino pede só as não lidas; "ver todas" pede tudo. `nao_lidas` vem nos dois casos,
    // porque é o contador do cabeçalho e ele não depende do que a lista mostra.
    const so = apenas_nao_lidas === '1' || apenas_nao_lidas === 'true';
    const [lista, naoLidas] = await Promise.all([
      notif.listar(pool, id, limite, so),
      notif.contarNaoLidas(pool, id),
    ]);
    res.json({ data: lista, count: lista.length, nao_lidas: naoLidas, error: null });
  } catch (e) {
    // O sino quebrado não pode derrubar o cabeçalho do sistema inteiro.
    res.json({ data: [], count: 0, nao_lidas: 0, error: null });
  }
});

// PATCH /notificacao/:id  body { destinatario_id } — marca como lida
app.patch('/notificacao/:id', async (req, res) => {
  try {
    const { destinatario_id } = req.body || {};
    if (!destinatario_id)
      return res.status(400).json({ data: null, error: { message: 'destinatario_id é obrigatório' } });
    const r = await notif.marcarLida(pool, req.params.id, destinatario_id);
    // Já lida, ou de outra pessoa: não é erro que mereça alarme na tela — o efeito desejado
    // (estar lida) ou já vale, ou nunca foi dela para valer.
    res.json({ data: r, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /notificacao/marcar_todas  body { destinatario_id }
app.post('/notificacao/marcar_todas', async (req, res) => {
  try {
    const { destinatario_id } = req.body || {};
    if (!destinatario_id)
      return res.status(400).json({ data: null, error: { message: 'destinatario_id é obrigatório' } });
    const n = await notif.marcarTodas(pool, destinatario_id);
    res.json({ data: { marcadas: n }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /notificacao — recado escrito por coordenador ou superadmin
// body { autor_id, alvo: 'analista'|'grupo'|'todos', analista_id?, grupo?, titulo, mensagem, urgente? }
app.post('/notificacao', async (req, res) => {
  try {
    const { autor_id, alvo, analista_id, grupo, titulo, mensagem, urgente } = req.body || {};
    if (!titulo || !String(titulo).trim())
      return res.status(400).json({ data: null, error: { message: 'título é obrigatório' } });

    const a = await pool.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(autor_id) || 0]);
    const autor = a.rows[0];
    if (!autor || !['coordenador', 'superadmin'].includes(papel.perfilEfetivo(autor)))
      return res.status(403).json({ data: null, error: { message: 'Só coordenador ou superadmin envia recado.' } });

    let destinatarios = [];
    if (alvo === 'analista') {
      if (!analista_id)
        return res.status(400).json({ data: null, error: { message: 'analista_id é obrigatório' } });
      destinatarios = [parseInt(analista_id)];
    } else {
      // Coordenador não manda para fora do próprio grupo, nem com alvo 'todos' — a conferência
      // é aqui, e não só na tela, porque a tela pode ser contornada.
      const g = papel.perfilEfetivo(autor) === 'coordenador' ? autor.grupo : (alvo === 'todos' ? null : grupo);
      const q = g ? await pool.query(`SELECT id FROM usuarios WHERE grupo = $1`, [String(g)])
                  : await pool.query(`SELECT id FROM usuarios`);
      destinatarios = q.rows.map(r => r.id);
    }

    // O autor não recebe o próprio recado.
    destinatarios = destinatarios.filter(id => Number(id) !== Number(autor.id));

    const n = await notif.criarVarios(pool, destinatarios, {
      tipo: 'recado', titulo: String(titulo).trim(),
      mensagem: `${mensagem ? String(mensagem).trim() + '\n\n' : ''}— ${autor.nome}`,
      urgente: !!urgente,
      // Sem `ref_id`: dois recados no mesmo dia são dois recados, não uma repetição. É o
      // único tipo em que o dedupe fica desligado de propósito.
    });
    res.json({ data: { enviadas: n, destinatarios: destinatarios.length }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  TRAVA DE TRs POR ANALISTA
// ══════════════════════════════════════
// A regra e o porquê estão em lib/limite-tr.js. Aqui ficam só as rotas.

// GET /limite_tr/situacao?analista_id=X — quanto ele tem, quanto pode, se pode pedir mais
app.get('/limite_tr/situacao', async (req, res) => {
  try {
    const { analista_id, tr } = req.query;
    if (!analista_id)
      return res.status(400).json({ data: null, error: { message: 'analista_id é obrigatório' } });
    const u = await pool.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(analista_id)]);
    if (!u.rows.length)
      return res.status(404).json({ data: null, error: { message: 'analista não encontrado' } });

    await limiteTr.expirarPendentes(pool);
    const s = tr ? await limiteTr.podeAssumirTr(pool, u.rows[0], tr)
                 : await limiteTr.situacao(pool, u.rows[0]);
    res.json({ data: s, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /limite_tr/reservas — TRs com pedido pendente, uma linha por TR
// Existe separada da `/solicitacao_vaga` porque a tela do Estoque precisa de UMA reserva por
// TR — a mais antiga, que é a que de fato segura a TR. Dois analistas podem ter pedido a
// mesma TR (o POST só impede o mesmo analista repetir), e aí a lista crua traria as duas.
app.get('/limite_tr/reservas', async (req, res) => {
  try {
    await limiteTr.expirarPendentes(pool);
    const rows = await limiteTr.reservasPendentes(pool);
    res.json({ data: rows, count: rows.length, dias: limiteTr.RESERVA_DIAS, error: null });
  } catch (e) {
    // Sem reservas o Estoque continua funcionando — nunca derrubar a tela por causa disto.
    res.json({ data: [], count: 0, dias: limiteTr.RESERVA_DIAS, error: null });
  }
});

// GET /config_limite_tr — a configuração global
app.get('/config_limite_tr', async (req, res) => {
  try {
    res.json({ data: await limiteTr.lerConfig(pool), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /config_limite_tr — só superadmin. Manda só o que mudou.
app.patch('/config_limite_tr', async (req, res) => {
  try {
    const { limite_padrao, liberacao, pedido_ativo, pedido_aprovador, atualizado_por, atualizado_por_nome } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE config_limite_tr
          SET limite_padrao    = CASE WHEN $1::boolean THEN $2::int  ELSE limite_padrao    END,
              liberacao        = COALESCE($3, liberacao),
              pedido_ativo     = COALESCE($4, pedido_ativo),
              pedido_aprovador = COALESCE($5, pedido_aprovador),
              atualizado_por      = $6,
              atualizado_por_nome = $7,
              atualizado_em       = NOW()
        WHERE id = 1
        RETURNING *`,
      // o par (informou, valor) existe porque `limite_padrao = null` é um valor VÁLIDO
      // (sem limite) — um COALESCE aqui tornaria impossível voltar para "sem limite".
      [limite_padrao !== undefined,
       limite_padrao === undefined || limite_padrao === null ? null : parseInt(limite_padrao),
       liberacao ?? null, pedido_ativo ?? null, pedido_aprovador ?? null,
       atualizado_por ?? null, atualizado_por_nome ?? null]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  MODO PREPARAÇÃO
// ══════════════════════════════════════
// A regra e o porquê estão em lib/preparacao.js. É uma CORTINA, não uma tranca — ler o
// aviso de lá antes de confiar nisto como controle de acesso.

/**
 * Barra a rota de trabalho enquanto o modo preparação está ligado.
 *
 * Devolve `true` quando JÁ respondeu — quem chama faz `if (await barrouPreparacao(...)) return;`
 * e não escreve mais nada. Uma linha por rota; sem isto, esconder o menu na tela seria só
 * esconder, e a URL antiga continuaria trabalhando.
 */
async function barrouPreparacao(res, usuarioId) {
  // ⚠️ MANUTENÇÃO PRIMEIRO — é a mais restritiva das duas, e a resposta dela é outra
  // (503 + `manutencao: true`, que a tela trata derrubando a sessão). Se a preparação
  // fosse conferida antes, um analista em manutenção receberia "o sistema abre à tarde" e
  // continuaria dentro, tentando de novo.
  const cfg = await prep.ler(pool);
  const emManutencao = await manut.bloqueio(pool, cfg, usuarioId);
  if (emManutencao) {
    res.status(503).json({ data: null, error: { message: emManutencao, manutencao: true } });
    return true;
  }
  const msg = await prep.bloqueio(pool, usuarioId);
  if (!msg) return false;
  res.status(403).json({ data: null, error: { message: msg, preparacao: true } });
  return true;
}

// GET /config_sistema — TODA tela chama isto ao entrar. Nunca dá erro: sem tabela ou com o
// banco fora, devolve o modo desligado e o sistema abre normalmente.
app.get('/config_sistema', async (req, res) => {
  res.json({ data: await prep.ler(pool), error: null });
});

// PATCH /config_sistema  body { modo_preparacao, mensagem, atualizado_por, atualizado_por_nome }
// Só superadmin — conferido pelo BANCO, a partir do id, e não pelo `perfil` do corpo.
app.patch('/config_sistema', async (req, res) => {
  const cli = await pool.connect();
  try {
    const b = req.body || {};
    const erro = prep.validar(b) || manut.validar(b);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    const q = await cli.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`,
                              [parseInt(b.atualizado_por) || 0]);
    const quem = q.rows[0];
    if (!quem || papel.perfilEfetivo(quem) !== 'superadmin')
      return res.status(403).json({ data: null, error: { message: 'Só o superadmin liga e desliga os modos do sistema.' } });

    // ⚠️ TRANSAÇÃO: ligar o modo e derrubar as sessões são UMA coisa só.
    //
    // Se o carimbo falhasse depois do modo ligar, o sistema ficaria fechado com 9 pessoas
    // ainda contando como online — e o janela_livre.js diria OCUPADO para sempre, sem
    // ninguém entender por quê, já que ninguém consegue mais entrar para "sair direito".
    await cli.query('BEGIN');

    // O par (informou, valor) em vez de COALESCE: `modo_preparacao = false` é um valor
    // válido — é justamente o de desligar — e um COALESCE o descartaria como "não
    // informado". Seria impossível desligar pela tela. Mesma armadilha do limite_padrao.
    const { rows } = await cli.query(
      `UPDATE config_sistema
          SET modo_preparacao     = CASE WHEN $1::boolean THEN $2::boolean ELSE modo_preparacao     END,
              mensagem            = CASE WHEN $3::boolean THEN $4::text    ELSE mensagem            END,
              modo_manutencao     = CASE WHEN $5::boolean THEN $6::boolean ELSE modo_manutencao     END,
              mensagem_manutencao = CASE WHEN $7::boolean THEN $8::text    ELSE mensagem_manutencao END,
              atualizado_por      = $9,
              atualizado_por_nome = $10,
              atualizado_em       = NOW()
        WHERE id = 1
        RETURNING *`,
      [b.modo_preparacao !== undefined, b.modo_preparacao === true,
       b.mensagem !== undefined, b.mensagem === undefined || b.mensagem === null ? null : String(b.mensagem),
       b.modo_manutencao !== undefined, b.modo_manutencao === true,
       b.mensagem_manutencao !== undefined,
       b.mensagem_manutencao === undefined || b.mensagem_manutencao === null ? null : String(b.mensagem_manutencao),
       quem.id, quem.nome]
    );

    // Só ao LIGAR. Desligar não precisa desfazer carimbo nenhum: quem entra de novo passa a
    // ter `ultimo_acesso > sessao_fim` e volta à lista de online sozinho.
    let derrubados = 0;
    if (b.modo_manutencao === true) {
      const d = await cli.query(manut.SQL_DERRUBAR);
      derrubados = d.rowCount;
    }

    await cli.query('COMMIT');
    res.json({ data: rows[0] || null, derrubados, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// ══════════════════════════════════════
//  CONTROLE INTERNO
// ══════════════════════════════════════
// A regra e o porquê estão em lib/ci.js. ⚠️ NADA aqui toca em `baixada`, `data_baixa` nem
// `enviado_ci`: a baixa é mantida em todo o ciclo, qualquer que seja o desfecho.

// GET /ci/fila?situacao=na_fila|com_analista|encerrado
app.get('/ci/fila', async (req, res) => {
  try {
    const [rows, cont] = await Promise.all([
      ci.fila(pool, req.query.situacao),
      ci.contagens(pool),
    ]);
    const links = await linksDeLinhas(pool, rows, ['processo_pc', 'processo_mae']);
    res.json({ data: rows, count: rows.length, contagens: cont, links, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /ci/mensagens?codigos_pc=a,b,c — a conversa
app.get('/ci/mensagens', async (req, res) => {
  try {
    const lista = String(req.query.codigos_pc || '').split(',').map(s => s.trim()).filter(Boolean);
    res.json({ data: await ci.mensagens(pool, lista), error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /ci/decidir  body { codigos_pc[], decisao: 'de_acordo'|'ressalva', texto?, autor_id }
app.post('/ci/decidir', async (req, res) => {
  try {
    const b = req.body || {};
    const erro = ci.validar(b);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });
    if (!ci.DECISOES.includes(b.decisao))
      return res.status(400).json({ data: null, error: { message: 'decisao é obrigatória' } });

    // Quem decide é conferido pelo BANCO, a partir do id — não pelo `perfil` do corpo.
    const q = await pool.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(b.autor_id) || 0]);
    const autor = q.rows[0];
    if (!autor || !['controle_interno', 'coordenador', 'superadmin'].includes(papel.perfilEfetivo(autor)))
      return res.status(403).json({ data: null, error: { message: 'Só o Controle Interno decide sobre esta fila.' } });

    const { pcs, jaDecidido } = await ci.decidir(pool, {
      codigos_pc: b.codigos_pc, decisao: b.decisao, texto: b.texto, autor,
    });
    if (jaDecidido)
      return res.status(409).json({ data: null, error: { message: 'Estas PCs já saíram da fila — recarregue a tela.' } });

    // Uma notificação POR ENCAMINHAMENTO. Ver o comentário de `agruparPorParcela`.
    if (b.decisao === 'ressalva') {
      for (const g of ci.agruparPorParcela(pcs)) {
        if (!g.analista_id) continue;
        await notif.criar(pool, {
          destinatario_id: g.analista_id,
          tipo: 'diligencia',
          titulo: 'Controle Interno devolveu com ressalvas',
          mensagem: `${g.tr} · Parcela ${g.parcial_num} — ${g.pcs.length} PC${g.pcs.length > 1 ? 's' : ''}` +
                    `${g.entidade ? ` (${g.entidade})` : ''}.\n\n${String(b.texto || '').trim()}`,
          link: '#planilha', ref_tipo: 'pc',
          // ⚠️ A rodada no ref_id é o que faz a SEGUNDA volta avisar. Sem ela o dedupe
          // leria a devolução nova como repetição da primeira. Lição do `num_diligencia`.
          ref_id: `${g.pcs[0]}|ci_ressalva|${(g.rodada || 1) + 1}`,
        });
      }
    }
    res.json({ data: { afetadas: pcs.length }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /ci/responder  body { codigos_pc[], texto, autor_id } — o analista responde
app.post('/ci/responder', async (req, res) => {
  try {
    const b = req.body || {};
    const erro = ci.validar({ ...b, exigeTexto: true });
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    const q = await pool.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(b.autor_id) || 0]);
    const autor = q.rows[0];
    if (!autor) return res.status(403).json({ data: null, error: { message: 'Usuário não encontrado.' } });

    const { pcs, jaRespondido } = await ci.responder(pool, {
      codigos_pc: b.codigos_pc, texto: b.texto, autor,
    });
    if (jaRespondido)
      return res.status(409).json({ data: null, error: { message: 'Estas PCs não estão aguardando sua resposta — recarregue a tela.' } });

    // Avisa o CI. Sem destinatário cadastrado ainda, não há a quem avisar — e isso não pode
    // derrubar a resposta do analista, que já foi gravada.
    const tecnicos = await pool.query(`SELECT id FROM usuarios WHERE perfil = 'controle_interno' AND ativo = true`);
    if (tecnicos.rows.length) {
      for (const g of ci.agruparPorParcela(pcs)) {
        await notif.criarVarios(pool, tecnicos.rows.map(t => t.id), {
          tipo: 'diligencia',
          titulo: 'Analista respondeu ao Controle Interno',
          mensagem: `${g.tr} · Parcela ${g.parcial_num} — ${g.pcs.length} PC${g.pcs.length > 1 ? 's' : ''}` +
                    `${g.entidade ? ` (${g.entidade})` : ''}.\n\n${String(b.texto || '').trim()}`,
          link: '#ci', ref_tipo: 'pc',
          ref_id: `${g.pcs[0]}|ci_resposta|${g.rodada || 1}`,
        });
      }
    }
    res.json({ data: { afetadas: pcs.length }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// GET /limite_tr_excecao — exceções com nome e grupo vindos de usuarios (nunca duplicados)
app.get('/limite_tr_excecao', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.analista_id, e.limite, e.observacao, e.atualizado_em,
              u.nome, u.grupo, u.perfil
         FROM limite_tr_excecao e
         LEFT JOIN usuarios u ON u.id = e.analista_id
        ORDER BY u.nome`);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.json({ data: [], count: 0, error: null });
  }
});

// PATCH /limite_tr_excecao — cria ou atualiza. `limite: null` = sem limite para a pessoa.
app.patch('/limite_tr_excecao', async (req, res) => {
  try {
    const { analista_id, limite, observacao, atualizado_por } = req.body || {};
    if (!analista_id)
      return res.status(400).json({ data: null, error: { message: 'analista_id é obrigatório' } });
    const { rows } = await pool.query(
      `INSERT INTO limite_tr_excecao (analista_id, limite, observacao, atualizado_por, atualizado_em)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (analista_id) DO UPDATE
          SET limite = EXCLUDED.limite, observacao = EXCLUDED.observacao,
              atualizado_por = EXCLUDED.atualizado_por, atualizado_em = NOW()
       RETURNING *`,
      [parseInt(analista_id), limite === undefined || limite === null ? null : parseInt(limite),
       observacao ?? null, atualizado_por ?? null]);
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.delete('/limite_tr_excecao/:analista_id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM limite_tr_excecao WHERE analista_id = $1 RETURNING *`, [parseInt(req.params.analista_id)]);
    res.json({ data: rows[0] || null, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ── Solicitações de vaga extra ──────────────────────────────────────────────
// GET /solicitacao_vaga?status=pendente&grupo=3
app.get('/solicitacao_vaga', async (req, res) => {
  try {
    // Antes de listar: quem passou dos 3 dias vira 'expirada'. Sem isto o coordenador veria
    // na fila pedidos que já não seguram TR nenhuma.
    await limiteTr.expirarPendentes(pool);

    const { status, grupo, analista_id } = req.query;
    const cond = [];
    const val = [];
    let i = 1;
    if (status) { cond.push(`s.status = $${i++}`); val.push(status); }
    if (grupo) { cond.push(`u.grupo = $${i++}`); val.push(String(grupo)); }
    if (analista_id) { cond.push(`s.analista_id = $${i++}`); val.push(parseInt(analista_id)); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT s.*, u.nome AS analista_nome_completo, u.grupo,
              (SELECT COUNT(DISTINCT tr)::int FROM prestacoes_contas
                WHERE analista_id = s.analista_id AND baixada = false) AS trs_abertas,
              -- O analista pediu a TR, caiu abaixo do limite antes da resposta e assumiu
              -- direto. O pedido continua pendente e vira lixo na fila de quem aprova.
              -- Decisão do Richard (10/08): não some sozinho — aparece marcado como
              -- dispensado, para ninguém perder tempo decidindo o que já aconteceu.
              (s.tr IS NOT NULL AND EXISTS (
                 SELECT 1 FROM prestacoes_contas p
                  WHERE p.tr = s.tr AND p.analista_id = s.analista_id)) AS ja_assumida,
              d.nome AS decidido_por_nome
         FROM solicitacao_vaga s
         LEFT JOIN usuarios u ON u.id = s.analista_id
         LEFT JOIN usuarios d ON d.id = s.decidido_por
         ${where}
        ORDER BY s.criado_em DESC`, val);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.json({ data: [], count: 0, error: null });
  }
});

// POST /solicitacao_vaga  body { analista_id, tr, justificativa }
app.post('/solicitacao_vaga', async (req, res) => {
  try {
    const { analista_id, tr, justificativa } = req.body || {};
    if (!analista_id || !justificativa || !String(justificativa).trim())
      return res.status(400).json({ data: null, error: { message: 'analista_id e justificativa são obrigatórios' } });

    const cfg = await limiteTr.lerConfig(pool);
    if (cfg.pedido_ativo === false)
      return res.status(409).json({ data: null, error: { message: 'O pedido de vaga extra está desativado.' } });

    // Expira ANTES de conferir duplicata: um pedido de 5 dias atrás, que já não segura mais
    // a TR, não pode impedir a pessoa de pedir de novo. Sem esta linha o analista ficaria
    // preso a um pedido que morreu.
    await limiteTr.expirarPendentes(pool);

    // ── QUEM PEDIU PRIMEIRO LEVA ─────────────────────────────────────────────
    // Conferir e depois inserir deixaria uma fresta: dois cliques simultâneos passam os dois
    // pela conferência e o coordenador acaba com dois pedidos para a mesma TR — exatamente
    // a escolha que ele não deve ter de fazer. Por isso a condição vive DENTRO do INSERT,
    // num comando só. Índice único resolveria melhor, mas exigiria ALTER TABLE.
    //
    // Duas regras no mesmo NOT EXISTS, porque são o mesmo assunto:
    //   · TR nomeada  — uma pendente por TR, de QUALQUER analista (é a reserva);
    //   · sem TR      — uma pendente por ANALISTA (decisão do Richard, 10/08). Sem TR não há
    //                   o que reservar, então o que se evita é a pessoa encher a fila.
    const dono = parseInt(analista_id);
    const trAlvo = tr || null;
    const { rows } = await pool.query(
      // Os `::` na lista do SELECT não são enfeite. Sem eles o Postgres deduz `$2` como
      // varchar (vem da coluna `tr`) na inserção e como text (por causa do `$2::text` do
      // NOT EXISTS) na condição, e recusa o comando inteiro com "inconsistent types deduced
      // for parameter $2". Aconteceu em produção em 10/08. Declarar o tipo em TODOS os usos
      // tira a dedução do caminho.
      `INSERT INTO solicitacao_vaga (analista_id, tr, justificativa)
       SELECT $1::int, $2::text, $3::text
        WHERE NOT EXISTS (
          SELECT 1 FROM solicitacao_vaga s
           WHERE s.status = 'pendente'
             AND s.criado_em > NOW() - (INTERVAL '1 day' * $4)
             AND ( ($2::text IS NOT NULL AND s.tr = $2::text)
                OR ($2::text IS NULL AND s.tr IS NULL AND s.analista_id = $1::int) ))
       RETURNING *`,
      [dono, trAlvo, String(justificativa).trim(), limiteTr.RESERVA_DIAS]);

    if (!rows.length) {
      // Não entrou: alguém já ocupa o lugar. Quem, decide a mensagem — repetir o próprio
      // clique e perder a corrida para um colega são situações diferentes.
      if (!trAlvo) {
        return res.status(409).json({ data: null, error: {
          message: 'Você já tem um pedido sem TR específica aguardando decisão.' } });
      }
      const reserva = await limiteTr.reservaPendente(pool, trAlvo);
      if (reserva && Number(reserva.analista_id) === dono) {
        return res.status(409).json({ data: null, error: {
          message: 'Já existe um pedido pendente para esta TR.' } });
      }
      const quem = reserva ? String(reserva.nome || 'Outro analista').split(' ')[0] : 'Outro analista';
      return res.status(409).json({ data: null, error: {
        message: `${quem} pediu esta TR primeiro. Se o pedido for negado ou expirar em ` +
                 `${limiteTr.RESERVA_DIAS} dias, a TR volta ao estoque e você pode pedir.`,
        // `reserva` vai junto para a tela montar a frase com a data no fuso de quem lê, e
        // para distinguir isto de um erro de verdade.
        reserva: reserva || null } });
    }
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /solicitacao_vaga/:id  body { status: 'aprovada'|'negada', decidido_por, motivo }
app.patch('/solicitacao_vaga/:id', async (req, res) => {
  try {
    const { status, decidido_por, motivo, analista_id } = req.body || {};
    if (!['aprovada', 'negada', 'cancelada'].includes(status))
      return res.status(400).json({ data: null, error: { message: "status deve ser 'aprovada', 'negada' ou 'cancelada'" } });
    if (status === 'negada' && !(motivo && String(motivo).trim()))
      return res.status(400).json({ data: null, error: { message: 'negar exige motivo' } });

    // Expira ANTES de qualquer coisa, inclusive do cancelamento: um pedido de 5 dias que o
    // analista cancela viraria 'cancelada' e apagaria a prova de que ele ficou sem resposta.
    // Expirando primeiro, ele recebe "já está como 'expirada'" — e o registro fica.
    await limiteTr.expirarPendentes(pool);

    // ── CANCELAMENTO ─────────────────────────────────────────────────────────
    // Caminho separado de propósito: cancelar não é decidir. Quem cancela é o DONO do
    // pedido, e não o coordenador — então nem passa pela conferência de quem aprova.
    if (status === 'cancelada') {
      if (!analista_id)
        return res.status(400).json({ data: null, error: { message: 'analista_id é obrigatório para cancelar' } });

      // O `analista_id` entra no WHERE, e não numa leitura antes: assim a posse é conferida
      // no MESMO comando que grava. Conferir antes deixaria uma fresta entre ler e escrever.
      const dono = parseInt(analista_id);
      const { rows } = await pool.query(
        `UPDATE solicitacao_vaga
            SET status = 'cancelada', decidido_por = $1, decidido_em = NOW()
          WHERE id = $2 AND analista_id = $1 AND status = 'pendente'
          RETURNING *`, [dono, parseInt(req.params.id)]);

      if (!rows.length) {
        const at = await pool.query(`SELECT status, analista_id FROM solicitacao_vaga WHERE id = $1`,
                                    [parseInt(req.params.id)]);
        const r = at.rows[0];
        const msg = !r ? 'Pedido não encontrado.'
          : Number(r.analista_id) !== dono ? 'Este pedido é de outro analista.'
          : r.status === 'pendente' ? 'Não foi possível cancelar.'
          : `Este pedido já está como '${r.status}'.`;
        return res.status(409).json({ data: null, error: { message: msg, status_atual: r ? r.status : null } });
      }
      // Quem cancela é o próprio analista, então avisar ELE do que acabou de fazer é ruído.
      // Quem precisa saber é o coordenador: saiu um item da fila dele sem que ele decidisse.
      const u = await pool.query(`SELECT nome, grupo FROM usuarios WHERE id = $1`, [dono]);
      const quem = u.rows[0] || {};
      await notif.criarVarios(pool, await notif.coordenadoresDoGrupo(pool, quem.grupo), {
        tipo: 'aprovacao',
        titulo: 'Pedido de vaga cancelado',
        mensagem: `${quem.nome || ('id ' + dono)} cancelou o próprio pedido`
                + `${rows[0].tr ? ` da TR ${rows[0].tr}` : ''}. Saiu da sua fila.`,
        link: '#aprovacoes', ref_tipo: 'solicitacao_vaga', ref_id: String(rows[0].id),
      });

      // A TR volta ao estoque no mesmo instante: tudo que lê reserva filtra por 'pendente'.
      return res.json({ data: rows[0], error: null });
    }

    // A expiração lá em cima também protege esta parte: aprovar um pedido de 5 dias daria a
    // alguém autorização para uma TR que já voltou ao estoque e pode ter dono novo.
    //
    // Só decide o que está pendente — sem isso, um duplo clique aprovaria duas vezes e
    // geraria duas vagas extras.
    const { rows } = await pool.query(
      `UPDATE solicitacao_vaga
          SET status = $1, decidido_por = $2, motivo = $3, decidido_em = NOW()
        WHERE id = $4 AND status = 'pendente'
        RETURNING *`,
      [status, decidido_por ?? null, motivo ? String(motivo).trim() : null, parseInt(req.params.id)]);
    if (!rows.length) {
      // Não basta dizer "já foi decidido": expirado e negado são coisas diferentes, e o
      // coordenador precisa saber se perdeu o prazo ou se um colega decidiu antes.
      const at = await pool.query(`SELECT status FROM solicitacao_vaga WHERE id = $1`, [parseInt(req.params.id)]);
      const st = at.rows[0] && at.rows[0].status;
      const msg = !st ? 'Pedido não encontrado.'
        : st === 'expirada' ? `Este pedido expirou (mais de ${limiteTr.RESERVA_DIAS} dias sem decisão) e a TR voltou ao estoque.`
        : st === 'cancelada' ? 'O analista cancelou este pedido.'
        : 'Este pedido já foi decidido.';
      return res.status(409).json({ data: null, error: { message: msg, status_atual: st || null } });
    }

    // O aviso mais importante do sino: hoje o analista só descobre que foi aprovado tentando
    // assumir de novo. Vai com `urgente` na aprovação porque tem prazo — a reserva dele cai
    // em 3 dias, e uma vaga aprovada que ninguém usa não serve para nada.
    const aprovada = status === 'aprovada';
    const alvo = rows[0];
    const dec = await pool.query(`SELECT nome FROM usuarios WHERE id = $1`, [decidido_por ?? 0]);
    await notif.criar(pool, {
      destinatario_id: alvo.analista_id,
      tipo: 'aprovacao',
      urgente: aprovada,
      titulo: aprovada ? 'Pedido de vaga aprovado' : 'Pedido de vaga negado',
      mensagem: aprovada
        ? `${(dec.rows[0]||{}).nome || 'A coordenação'} aprovou seu pedido`
          + `${alvo.tr ? ` da TR ${alvo.tr}` : ''}. Você já pode assumi-la.`
        : `${(dec.rows[0]||{}).nome || 'A coordenação'} negou seu pedido`
          + `${alvo.tr ? ` da TR ${alvo.tr}` : ''}.`
          + `${alvo.motivo ? ` Motivo: ${alvo.motivo}` : ''}`,
      link: '#estoque', ref_tipo: 'solicitacao_vaga', ref_id: String(alvo.id),
    });

    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  INÍCIO DA ANÁLISE
// ══════════════════════════════════════
// ⚠️ A COLUNA É CRIADA À MÃO, pelo Richard, no painel do Railway:
//
//   ALTER TABLE prestacoes_contas ADD COLUMN IF NOT EXISTS dt_inicio_analise TIMESTAMP;
//
// Enquanto ela não existir, referenciá-la derrubaria o PATCH de assumir TR com
// "column does not exist" — e assumir TR é o caminho crítico da tela. Por isso o código
// PERGUNTA ao banco, uma vez no boot, se a coluna está lá, e só então passa a usá-la.
// Assim a ordem entre o deploy e o ALTER deixa de importar.
let TEM_DT_INICIO = false;

async function verificarColunaInicioAnalise() {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'prestacoes_contas' AND column_name = 'dt_inicio_analise'`);
    TEM_DT_INICIO = rows.length > 0;
    console.log(TEM_DT_INICIO
      ? 'Coluna dt_inicio_analise presente — início da análise ativo.'
      : 'Coluna dt_inicio_analise AUSENTE — início da análise inativo (rode o ALTER TABLE).');
  } catch (e) {
    TEM_DT_INICIO = false;
    console.error('Erro ao verificar dt_inicio_analise:', e.message);
  }
  return TEM_DT_INICIO;
}

// ⚠️ Reconsulta enquanto for `false`. O primeiro desenho lia o flag só no boot, e isso criou
// um acoplamento bobo: o ALTER rodado DEPOIS do deploy não tinha efeito até alguém reiniciar
// o serviço — foi exatamente o que aconteceu em 09/08. Uma vez verdadeiro, nunca mais
// consulta (coluna não desaparece), então o custo é zero no caminho quente.
async function temInicioAnalise() {
  return TEM_DT_INICIO ? true : verificarColunaInicioAnalise();
}

// `dt_inicio_analise` tem duas formas de ser preenchida, e nenhuma é retroativa:
//
//   AUTOMÁTICA — o PATCH abaixo carimba NOW() quando a PC vira 'analise' pela primeira vez.
//   MANUAL     — esta rota, para as TRs assumidas antes de a coluna existir e para correção.
//
// Nada foi carimbado no histórico de propósito: `atualizado_em` é a última escrita de
// qualquer tipo (cargas, backfills, a reserva de 09/08) e usá-lo produziria data plausível
// e errada — pior que campo vazio, porque ninguém desconfia.
//
// ⚠️ Precisa vir ANTES de `/:codigo_pc`, senão "inicio_analise" é capturado como código de PC.
//
// PATCH /prestacoes_contas/inicio_analise  body { tr, analista_id, data }
// `data` = 'YYYY-MM-DD' ou null para limpar.
app.patch('/prestacoes_contas/inicio_analise', async (req, res) => {
  try {
    const { tr, analista_id, data } = req.body || {};
    if (!await temInicioAnalise())
      return res.status(409).json({ data: null, error: { message: 'A coluna dt_inicio_analise ainda não existe no banco. Rode o ALTER TABLE.' } });
    if (!tr || !analista_id)
      return res.status(400).json({ data: null, error: { message: 'tr e analista_id são obrigatórios' } });

    if (data !== null && data !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data)))
        return res.status(400).json({ data: null, error: { message: 'data deve ser YYYY-MM-DD' } });
      // Armadilha 3 do CLAUDE.md: data futura zera relatório. Análise não começa amanhã.
      if (String(data) > new Date().toISOString().slice(0, 10))
        return res.status(400).json({ data: null, error: { message: 'a data de início não pode ser futura' } });
    }

    // Só as PCs do próprio analista: ninguém carimba o início da análise alheia.
    const { rows } = await pool.query(
      `UPDATE prestacoes_contas
          SET dt_inicio_analise = $1::timestamp, atualizado_em = NOW()
        WHERE tr = $2 AND analista_id = $3
        RETURNING codigo_pc`,
      [data ? `${data} 00:00:00` : null, tr, parseInt(analista_id)]
    );
    res.json({ data: { tr, data: data || null, pcs: rows.length }, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /prestacoes_contas/:codigo_pc — atualização pontual (ex: assumir TR)
// ⚠️ Precisa vir DEPOIS de /estornar, senão "estornar" seria capturado como codigo_pc — é a
// armadilha 13. (A irmã /baixar foi removida em 18/08/2026; ver o comentário no lugar dela.)
app.patch('/prestacoes_contas/:codigo_pc', async (req, res) => {
  try {
    const campos = req.body;

    // ── MODO PREPARAÇÃO ─────────────────────────────────────────────────────
    // Vem ANTES da trava de TRs: na manhã da preparação ninguém assume TR nenhuma, esteja
    // dentro ou fora do limite. Esconder o menu na tela não bastaria — este PATCH é o único
    // caminho por onde uma TR muda de dono, e a URL antiga continuaria funcionando.
    if (campos.analista_id && await barrouPreparacao(res, campos.analista_id)) return;

    // ── TRAVA DE TRs ────────────────────────────────────────────────────────
    // Conferida AQUI, e não só na tela: a tela pode ser contornada, e este PATCH é o único
    // caminho por onde uma TR muda de dono. Só entra quando o corpo é o de "assumir"
    // (analista + status analise) — mudar situação ou enviar ao CI não passa por aqui.
    if (campos.analista_id && campos.status === 'analise') {
      const alvo = await pool.query(`SELECT tr FROM prestacoes_contas WHERE codigo_pc = $1`, [req.params.codigo_pc]);
      const u = await pool.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(campos.analista_id)]);
      if (alvo.rows.length && u.rows.length) {
        const chk = await limiteTr.podeAssumirTr(pool, u.rows[0], alvo.rows[0].tr);
        if (!chk.pode) {
          return res.status(403).json({
            data: null,
            error: { message: chk.motivo, limite: chk.limite, ocupadas: chk.ocupadas, trava: true,
                     // `reserva` distingue os dois bloqueios: limite atingido é uma coisa,
                     // TR reservada por um colega é outra, e a tela fala diferente de cada.
                     reserva: chk.reserva || null },
          });
        }
        // Passou por autorização aprovada? Então a autorização foi gasta agora. Só marca
        // quando foi ELA que liberou — se ele estava abaixo do limite, a autorização
        // continua guardada para a próxima.
        if (chk.autorizacao) {
          await pool.query(`UPDATE solicitacao_vaga SET status = 'usada' WHERE id = $1 AND status = 'aprovada'`,
                           [chk.autorizacao.id]);
        }
      }
    }

    const sets = [];
    const values = [];
    let i = 1;
    const permitidos = ['analista_nome', 'analista_id', 'status', 'enviado_ci', 'dt_envio_ci'];
    permitidos.forEach(c => {
      if (campos[c] !== undefined) {
        sets.push(`${c} = $${i++}`);
        values.push(campos[c]);
      }
    });
    if (sets.length === 0)
      return res.status(400).json({ data: null, error: { message: 'nenhum campo permitido informado' } });

    // Carimba o início da análise na PRIMEIRA vez que a PC vira 'analise'. O COALESCE é o
    // ponto: devolver ao estoque e reassumir não reinicia a contagem — o relógio da análise
    // já tinha começado. E nunca sobrescreve o que foi definido à mão.
    if (campos.status === 'analise' && await temInicioAnalise()) sets.push(`dt_inicio_analise = COALESCE(dt_inicio_analise, NOW())`);

    // ⚠️ `dt_assumida` É O OPOSTO DA DE CIMA, E DE PROPÓSITO.
    //
    // Sem COALESCE: ela responde "quando ESTE analista pegou a TR", e por isso REINICIA a
    // cada assunção. `dt_inicio_analise` responde "quando a análise começou" e não reinicia
    // nunca — é o relógio do prazo. Duas perguntas diferentes, dois campos.
    //
    // A distinção passou a importar quando a devolução ganhou botão: depois de devolver e
    // outro analista assumir, `dt_inicio_analise` continuaria mostrando a data do analista
    // ANTERIOR. Usá-la como "assumida em" seria mostrar data errada no cartão.
    //
    // A condição é a mesma da trava de TRs — analista + status 'analise' é a forma do
    // "assumir". Mudar de situação ou enviar ao C.I. não passa por aqui.
    if (campos.analista_id && campos.status === 'analise') sets.push(`dt_assumida = NOW()`);

    sets.push(`atualizado_em = NOW()`);
    values.push(req.params.codigo_pc);
    const { rows } = await pool.query(
      `UPDATE prestacoes_contas SET ${sets.join(', ')} WHERE codigo_pc = $${i} RETURNING *`,
      values
    );

    // Movimentação de diligência. O dono da PC sai do RESULTADO, não do corpo do PATCH: quem
    // move a diligência costuma ser o Controle Interno, não o analista — ler de
    // `campos.analista_id` avisaria a pessoa errada, ou ninguém.
    const pcAlvo = rows[0];
    if (pcAlvo && ['diligencia', 'reanalise'].includes(campos.status) && pcAlvo.analista_id) {
      const emDilig = campos.status === 'diligencia';
      await notif.criar(pool, {
        destinatario_id: pcAlvo.analista_id,
        tipo: 'diligencia',
        titulo: emDilig ? 'PC em diligência' : 'PC voltou para reanálise',
        mensagem: `${pcAlvo.codigo_pc}${pcAlvo.tr ? ` (TR ${pcAlvo.tr})` : ''} — ${pcAlvo.entidade || 'entidade não informada'}.`,
        link: '#planilha', ref_tipo: 'pc',
        // O `ref_id` carrega o status e o número da diligência. Sem isso, uma PC que vai para
        // diligência, volta para reanálise e cai em diligência de novo só avisaria da
        // primeira vez — o dedupe enxergaria as três movimentações como a mesma.
        ref_id: `${pcAlvo.codigo_pc}|${campos.status}|${pcAlvo.num_diligencia || 0}`,
        setorial_id: pcAlvo.setorial_id || null,
      });
    }

    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /prestacoes_contas/registrar_parecer — body { codigo_pc, parecer_tipo, analista_id,
//                                            registrado_por, observacao?, baixar_nl_completa? }
//
// ⚠️ ROTA LEGADA, E ELA BAIXA DE VERDADE. É o botão "Registrar parecer" do detalhe da TR
// (`index.html:3329`). Até 18/08/2026 gravava SEM transação, SEM histórico e SEM autoria: as
// 12 baixas dela são as únicas do acervo sem autor identificável por id. Agora usa as MESMAS
// peças do `POST /parcela/parecer` — `resolverAutoria`, `carregarParcela`, `registrarHistorico`.
//
// ⚠️ ELA CONTINUA SENDO POR PC, e não por parcela (decisão do Richard, 18/08/2026). O
// `carregarParcela` está aqui pelo LOCK, não pelo alcance da escrita: `registrarHistorico` é
// chaveado por (tr, parcial_num), e sem travar a parcela dois pareceres simultâneos em PCs
// irmãs gravariam duas linhas sobre um estado que mudou no meio. Quem baixa a parcela
// inteira é o cartão da Minha Planilha.
app.post('/prestacoes_contas/registrar_parecer', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  if (!b.codigo_pc)
    return res.status(400).json({ data: null, error: { message: 'codigo_pc é obrigatório' } });
  // ⚠️ A MESMA lista do parecer do cartão. Sem ela entraram 7 PCs com
  // 'Parecer Regular com Ressalva(s)', que era o rótulo do `<select>` desta tela.
  if (!PARECERES_VALIDOS.includes(b.parecer_tipo))
    return res.status(400).json({ data: null,
      error: { message: `parecer_tipo inválido. Use um de: ${PARECERES_VALIDOS.join(', ')}` } });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // ⚠️ DONO x EXECUTOR, contra o perfil lido no BANCO, dentro da transação.
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }

    const { rows: alvo } = await cli.query(
      `SELECT codigo_pc, codigo_nl, tr, parcial_num, setorial_id, baixada, status, situacao_atual
         FROM prestacoes_contas WHERE codigo_pc = $1`, [b.codigo_pc]);
    if (!alvo.length) { await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'PC não encontrada' } }); }
    const pc = alvo[0];

    // Trava a parcela inteira (FOR UPDATE). Ver o cabeçalho: é lock, não alcance.
    await carregarParcela(cli, pc.tr, pc.parcial_num, pc.setorial_id);

    if (pc.baixada === true) { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null,
        error: { message: 'PC já baixada. Estorne antes de registrar novo parecer.' } }); }

    const params = [b.parecer_tipo, b.registrado_por ?? null];
    let where;
    if (b.baixar_nl_completa === true && pc.codigo_nl) {
      params.push(pc.codigo_nl);
      where = `codigo_nl = $3`;
    } else {
      params.push(pc.codigo_pc);
      where = `codigo_pc = $3`;
    }
    params.push(b.analista_id ?? null);
    params.push(executorDe(b));

    const { rows } = await cli.query(
      `UPDATE prestacoes_contas
       SET baixada = true, status = 'baixada', parecer_tipo = $1,
           data_baixa = NOW(), origem_baixa = 'sistema', registrado_por = $2,
           analista_id = COALESCE(analista_id, $4::int),
           -- ⚠️ QUEM CLICOU — ver executorDe. Esta rota é o botão "Registrar parecer" do
           -- detalhe da TR, e as 12 baixas que ela fez até 18/08 são justamente as que
           -- ficaram sem autor nenhum no acervo.
           baixado_por = $5::int,
           situacao_atual = NULL, estornada = false, data_estorno = NULL,
           atualizado_em = NOW()
       -- ⚠️ AND baixada = false — a mesma correção de 16/08 do parecer e do estorno.
       -- O status != 'baixada' do ramo da NL NAO era equivalente: as duas colunas
       -- divergem (24 PCs estornadas estão com status='livre' e baixada=false).
       WHERE ${where} AND baixada = false
       RETURNING codigo_pc, tr, parcial_num, setorial_id`,
      params
    );

    // ⚠️ UMA LINHA POR PARCELA AFETADA. Pela PC só há uma; pelo ramo da NL pode haver
    // várias, inclusive de TRs diferentes — e uma linha só não apareceria nas outras.
    const parcelas = [...new Map(rows.map(r =>
      [`${r.setorial_id}|${r.tr}|${r.parcial_num}`, r])).values()];
    for (const p of parcelas) {
      await registrarHistorico(cli, {
        tr: p.tr, parcial_num: p.parcial_num, setorial_id: p.setorial_id,
        evento: 'parecer',
        valor_anterior: pc.situacao_atual || pc.status || null,
        valor_novo: b.parecer_tipo,
        analista_id: b.analista_id ?? null,
        observacao: autoria.observacaoCom(b.observacao, b._autoria, b._autoria?.executor_nome),
        executado_por: b._autoria?.executado_por ?? null,
      });
    }

    await cli.query('COMMIT');
    res.json({ data: rows.map(r => r.codigo_pc), count: rows.length, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// ══════════════════════════════════════
//  BUSCA GLOBAL — só superadmin
// ══════════════════════════════════════
// A regra e o porquê estão em lib/busca-global.js.
//
// ⚠️ A GUARDA É AQUI, NÃO NO MENU. Esconder o item de menu não impede ninguém de chamar a
// rota — e esta devolve o acervo inteiro de qualquer analista, que é justamente o que o
// recorte por `analista_id` das outras telas existe para não fazer.

// GET /busca_global?termo=X&usuario_id=N
app.get('/busca_global', async (req, res) => {
  const cli = await pool.connect();
  try {
    const b = { termo: req.query.termo, usuario_id: req.query.usuario_id };
    const erro = bg.validar(b);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    const { rows: u } = await cli.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`,
                                        [parseInt(b.usuario_id) || 0]);
    if (!u.length || papel.perfilEfetivo(u[0]) !== 'superadmin')
      return res.status(403).json({ data: null, error: { message: 'A busca global é exclusiva do superadmin.' } });

    const termo = String(b.termo).trim();

    // ── quais TRs, e quais PCs casaram ───────────────────────────────────────
    // Duas perguntas, dois usos: o `IN` escolhe as TRs (e as agregações continuam vendo
    // TODAS as linhas de cada uma — o defeito de 09/08); o conjunto de `codigo_pc` é o que
    // destaca as parciais dentro do card.
    const vCasa = [];
    const rc = bg.condicaoBusca(termo, vCasa, 1);
    const { rows: casaram } = await cli.query(
      `SELECT codigo_pc, tr FROM prestacoes_contas WHERE setorial_id='FCEE' AND ${rc.condicao}`, vCasa);
    if (!casaram.length)
      return res.json({ data: { termo, total_trs: 0, mostrando: 0, cards: [] }, links: {}, error: null });

    const trsTodas = [...new Set(casaram.map(r => r.tr))];
    const trs = trsTodas.slice(0, bg.MAX_TRS);
    const setCasaram = new Set(casaram.map(r => r.codigo_pc));

    const { rows } = await cli.query(
      `SELECT codigo_pc, codigo_nl, tipo, tr, parcial_num, processo_pc, processo_mae, entidade,
              cnpj_cpf, status, situacao_atual, parecer_tipo, baixada, analista_id, analista_nome,
              grupo, dt_assumida, dt_inicio_analise, dt_limite_pc,
              ci_situacao, ci_rodada, dt_envio_ci, ci_encerrado_em
         FROM prestacoes_contas
        WHERE setorial_id='FCEE' AND tr = ANY($1)
        ORDER BY tr, parcial_num, codigo_pc`, [trs]);

    const hoje = (await cli.query(`SELECT ${HOJE_BR}::text d`)).rows[0].d;

    // "No estoque desde" — só existe quando a TR JÁ FOI devolvida por alguém. A esmagadora
    // maioria das TRs livres nunca teve dono, e para essas não há data nenhuma: inventar uma
    // (a da carga, por exemplo) seria mostrar um número que não quer dizer o que parece.
    const { rows: dev } = await cli.query(
      `SELECT DISTINCT ON (tr) tr, criado_em FROM parcela_historico
        WHERE tr = ANY($1) AND evento = 'devolucao_tr'
        ORDER BY tr, criado_em DESC`, [trs]);
    const devolvidaEm = new Map(dev.map(d => [d.tr, d.criado_em]));

    const cards = bg.montarCards(rows, setCasaram, hoje, devolvidaEm);
    const links = await linksDeLinhas(pool, rows, ['processo_pc', 'processo_mae']);

    res.json({ data: { termo, total_trs: trsTodas.length, mostrando: cards.length,
                       teto: bg.MAX_TRS, cards }, links, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// ══════════════════════════════════════
//  ASSUMIR A TR INTEIRA — numa transação
// ══════════════════════════════════════
// A regra e o porquê estão em lib/assumir.js. Substitui o laço de PATCH por PC que a tela
// fazia: 83 requisições em série, sem transação, com a trava de limite conferida 83 vezes.

// GET /tr/:tr/assumir?usuario_id=N — a prévia do modal: quantas PCs, e se pode.
app.get('/tr/:tr/assumir', async (req, res) => {
  const cli = await pool.connect();
  try {
    const { rows: u } = await cli.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`,
                                        [parseInt(req.query.usuario_id) || 0]);
    if (!u.length) return res.status(403).json({ data: null, error: { message: 'Usuário não encontrado.' } });

    const { rows: livres } = await cli.query(
      `SELECT codigo_pc, codigo_nl FROM prestacoes_contas
        WHERE setorial_id='FCEE' AND tr = $1 AND status = 'livre' AND analista_id IS NULL
        ORDER BY codigo_pc`, [req.params.tr]);
    const chk = await limiteTr.podeAssumirTr(cli, u[0], req.params.tr);

    res.json({ data: { tr: req.params.tr, livres: livres.length,
                       codigos: livres.map(r => r.codigo_pc),
                       nls: [...new Set(livres.map(r => r.codigo_nl).filter(Boolean))],
                       pode: chk.pode, motivo: chk.pode ? null : chk.motivo,
                       limite: chk.limite, ocupadas: chk.ocupadas,
                       reserva: chk.reserva || null, jaMinha: chk.jaMinha,
                       autorizacao: chk.autorizacao ? true : false }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /tr/assumir  body { tr, usuario_id, setorial_id? }
app.post('/tr/assumir', async (req, res) => {
  const cli = await pool.connect();
  try {
    const b = req.body || {};
    const erro = assumir.validar(b);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    // Preparação/manutenção antes de tudo: na manhã da preparação ninguém assume TR nenhuma.
    if (await barrouPreparacao(res, b.usuario_id)) return;

    const { rows: u } = await cli.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`,
                                        [parseInt(b.usuario_id) || 0]);
    if (!u.length) return res.status(403).json({ data: null, error: { message: 'Usuário não encontrado.' } });
    const quem = u[0];
    const setorial_id = b.setorial_id || 'FCEE';

    await cli.query('BEGIN');

    // ⚠️ A TRAVA DE LIMITE É CONFERIDA UMA VEZ, DENTRO DA TRANSAÇÃO.
    // No caminho antigo ela rodava a cada PATCH — e como a PC 1 já contava como assumida,
    // uma TR podia ser aceita pela metade e recusada no resto.
    const chk = await limiteTr.podeAssumirTr(cli, quem, b.tr);
    if (!chk.pode) {
      await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: {
        message: chk.motivo, limite: chk.limite, ocupadas: chk.ocupadas, trava: true,
        reserva: chk.reserva || null } });
    }

    const { rows: livres } = await cli.query(assumir.SQL_LIVRES, [setorial_id, b.tr]);
    if (!livres.length) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: {
        message: 'Nenhuma PC livre nesta TR — outra pessoa pode ter assumido agora.' } });
    }
    const codigos = livres.map(r => r.codigo_pc);

    const { rows: feitas } = await cli.query(
      assumir.SQL_ASSUMIR, [codigos, quem.id, assumir.nomeCurto(quem.nome)]);

    // A autorização só é gasta quando foi ELA que liberou. Se ele estava abaixo do limite,
    // continua guardada para a próxima — mesma regra do caminho antigo.
    if (chk.autorizacao)
      await cli.query(`UPDATE solicitacao_vaga SET status = 'usada' WHERE id = $1 AND status = 'aprovada'`,
                      [chk.autorizacao.id]);

    await cli.query(
      `INSERT INTO parcela_historico
         (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id, observacao)
       VALUES ($1, NULL, $2, 'assumir_tr', 'livre', $3, $4, $5)`,
      [b.tr, setorial_id, assumir.nomeCurto(quem.nome), quem.id,
       `${feitas.length} PCs assumidas` + (chk.autorizacao ? ' · com autorização de vaga extra' : '')]);

    await cli.query('COMMIT');
    res.json({ data: { tr: b.tr, assumidas: feitas.length, codigos: feitas.map(r => r.codigo_pc),
                       analista_nome: assumir.nomeCurto(quem.nome) }, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// ══════════════════════════════════════
//  CORRIGIR O PROCESSO SGPe DE UMA PC
// ══════════════════════════════════════
// A regra e o porquê estão em lib/processo-edit.js.
// Analista, coordenador e superadmin podem — decisão do Richard, 13/08.

const PERFIS_EDITAM_PROCESSO = ['analista', 'coordenador', 'superadmin'];

async function quemEdita(cli, usuarioId) {
  const { rows } = await cli.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`,
                                   [parseInt(usuarioId) || 0]);
  // ⚠️ `perfilEfetivo`, não `perfil` cru — esta era a única rota de escrita fora dos 10
  // pontos da regra de 14/08. Sem efeito prático hoje (`analista` já está na lista), mas uma
  // exceção sobrevivente é onde a regra volta a divergir.
  return rows[0] && PERFIS_EDITAM_PROCESSO.includes(papel.perfilEfetivo(rows[0])) ? rows[0] : null;
}

/** Resolve o processo: mapa → cache → SGPe ao vivo. Devolve { link, motivo }. */
async function resolverProcesso(texto) {
  const p = normalizarProcesso(texto);
  if (!p) return { link: null, motivo: 'O texto não forma um processo.' };
  if (!siglaConhecida(p.sigla))
    return { link: null, motivo: `A sigla "${p.sigla}" não está no mapa de órgãos.` };

  const chave = formatarProcesso(p);
  const { rows } = await pool.query(
    `SELECT nu_processo, cd_orgaosetor, ano FROM sgpe_processo_ref
      WHERE sigla=$1 AND numero_oficial=$2 AND ano=$3`, [p.sigla, p.numero, p.ano]);
  if (rows.length && rows[0].nu_processo != null)
    return { link: montarUrlSgpe(rows[0].nu_processo, rows[0].cd_orgaosetor, rows[0].ano), chave };
  if (rows.length) return { link: null, chave, motivo: 'O SGPe já respondeu que não tem este processo.' };

  // Não está no cache: pergunta ao SGPe. Um processo só — é o caminho do analista corrigindo
  // à mão, não o job.
  try {
    const r = await resolverNoSgpe(p);
    if (r && r.nuProcesso) {
      await pool.query(
        `INSERT INTO sgpe_processo_ref (sigla, numero_oficial, ano, nu_processo, cd_orgaosetor, origem)
         VALUES ($1,$2,$3,$4,$5,'SGPE')
         ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE
           SET nu_processo = EXCLUDED.nu_processo, cd_orgaosetor = EXCLUDED.cd_orgaosetor,
               origem = 'SGPE', motivo = NULL`,
        [p.sigla, p.numero, p.ano, r.nuProcesso, r.cdOrgaosetor]);
      return { link: montarUrlSgpe(r.nuProcesso, r.cdOrgaosetor, p.ano), chave };
    }
    return { link: null, chave, motivo: 'O SGPe não devolveu este processo.' };
  } catch (e) {
    return { link: null, chave, motivo: 'O SGPe não tem este processo, ou não respondeu agora.' };
  }
}

// PATCH /prestacoes_contas/:codigo_pc/processo
//   body { campo: 'processo_pc'|'processo_mae', sigla, numero, ano, usuario_id }
//
// ⚠️ O `juntar` SAIU em 16/08/2026, e com ele o 409 de "fusão de parcela". Decisão do
// Richard, depois da medição no estoque oficial da CGE: **um processo SGPe PODE carregar
// várias parcelas do SIGEF** — 113 pares (tr, processo) com 2+ parciais, 78 TRs, 465 PCs.
// A rota existia para impor o contrário, e impunha ESCREVENDO: igualava o `parcial_num` das
// PCs ao de `outras[0]` — a primeira linha de um SELECT **sem ORDER BY**, ou seja, a parcela
// que o Postgres escolhesse. Com 2+ parciais no mesmo processo isso desfaria em silêncio a
// numeração do SIGEF, e não daria erro em lugar nenhum.
//
// O 409 saiu junto porque só existia para oferecer o `juntar`: mantê-lo bloquearia a correção
// legítima sem caminho de saída. Colidir em (tr, processo_pc) deixou de ser sinal de defeito —
// virou `convive`, que INFORMA e não decide nada.
app.patch('/prestacoes_contas/:codigo_pc/processo', async (req, res) => {
  const cli = await pool.connect();
  try {
    const b = { ...(req.body || {}), codigo_pc: req.params.codigo_pc };
    const erro = procEdit.validar(b);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    const quem = await quemEdita(cli, b.usuario_id);
    if (!quem) return res.status(403).json({ data: null, error: { message: 'Você não pode corrigir o processo.' } });
    if (await barrouPreparacao(res, b.usuario_id)) return;

    // ⚠️ O BEGIN vem ANTES das leituras, e o `FOR UPDATE` junto. Até 16/08/2026 o SELECT da
    // PC e o das irmãs rodavam FORA da transação, e o UPDATE escrevia sobre uma lista de
    // chaves que já podia ter mudado — a mesma família da armadilha 12, só que na leitura.
    await cli.query('BEGIN');

    const { rows: alvo } = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, processo_pc, processo_mae, analista_id
         FROM prestacoes_contas
        WHERE codigo_pc = $1 FOR UPDATE`, [b.codigo_pc]);
    if (!alvo.length) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'PC não encontrada.' } });
    }
    const pc = alvo[0];
    const antes = pc[b.campo];
    const novo = procEdit.montar(b);
    if (antes === novo) {
      await cli.query('ROLLBACK');
      return res.json({ data: { texto: novo, mudou: false, ...(await resolverProcesso(novo)) }, error: null });
    }

    // ── quais PCs mudam ──────────────────────────────────────────────────────
    // A correção vale para TODAS as PCs que hoje têm o mesmo texto errado na mesma TR: o erro
    // é do processo, não da PC, e corrigir uma a uma deixaria as irmãs erradas.
    const { rows: irmas } = await cli.query(
      `SELECT codigo_pc FROM prestacoes_contas
        WHERE setorial_id='FCEE' AND tr = $1 AND ${b.campo} IS NOT DISTINCT FROM $2
        FOR UPDATE`, [pc.tr, antes]);
    const codigos = irmas.map(r => r.codigo_pc);

    // ── o processo passa a conviver com outra parcial? INFORMA, não bloqueia ──
    // Só faz sentido para processo_pc: o processo_mae não agrupa parcial nenhuma.
    //
    // ⚠️ NADA aqui escreve. É texto para a tela mostrar depois de salvar, e o analista
    // precisa saber — mas saber não é o mesmo que ter de decidir, e decidir não é o mesmo
    // que o servidor reescrever a numeração por ele.
    let convive = null;
    if (b.campo === 'processo_pc') {
      const { rows: outras } = await cli.query(
        `SELECT DISTINCT parcial_num FROM prestacoes_contas
          WHERE setorial_id='FCEE' AND tr = $1 AND processo_pc = $2 AND tipo <> 'final'
            AND parcial_num IS DISTINCT FROM $3`, [pc.tr, novo, pc.parcial_num]);
      if (outras.length) {
        // Ordem numérica, não alfabética: como texto a parcial 10 viria antes da 2.
        const nums = outras.map(r => r.parcial_num).sort((x, y) => {
          const nx = parseInt(String(x).replace(/\D/g, ''), 10), ny = parseInt(String(y).replace(/\D/g, ''), 10);
          if (Number.isNaN(nx) || Number.isNaN(ny)) return String(x).localeCompare(String(y));
          return nx - ny;
        });
        convive = { tr: pc.tr, parcial_atual: pc.parcial_num, outras_parciais: nums, pcs: codigos.length };
      }
    }

    await cli.query(
      `UPDATE prestacoes_contas SET ${b.campo} = $2, atualizado_em = NOW()
        WHERE codigo_pc = ANY($1)`, [codigos, novo]);

    // ⚠️ A AUTORIA DUPLA — corrigida em 16/08/2026. Até aqui esta rota gravava `quem.id`
    // (o EXECUTOR) na coluna `analista_id`, que significa o DONO, e deixava `executado_por`
    // vazio — ou seja, dizia "foi o dono mesmo" no nome de quem não é dono.
    //
    // Medido pelo qa-banco: **25 de 75** linhas `processo_pc` e **3 de 25** `processo_mae` já
    // estão com `analista_id` diferente do dono da TR. Um coordenador corrigia o processo de
    // uma PC da Aline e a trilha dizia que a dona do trabalho era o coordenador.
    //
    // É exatamente o defeito que 14/08 corrigiu em `parecer`/`situacao`/`ci`/`devolucao_tr`.
    // Esta rota nasceu em 13/08 e ficou de fora. `executado_por` NULO = foi o dono mesmo.
    const dono = pc.analista_id ?? null;
    const executor = (dono != null && String(dono) !== String(quem.id)) ? quem.id : null;
    await cli.query(
      `INSERT INTO parcela_historico
         (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
          observacao, executado_por)
       VALUES ($1, $2, 'FCEE', $3, $4, $5, $6, $7, $8)`,
      [pc.tr, pc.parcial_num, b.campo, antes, novo, dono ?? quem.id,
       `${codigos.length} PC${codigos.length > 1 ? 's' : ''}` +
       (convive ? ` · o processo tambem esta na parcial ${convive.outras_parciais.join(', ')} desta TR` : '') +
       (executor ? ` · executado por ${quem.nome}` : ''),
       executor]);
    await cli.query('COMMIT');

    // Resolver o link vem DEPOIS do COMMIT: a correção do dado não pode depender do SGPe
    // estar no ar. Se o link não vier agora, a tela oferece colar — e o texto já está salvo.
    const resolucao = await resolverProcesso(novo);
    res.json({ data: { texto: novo, mudou: true, pcs: codigos.length, convive, ...resolucao }, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /sgpe/link_manual  body { processo, url, usuario_id, codigo_pc? }
// Só quando o automático não resolveu — é a segunda etapa, nunca a primeira.
app.post('/sgpe/link_manual', async (req, res) => {
  const cli = await pool.connect();
  try {
    const b = req.body || {};
    const quem = await quemEdita(cli, b.usuario_id);
    if (!quem) return res.status(403).json({ data: null, error: { message: 'Você não pode gravar o link.' } });

    const p = normalizarProcesso(b.processo);
    if (!p) return res.status(400).json({ data: null, error: { message: 'Processo inválido.' } });

    const lido = procEdit.lerLink(b.url);
    if (lido.erro) return res.status(400).json({ data: null, error: { message: lido.erro } });

    // ⚠️ O ano da URL tem de bater com o do processo. Colar o link de OUTRO processo é o
    // engano mais fácil de cometer — a pessoa está com várias abas do SGPe abertas.
    if (lido.ano !== p.ano)
      return res.status(400).json({ data: null, error: {
        message: `O endereço é de um processo de ${lido.ano}, e este é de ${p.ano}. Confira a aba do SGPe.` } });

    await cli.query('BEGIN');
    await cli.query(
      `INSERT INTO sgpe_processo_ref (sigla, numero_oficial, ano, nu_processo, cd_orgaosetor, origem, motivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (sigla, numero_oficial, ano) DO UPDATE
         SET nu_processo = EXCLUDED.nu_processo, cd_orgaosetor = EXCLUDED.cd_orgaosetor,
             origem = EXCLUDED.origem, motivo = EXCLUDED.motivo, tentativas = 0`,
      [p.sigla, p.numero, p.ano, lido.nu_processo, lido.cd_orgaosetor, procEdit.ORIGEM_MANUAL,
       `colado por ${quem.nome} (id ${quem.id})`]);

    // Quem colou fica no histórico — `sgpe_processo_ref` não tem coluna de autor, e o Richard
    // decidiu em 13/08 não criar uma: o histórico já responde.
    const { rows: pcRows } = b.codigo_pc
      ? await cli.query(`SELECT tr, parcial_num, analista_id FROM prestacoes_contas WHERE codigo_pc = $1`,
                        [b.codigo_pc])
      : { rows: [] };
    // ⚠️ MESMA CORREÇÃO DA ROTA DO LÁPIS (16/08/2026): `analista_id` é o DONO, e
    // `executado_por` é quem clicou — nulo quando são a mesma pessoa. Aqui gravava-se
    // `quem.id` no campo do dono. Ver o comentário longo em `PATCH .../processo`.
    const donoL = pcRows[0]?.analista_id ?? null;
    const execL = (donoL != null && String(donoL) !== String(quem.id)) ? quem.id : null;
    await cli.query(
      `INSERT INTO parcela_historico
         (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
          observacao, executado_por)
       VALUES ($1, $2, 'FCEE', 'sgpe_link_manual', NULL, $3, $4, $5, $6)`,
      [pcRows[0]?.tr ?? null, pcRows[0]?.parcial_num ?? null,
       formatarProcesso(p), donoL ?? quem.id,
       `link colado à mão · processoPK=${lido.nu_processo},${lido.cd_orgaosetor},${lido.ano}` +
       (execL ? ` · executado por ${quem.nome}` : ''),
       execL]);
    await cli.query('COMMIT');

    res.json({ data: { processo: formatarProcesso(p),
                       link: montarUrlSgpe(lido.nu_processo, lido.cd_orgaosetor, lido.ano) }, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// ══════════════════════════════════════
//  DEVOLVER A TR AO ESTOQUE — só superadmin
// ══════════════════════════════════════
// A regra e o histórico dos três defeitos estão em lib/devolucao.js. Aqui só a transação,
// a conferência de quem pede e o registro.

/** Lê as PCs da TR e resume. Usado pela prévia E pela gravação — uma conta só. */
async function lerTrParaDevolucao(cli, tr, comLock) {
  const { rows } = await cli.query(
    `SELECT codigo_pc, baixada, ci_situacao, analista_id, analista_nome
       FROM prestacoes_contas
      WHERE setorial_id = 'FCEE' AND tr = $1
      ORDER BY codigo_pc${comLock ? ' FOR UPDATE' : ''}`, [tr]);
  return { pcs: rows, resumo: devol.resumir(rows) };
}

/** Quem pede é superadmin? Conferido pelo BANCO, nunca pelo corpo do pedido. */
async function ehSuperadmin(cli, usuarioId) {
  const { rows } = await cli.query(`SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`,
                                   [parseInt(usuarioId) || 0]);
  return rows[0] && papel.perfilEfetivo(rows[0]) === 'superadmin' ? rows[0] : null;
}

// GET /tr/:tr/devolucao?usuario_id=N — a prévia que o modal desenha.
// ⚠️ A PRÉVIA E A GRAVAÇÃO USAM A MESMA CONTA (`devol.resumir` + `devol.impedimento`). Se
// cada uma calculasse do seu jeito, o modal diria 71 e o banco devolveria outro número.
app.get('/tr/:tr/devolucao', async (req, res) => {
  const cli = await pool.connect();
  try {
    const quem = await ehSuperadmin(cli, req.query.usuario_id);
    if (!quem)
      return res.status(403).json({ data: null, error: { message: 'Só o superadmin devolve TR ao estoque.' } });

    const { resumo } = await lerTrParaDevolucao(cli, req.params.tr, false);
    if (!resumo.total)
      return res.status(404).json({ data: null, error: { message: 'TR não encontrada.' } });

    res.json({ data: { ...resumo, tr: req.params.tr, motivos: devol.MOTIVOS,
                       impedimento: devol.impedimento(resumo) }, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /tr/devolver  body { tr, usuario_id, motivo, detalhe? }
app.post('/tr/devolver', async (req, res) => {
  const cli = await pool.connect();
  try {
    const b = req.body || {};
    const erro = devol.validar(b);
    if (erro) return res.status(400).json({ data: null, error: { message: erro } });

    const quem = await ehSuperadmin(cli, b.usuario_id);
    if (!quem)
      return res.status(403).json({ data: null, error: { message: 'Só o superadmin devolve TR ao estoque.' } });

    await cli.query('BEGIN');

    // ⚠️ FOR UPDATE, e a lista capturada ANTES de escrever (regra 12). Sem o lock, duas
    // devoluções simultâneas — ou uma devolução e um "assumir" — leriam o mesmo estado e a
    // segunda escreveria por cima de decisão tomada sobre dado velho.
    const { resumo } = await lerTrParaDevolucao(cli, b.tr, true);
    if (!resumo.total) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'TR não encontrada.' } });
    }

    // Reconferido DENTRO da transação, e não só na prévia: entre abrir o modal e clicar,
    // uma PC pode ter ido para o Controle Interno.
    const imped = devol.impedimento(resumo);
    if (imped) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: imped, resumo } });
    }

    const { rows: devolvidas } = await cli.query(devol.SQL_DEVOLVER, [resumo.codigos]);

    // O rastro. Sem ele, uma TR sumia da planilha do analista sem que nada dissesse por quê.
    const texto = devol.motivoTexto(b);
    const { rows: hist } = await cli.query(
      `INSERT INTO parcela_historico
         (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id, observacao)
       VALUES ($1, NULL, 'FCEE', 'devolucao_tr', $2, 'livre', $3, $4)
       RETURNING id`,
      [b.tr,
       resumo.analista_nome ? `${resumo.analista_nome} (id ${resumo.analista_id})` : 'sem dono',
       quem.id,
       `${texto} · ${devolvidas.length} PCs devolvidas · ${resumo.baixadas} baixadas mantidas`]);

    await cli.query('COMMIT');

    // Avisa DEPOIS do COMMIT: notificação de algo que não foi gravado é pior que nenhuma.
    // Uma por TR, não por PC — 71 avisos iguais fariam o sino deixar de ser lido.
    if (resumo.analista_id) {
      notif.criar(pool, {
        destinatario_id: resumo.analista_id,
        tipo: 'recado',
        titulo: `TR ${b.tr} devolvida ao estoque`,
        mensagem: `${devolvidas.length} PC${devolvidas.length > 1 ? 's' : ''} da TR ${b.tr} ` +
                  `voltaram ao estoque. Motivo: ${texto}.` +
                  // Mesmo ajuste do pedido de devolução: "As 1 já baixadas" saía errado.
                  (resumo.baixadas
                    ? (resumo.baixadas > 1
                        ? ` As ${resumo.baixadas} já baixadas continuam suas.`
                        : ' A parcial já baixada continua sua.')
                    : ''),
        // ⚠️ O `ref_id` É O ID DO HISTÓRICO, NÃO A TR.
        //
        // `notif.criar` deduplica por (destinatario, tipo, ref_id). Com a TR no `ref_id`, a
        // SEGUNDA devolução da mesma TR ao mesmo analista seria engolida em silêncio — ele
        // perderia a TR sem ser avisado. É a mesma armadilha do `num_diligencia`, que o
        // ciclo do C.I. resolveu pondo a rodada no `ref_id`.
        //
        // Com o id do histórico, cada devolução é um evento próprio e o dedupe continua
        // servindo ao que serve: um clique repetido não vira dois avisos.
        ref_tipo: 'tr', ref_id: `devtr-${hist[0].id}`,
      }).catch(e => console.error('Falha ao notificar devolucao:', e.message));
    }

    res.json({ data: { tr: b.tr, devolvidas: devolvidas.length, baixadas_mantidas: resumo.baixadas,
                       analista_id: resumo.analista_id, motivo: texto }, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// ══════════════════════════════════════
//  PEDIDO DE DEVOLUÇÃO — o analista PEDE, o coordenador decide  (13/08/2026)
// ══════════════════════════════════════
//
// ⚠️ A TR CONTINUA CONTANDO NO LIMITE ENQUANTO O PEDIDO ESTÁ PENDENTE. Nenhuma destas rotas
// toca em `analista_id` a não ser na APROVAÇÃO. Se o pendente já liberasse a vaga, qualquer
// um abriria vaga só pedindo devolução.

// (`lerUsuario` mora no topo do arquivo — a guarda de papel a usa em rotas anteriores a esta.)

// GET /tr/:tr/pedido_devolucao?usuario_id=N — o aviso que o modal mostra ANTES de enviar.
// ⚠️ MESMA CONTA da gravação (`devolucao.resumir`), e a mesma da devolução do superadmin.
app.get('/tr/:tr/pedido_devolucao', async (req, res) => {
  const cli = await pool.connect();
  try {
    const quem = await lerUsuario(cli, req.query.usuario_id);
    if (!quem) return res.status(403).json({ data: null, error: { message: 'Usuário não identificado.' } });

    const { pcs } = await lerTrParaDevolucao(cli, req.params.tr, false);
    if (!pcs.length) return res.status(404).json({ data: null, error: { message: 'TR não encontrada.' } });

    // O analista só pede a devolução da TR que é DELE. Superadmin e coordenador veem a
    // prévia de qualquer uma — é o que a tela de aprovação usa para conferir antes de decidir.
    const dono = pcs.find(p => p.analista_id)?.analista_id ?? null;
    if (quem.perfil === 'analista' && String(dono ?? '') !== String(quem.id))
      return res.status(403).json({ data: null, error: { message: 'Esta TR não é sua.' } });

    const { resumo, impedimento } = devolPed.impedimentoPedido(pcs);
    const { rows: pend } = await cli.query(
      `SELECT id, criado_em FROM solicitacao_devolucao
        WHERE tr = $1 AND setorial_id = 'FCEE' AND status = 'pendente' LIMIT 1`, [req.params.tr]);

    res.json({
      data: {
        tr: req.params.tr, motivos: devolPed.MOTIVOS,
        aviso: devolPed.avisoPedido(pcs), resumo,
        // `pode` é FALSE também quando já há pedido pendente: dois pedidos gerariam duas
        // decisões, e a segunda decidiria sobre uma TR que já voltou ao estoque.
        pode: !impedimento && !pend.length,
        motivo_bloqueio: impedimento
          || (pend.length ? 'Já existe um pedido de devolução em análise para esta TR.' : null),
        pendente: pend[0] || null,
      }, error: null
    });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /solicitacao_devolucao — body { tr, analista_id, motivo, justificativa, indicado_id?, indicado_nome? }
app.post('/solicitacao_devolucao', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;

  const erro = devolPed.validarPedido(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    const quem = await lerUsuario(cli, b.analista_id);
    if (!quem) { await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: { message: 'Usuário não identificado.' } }); }

    // ⚠️ FOR UPDATE: entre abrir o modal e clicar, uma PC pode ter ido ao C.I. ou a TR pode
    // ter sido devolvida por outro caminho.
    const { pcs } = await lerTrParaDevolucao(cli, b.tr, true);
    if (!pcs.length) { await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'TR não encontrada.' } }); }

    const dono = pcs.find(p => p.analista_id)?.analista_id ?? null;
    if (String(dono ?? '') !== String(quem.id)) { await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: { message: 'Esta TR não é sua.' } }); }

    const { resumo, impedimento } = devolPed.impedimentoPedido(pcs);
    if (impedimento) { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: impedimento, resumo } }); }

    let novo;
    try {
      const r = await cli.query(devolPed.SQL_CRIAR, [
        quem.id, b.tr, 'FCEE', b.motivo, String(b.justificativa).trim(),
        b.indicado_id ? parseInt(b.indicado_id) : null,
        (b.indicado_nome ?? '').toString().trim() || null,
        resumo.total, resumo.devolver, resumo.baixadas]);
      novo = r.rows[0];
    } catch (e) {
      await cli.query('ROLLBACK');
      // ⚠️ A trava do "um pendente por TR" é do ÍNDICE ÚNICO PARCIAL, e é ela que segura
      // dois cliques simultâneos — a conferência acima não seguraria.
      if (e.code === '23505')
        return res.status(409).json({ data: null,
          error: { message: 'Já existe um pedido de devolução em análise para esta TR.' } });
      throw e;
    }

    await cli.query('COMMIT');

    // Avisa a coordenação DEPOIS do COMMIT. Cai para o superadmin se o grupo não tem
    // coordenador — `coordenadoresDoGrupo` já faz isso.
    const destinos = await notif.coordenadoresDoGrupo(pool, quem.grupo);
    notif.criarVarios(pool, destinos, {
      tipo: 'aprovacao',
      titulo: `Pedido de devolução — TR ${b.tr}`,
      mensagem: `${quem.nome} pediu a devolução da TR ${b.tr}. `
              + `Motivo: ${devolPed.motivoTexto(b.motivo)}. ${resumo.devolver} PC`
              + `${resumo.devolver > 1 ? 's voltariam' : ' voltaria'} ao estoque.`,
      link: '#aprovacoes', ref_tipo: 'solicitacao_devolucao', ref_id: String(novo.id),
    }).catch(e => console.error('Falha ao notificar pedido de devolucao:', e.message));

    res.json({ data: novo, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// GET /solicitacao_devolucao?status=pendente&analista_id=N&usuario_id=N
app.get('/solicitacao_devolucao', async (req, res) => {
  const cli = await pool.connect();
  try {
    const quem = await lerUsuario(cli, req.query.usuario_id);
    if (!quem) return res.status(403).json({ data: null, error: { message: 'Usuário não identificado.' } });

    // ⚠️ O RECORTE É DO SERVIDOR, e vem do perfil lido no BANCO. O analista vê só os pedidos
    // dele; o coordenador, só os do grupo dele; o superadmin, todos. Sem isto, quem montasse
    // o pedido HTTP à mão leria a fila inteira.
    let filtroAnalista = null, filtroGrupo = null;
    if (quem.perfil === 'analista') filtroAnalista = quem.id;
    else if (quem.perfil === 'coordenador') filtroGrupo = String(quem.grupo ?? '');
    else if (papel.perfilEfetivo(quem) !== 'superadmin')
      return res.status(403).json({ data: null, error: { message: 'Sem acesso a esta fila.' } });

    const { rows } = await cli.query(devolPed.SQL_LISTAR,
      [req.query.status || null, filtroAnalista, filtroGrupo]);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// PATCH /solicitacao_devolucao/:id — body { status:'aprovada'|'negada', decidido_por, motivo_decisao }
//
// ⚠️ APROVAR DEVOLVE A TR NA MESMA TRANSAÇÃO, e quem devolve é a `devol.SQL_DEVOLVER` — a
// MESMA da devolução do superadmin. Duas regras de "o que volta" divergiriam.
app.patch('/solicitacao_devolucao/:id', async (req, res) => {
  const b = req.body || {};
  const erro = devolPed.validarDecisao(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');

    const quem = await lerUsuario(cli, b.decidido_por);
    if (!quem) { await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: { message: 'Usuário não identificado.' } }); }

    const { rows: ped } = await cli.query(
      `SELECT s.*, u.grupo AS analista_grupo, u.nome AS analista_nome
         FROM solicitacao_devolucao s LEFT JOIN usuarios u ON u.id = s.analista_id
        WHERE s.id = $1 FOR UPDATE OF s`, [parseInt(req.params.id) || 0]);
    if (!ped.length) { await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Pedido não encontrado.' } }); }

    const p = ped[0];
    if (!devolPed.podeDecidir(quem, p)) { await cli.query('ROLLBACK');
      // ⚠️ Mensagem própria para o caso "é o seu": recusar com o texto genérico faria o
      // coordenador procurar um problema de permissão que não existe.
      const proprio = String(p.analista_id) === String(quem.id);
      return res.status(403).json({ data: null, error: { message: proprio
        ? 'Você não decide o próprio pedido. Ele vai para o coordenador do seu grupo.'
        : 'Só o coordenador do grupo ou o superadmin decidem este pedido.' } }); }

    // O superadmin PODE decidir o próprio — não há ninguém acima dele —, e quando isso
    // acontece o registro diz.
    const autodecidido = String(p.analista_id) === String(quem.id);
    if (p.status !== 'pendente') { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null,
        error: { message: `Este pedido já foi ${p.status}.` } }); }

    let devolvidas = 0, baixadasMantidas = 0, destino = 'estoque', indicado = null;
    if (b.status === 'aprovada') {
      const { pcs } = await lerTrParaDevolucao(cli, p.tr, true);
      const { resumo, impedimento } = devolPed.impedimentoPedido(pcs);
      // Reconferido AGORA: entre o pedido e a decisão, uma PC pode ter ido ao C.I.
      if (impedimento) { await cli.query('ROLLBACK');
        return res.status(409).json({ data: null, error: { message: impedimento, resumo } }); }

      destino = devolPed.destinoAprovacao(p.motivo);

      // ⚠️ MOTIVO 1 NÃO PASSA PELO ESTOQUE: a TR vai DIRETO para quem já a analisava. Mandá-la
      // ao estoque a entregaria a quem chegasse primeiro — que é o problema que o motivo 1
      // descreve. O LIMITE NÃO É CONFERIDO (decisão do Richard): 29 dos 44 já estão em 6 ou
      // acima, e a trava vale no ato de ASSUMIR, não em receber de volta o próprio trabalho.
      if (destino === 'indicado') {
        if (p.indicado_id) {
          const { rows } = await cli.query(
            `SELECT id, nome, perfil, grupo, ativo, papel_ativo FROM usuarios WHERE id = $1`, [p.indicado_id]);
          indicado = rows[0] || null;
        }
        const impedIndicado = devolPed.impedimentoIndicado(p, indicado);
        // ⚠️ BLOQUEIA em vez de cair no estoque em silêncio. O pedido afirma que a TR tem
        // destino; sem destino, quem decide precisa saber, não descobrir depois.
        if (impedIndicado) { await cli.query('ROLLBACK');
          return res.status(409).json({ data: null, error: { message: impedIndicado } }); }

        // ⚠️ A MESMA ESCRITA DO "ASSUMIR" — `lib/assumir.js`. `dt_assumida = NOW()` para o novo
        // dono e `dt_inicio_analise` preservado por COALESCE: o relógio do prazo não reinicia
        // porque a TR trocou de mão.
        const { rows: mov } = await cli.query(assumir.SQL_ASSUMIR,
          [resumo.codigos, indicado.id, assumir.nomeCurto(indicado.nome)]);
        devolvidas = mov.length;
      } else {
        const { rows: dev } = await cli.query(devol.SQL_DEVOLVER, [resumo.codigos]);
        devolvidas = dev.length;
      }
      baixadasMantidas = resumo.baixadas;

      await cli.query(
        `INSERT INTO parcela_historico
           (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id, observacao)
         VALUES ($1, NULL, 'FCEE', 'devolucao_tr', $2, $3, $4, $5)`,
        [p.tr, `${p.analista_nome || 'sem nome'} (id ${p.analista_id})`,
         destino === 'indicado' ? `${assumir.nomeCurto(indicado.nome)} (id ${indicado.id})` : 'livre',
         quem.id,
         `pedido #${p.id} aprovado · ${devolPed.motivoTexto(p.motivo)} · ${devolvidas} PCs `
         + `${destino === 'indicado' ? `transferidas para ${indicado.nome}` : 'devolvidas ao estoque'} `
         + `· ${resumo.baixadas} baixadas mantidas`
         // ⚠️ A marca vai no HISTÓRICO, não só na tela: tela alguém deixa de abrir.
         + (autodecidido ? ` · ${devolPed.MARCA_AUTODECIDIDO}` : '')]);
    }

    const { rows: fim } = await cli.query(devolPed.SQL_DECIDIR,
      [p.id, b.status, quem.id, String(b.motivo_decisao).trim()]);
    if (!fim.length) { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: 'Este pedido já foi decidido.' } }); }

    await cli.query('COMMIT');

    // ⚠️ O ANALISTA É AVISADO NAS DUAS DECISÕES, COM O MOTIVO ESCRITO — decisão do Richard.
    // `ref_id` é o id do PEDIDO, que é único por pedido: um segundo pedido da mesma TR gera
    // um aviso novo, em vez de ser engolido pelo dedupe.
    const aprovada = b.status === 'aprovada';
    const decisao = String(b.motivo_decisao).trim();
    const paraIndicado = aprovada && destino === 'indicado';

    notif.criar(pool, {
      destinatario_id: p.analista_id,
      tipo: 'aprovacao',
      titulo: aprovada ? `Devolução aprovada — TR ${p.tr}` : `Devolução recusada — TR ${p.tr}`,
      mensagem: (aprovada
          ? (paraIndicado
              ? `A TR ${p.tr} passou para ${indicado.nome} (${devolvidas} PC${devolvidas > 1 ? 's' : ''}), e a vaga foi liberada.`
              : `A TR ${p.tr} voltou ao estoque (${devolvidas} PC${devolvidas > 1 ? 's' : ''}), e a vaga foi liberada.`)
            // "As 1 já baixadas continuam suas" saiu assim no primeiro ciclo real, em 13/08.
            + (baixadasMantidas
                ? (baixadasMantidas > 1
                    ? ` As ${baixadasMantidas} já baixadas continuam suas.`
                    : ' A parcial já baixada continua sua.')
                : '')
          : `A TR ${p.tr} continua com você.`)
        + ` ${quem.nome} escreveu: "${decisao}"`,
      link: '#planilha', ref_tipo: 'solicitacao_devolucao', ref_id: `dec-${p.id}`,
    }).catch(e => console.error('Falha ao notificar decisao de devolucao:', e.message));

    // ⚠️ O INDICADO TAMBÉM É AVISADO — ele recebe a TR SEM ter pedido (não há aceite: a
    // aprovação do coordenador é o aceite). Receber trabalho novo em silêncio seria descobrir
    // pela planilha, dias depois. O aviso diz QUEM mandou, POR QUÊ, e o que fazer se discordar.
    if (paraIndicado) {
      notif.criar(pool, {
        destinatario_id: indicado.id,
        tipo: 'recado',
        titulo: `Você recebeu a TR ${p.tr}`,
        mensagem: `${p.analista_nome || 'Um analista'} pediu a devolução da TR ${p.tr} porque ela `
                + `já estava em análise com você antes do sistema, e ${quem.nome} aprovou. `
                + `${devolvidas} PC${devolvidas > 1 ? 's estão' : ' está'} na sua Minha Planilha. `
                + `Motivo da decisão: "${decisao}". `
                + 'Se não for o caso, use "Solicitar devolução" no cartão da TR.',
        link: '#planilha', ref_tipo: 'solicitacao_devolucao', ref_id: `rec-${p.id}`,
      }).catch(e => console.error('Falha ao notificar indicado:', e.message));
    }

    res.json({ data: { ...fim[0], devolvidas, baixadas_mantidas: baixadasMantidas,
                       destino, autodecidido,
                       indicado: indicado ? { id: indicado.id, nome: indicado.nome } : null },
               error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) { /* já caiu */ }
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// ══════════════════════════════════════
//  PARCELA — baixa por PARCIAL (uma parcial = PCs do mesmo tr + parcial_num)
//  Um parecer baixa TODAS as PCs da parcial. NL nao agrupa mais baixa.
// ══════════════════════════════════════

// Pareceres do TECNICO. "Encaminhado ao CI" NAO entra aqui — CI e campo proprio.
const PARECERES_VALIDOS = ['Parecer Regular', 'Parecer Regular com Ressalvas', 'Parecer Irregular'];

// Situacoes de acompanhamento: nenhuma baixa a parcial.
const SITUACOES_VALIDAS = ['Em análise', 'Diligência', 'Reanálise', 'Aguardando documentação'];

// A coluna legada `status` nao tem equivalente para "Aguardando documentação";
// mapeamos para 'analise' para a PC seguir contando no estoque de trabalho.
// O valor exato fica em `situacao_atual`.
const SITUACAO_PARA_STATUS = {
  'Em análise': 'analise',
  'Diligência': 'diligencia',
  'Reanálise': 'reanalise',
  'Aguardando documentação': 'analise'
};

// ⚠️ `analista_id` é o DONO do trabalho; `executado_por` é QUEM CLICOU, e fica NULO quando
// são a mesma pessoa. Nulo quer dizer "foi ele mesmo" — preencher sempre tiraria o sinal, e o
// que importa achar é a linha em que os dois DIFEREM. Ver `lib/autoria.js`.
function registrarHistorico(cli, h) {
  return cli.query(
    `INSERT INTO parcela_historico
       (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id,
        observacao, executado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [h.tr, h.parcial_num, h.setorial_id, h.evento,
     h.valor_anterior ?? null, h.valor_novo ?? null, h.analista_id ?? null, h.observacao ?? null,
     h.executado_por ?? null]
  );
}

/**
 * Quem é o dono e quem executou — resolvido no SERVIDOR, contra o perfil lido no BANCO.
 *
 * O corpo manda `analista_id` (o dono) e, quando a ação é feita pela conta de outro,
 * `executado_por` (quem clicou). Quem carimba é o `fetch` do navegador, num ponto só — mas
 * ⚠️ CARIMBO POSTO PELO NAVEGADOR É CARIMBO QUE O NAVEGADOR TIRA. A conferência de quem pode
 * agir por outro é aqui, e só o superadmin pode.
 *
 * @returns null quando está tudo certo (e preenche `b._autoria`), ou já respondeu 403/400.
 */
async function resolverAutoria(cli, b, res) {
  const quemId = b.executado_por ?? b.analista_id;
  const { rows } = await cli.query(
    `SELECT id, nome, perfil, grupo, papel_ativo FROM usuarios WHERE id = $1`, [parseInt(quemId) || 0]);
  const quem = rows[0] || null;

  const r = autoria.resolver(quem, b.analista_id);
  if (!r.ok) { res.status(quem ? 403 : 401).json({ data: null, error: { message: r.erro } }); return true; }

  b._autoria = { ...r, executor_nome: r.porOutro ? quem.nome : null };
  return false;
}

/**
 * QUEM CLICOU DE FATO — o id que vai para `baixado_por` e `enviado_ci_por`.
 *
 * ⚠️ NÃO É O MESMO CRITÉRIO DO `parcela_historico.executado_por`, e a diferença é de
 * propósito. Lá o campo fica NULO quando o dono executou, porque o valor da trilha está em
 * mostrar a linha em que os dois DIFEREM. Aqui não: estas duas colunas respondem "quem fez
 * esta baixa?" e "quem mandou isto ao C.I.?", e a resposta tem de valer SEMPRE — é ela que
 * `lib/correcao.js` compara com quem está pedindo a correção.
 *
 * Nulo aqui já tem outro significado, fixado na migração de 18/08/2026: **"não há autoria
 * registrada"**, que é o caso 3 da regra de A (e libera o analista a corrigir sozinho).
 * Deixar nulo porque "foi o próprio dono" transformaria toda baixa normal em baixa sem dono
 * conhecido, e a regra viraria "todo mundo pode" — exatamente o defeito que estas colunas
 * existem para fechar.
 *
 * Então: quando o Richard age pela conta da Marisa, `baixado_por` é o Richard (quem clicou),
 * `analista_id` continua sendo a Marisa (de quem é o trabalho e a produtividade), e
 * `parcela_historico` guarda os dois.
 */
function executorDe(b) {
  return b?._autoria?.executado_por ?? (b?.analista_id == null ? null : parseInt(b.analista_id) || null);
}

// Carrega as PCs da parcial com lock, para a transacao ser toda-ou-nenhuma.
//
// ⚠️ A CHAVE E' (setorial_id, tr, parcial_num) — NUNCA `processo_pc`, e isto foi conferido em
// 16/08/2026. Um processo SGPe carrega varias parcelas do SIGEF (113 pares medidos no estoque
// da CGE; ver a armadilha 16), e esta funcao ja lida com isso sem mudanca nenhuma: cada
// parcial_num carrega so' as suas PCs. Nao trocar esta chave por processo.
//
// ⚠️ E NAO FILTRA `tipo`, DE PROPOSITO — decisao do Richard, 16/08/2026.
// Ha 3 PCs FINAIS gravadas com `parcial_num = '1'` (2021TR001689, 2021TR002133, 2023TR000048)
// e elas entram na parcial 1 nos cinco chamadores: baixam, vao ao C.I. e estornam junto.
// A correcao escolhida e' de DADO, nao um `AND tipo <> 'final'` aqui — pôr a guarda no codigo
// esconderia tres linhas erradas em vez de conserta-las, e a tela ja separa a final pelo
// `tipo` (`planEhFinal`). **Se voce veio aqui para adicionar o filtro, conserte o dado.**
async function carregarParcela(cli, tr, parcial_num, setorial_id) {
  const { rows } = await cli.query(
    `SELECT * FROM prestacoes_contas
      WHERE setorial_id = $1 AND tr = $2 AND parcial_num = $3
      ORDER BY codigo_pc
      FOR UPDATE`,
    [setorial_id, tr, String(parcial_num)]
  );
  return rows;
}

function faltaChave(b) {
  if (!b.tr) return 'tr é obrigatório';
  if (b.parcial_num === undefined || b.parcial_num === null || b.parcial_num === '')
    return 'parcial_num é obrigatório';
  return null;
}

// GET /parcela/historico?tr=X&parcial_num=Y&setorial_id=FCEE
app.get('/parcela/historico', async (req, res) => {
  try {
    const { tr, parcial_num, setorial_id = 'FCEE' } = req.query;
    if (!tr) return res.status(400).json({ data: null, error: { message: 'tr é obrigatório' } });
    const conditions = ['tr = $1', 'setorial_id = $2'];
    const values = [tr, setorial_id];
    if (parcial_num !== undefined && parcial_num !== '') {
      values.push(String(parcial_num));
      conditions.push(`parcial_num = $${values.length}`);
    }
    const { rows } = await pool.query(
      `SELECT * FROM parcela_historico WHERE ${conditions.join(' AND ')} ORDER BY criado_em DESC, id DESC`,
      values
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /parcela/parecer — body { tr, parcial_num, parecer_tipo, analista_id, observacao, setorial_id?, override? }
// Baixa TODAS as PCs da parcial, numa transacao. D1: data_baixa = agora (data real do parecer).
app.post('/parcela/parecer', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  const erro = faltaChave(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });
  if (!PARECERES_VALIDOS.includes(b.parecer_tipo))
    return res.status(400).json({
      data: null,
      error: { message: `parecer_tipo inválido. Use um de: ${PARECERES_VALIDOS.join(', ')}` }
    });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // ⚠️ QUEM E O DONO E QUEM EXECUTOU — resolvido contra o perfil lido no BANCO. Dentro
    // da transacao, para nao decidir sobre um cadastro que mudou no meio.
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }
    const pcs = await carregarParcela(cli, b.tr, b.parcial_num, setorial_id);
    if (pcs.length === 0) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Parcial não encontrada' } });
    }

    const jaBaixadas = pcs.filter(p => p.baixada === true);
    if (jaBaixadas.length === pcs.length) {
      await cli.query('ROLLBACK');
      return res.status(409).json({
        data: null,
        error: { message: `Parcial já baixada (${pcs.length} PC${pcs.length > 1 ? 's' : ''}). Estorne antes de registrar novo parecer.` }
      });
    }

    // Nao deixa um analista baixar parcial de outro sem override explicito.
    if (b.override !== true && b.analista_id) {
      const donoOutro = pcs.find(p => p.analista_id != null && String(p.analista_id) !== String(b.analista_id));
      if (donoOutro) {
        await cli.query('ROLLBACK');
        return res.status(403).json({
          data: null,
          error: { message: `Parcial pertence a outro analista (id ${donoOutro.analista_id}). Use override para prosseguir.` }
        });
      }
    }

    const { rows } = await cli.query(
      `UPDATE prestacoes_contas
          SET baixada = true,
              status = 'baixada',
              data_baixa = NOW(),
              origem_baixa = 'sistema',
              parecer_tipo = $1,
              analista_id = COALESCE($2, analista_id),
              registrado_por = $3,
              -- ⚠️ QUEM CLICOU, e não o dono — ver executorDe. É esta coluna que
              -- lib/correcao.js compara para decidir se o analista corrige sozinho ou se
              -- o pedido vai ao coordenador. Sem ela, toda baixa nova nascia sem autoria e
              -- caía no caso 3 da regra ("sem autoria registrada"), que libera qualquer um.
              baixado_por = $7,
              situacao_atual = NULL,
              estornada = false,
              data_estorno = NULL,
              atualizado_em = NOW()
        -- ⚠️ AND baixada = false — CORRIGIDO EM 16/08/2026.
        --
        -- Sem ele, o parecer reescrevia data_baixa, origem_baixa e parecer_tipo de PCs
        -- que JÁ ESTAVAM baixadas, dentro da mesma parcela. O 409 acima não protege: ele só
        -- dispara quando **todas** estão baixadas (jaBaixadas.length === pcs.length). Numa
        -- parcela MISTA — parte baixada, parte aberta — ele não dispara, e o UPDATE, que é por
        -- condição derivada, pegava a parcela inteira.
        --
        -- O que isso fazia na prática: uma PC baixada em 30/06 com origem_baixa =
        -- 'carga_historica' passava a constar como baixada HOJE, por 'sistema', com o
        -- parecer novo por cima do que estava lá. A produtividade saltava de mês e o parecer
        -- original sumia sem trilha. **Ninguém reclama de uma baixa que ficou mais recente.**
        --
        -- Não era hipótese: a renumeração das 15 TRs de hoje criou 3 parcelas mistas
        -- (2020TR000761 p17 · 2021TR002375 p1 · 2022TR001248 p7), e a inclusão de PC em
        -- parcela existente criaria mais. Agora o parecer baixa só o que estava aberto, e a
        -- resposta devolve a contagem real.
        WHERE setorial_id = $4 AND tr = $5 AND parcial_num = $6
          AND baixada = false
        RETURNING codigo_pc`,
      [b.parecer_tipo, b.analista_id ?? null, b.registrado_por ?? null,
       setorial_id, b.tr, String(b.parcial_num), executorDe(b)]
    );

    await registrarHistorico(cli, {
      tr: b.tr, parcial_num: String(b.parcial_num), setorial_id,
      evento: 'parecer',
      valor_anterior: pcs[0].situacao_atual || pcs[0].status || null,
      valor_novo: b.parecer_tipo,
      analista_id: b.analista_id ?? null,
      // ⚠️ A marca vai na coluna E no texto: a coluna serve para CONSULTAR, o texto para
      // quem abre uma linha solta. Só a coluna repetiria o erro do `registrado_por`.
      observacao: autoria.observacaoCom(b.observacao, b._autoria, b._autoria?.executor_nome),
      executado_por: b._autoria?.executado_por ?? null
    });

    await cli.query('COMMIT');
    res.json({
      data: { codigos_pc: rows.map(r => r.codigo_pc), tr: b.tr, parcial_num: String(b.parcial_num), parecer_tipo: b.parecer_tipo },
      count: rows.length,
      error: null
    });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// GET /parcela/respostas_diligencia?analista_id=X — quais parciais já tiveram resposta
//
// Rota própria e leve, à parte da consulta pesada da Minha Planilha. Devolve só o que vale
// AGORA: `criado_em > dt_situacao` descarta a resposta da rodada anterior, porque abrir uma
// diligência nova reescreve `dt_situacao`.
app.get('/parcela/respostas_diligencia', async (req, res) => {
  try {
    const { analista_id, setorial_id } = req.query;
    // `dt_situacao IS NULL` cobre as diligências vindas da carga, que não têm essa data —
    // sem o ramo, a comparação daria NULL e o selo "Entidade respondeu" nunca apareceria.
    const cond = [`h.evento = 'resposta_diligencia'`,
                  `(p.dt_situacao IS NULL OR h.criado_em > p.dt_situacao)`];
    const val = [];
    if (analista_id) { val.push(parseInt(analista_id)); cond.push(`p.analista_id = $${val.length}`); }
    if (setorial_id) { val.push(setorial_id); cond.push(`p.setorial_id = $${val.length}`); }

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (h.tr, h.parcial_num) h.tr, h.parcial_num, h.criado_em
         FROM parcela_historico h
         JOIN prestacoes_contas p
           ON p.tr = h.tr AND p.parcial_num = h.parcial_num AND p.baixada = false
        WHERE ${cond.join(' AND ')}
        ORDER BY h.tr, h.parcial_num, h.criado_em DESC`, val);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    // A planilha carrega igual sem isto — só não mostra o selo de respondida.
    res.json({ data: [], count: 0, error: null });
  }
});

// POST /parcela/resposta_diligencia — body { tr, parcial_num, analista_id?, observacao?, setorial_id? }
//
// Registra que a ENTIDADE respondeu. NÃO muda a situação: a parcial continua em Diligência
// enquanto o analista avalia. São coisas diferentes, e juntá-las empurraria o analista a
// mudar o status antes da hora só para registrar a resposta.
//
// Serve de gatilho para o aviso de diligência vencida não sair. Não precisou de coluna nova:
// `parcela_historico` aceita qualquer `evento`, e a data do evento é a data da resposta.
app.post('/parcela/resposta_diligencia', async (req, res) => {
  const b = req.body || {};
  const erro = faltaChave(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // ⚠️ QUEM E O DONO E QUEM EXECUTOU — resolvido contra o perfil lido no BANCO. Dentro
    // da transacao, para nao decidir sobre um cadastro que mudou no meio.
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }
    const pcs = await carregarParcela(cli, b.tr, b.parcial_num, setorial_id);
    if (pcs.length === 0) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Parcial não encontrada' } });
    }
    // Só faz sentido em quem está em diligência — sem isto, um clique em parcial já resolvida
    // gravaria um evento que silenciaria a cobrança da PRÓXIMA rodada.
    if (!pcs.some(p => p.situacao_atual === 'Diligência' || p.status === 'diligencia')) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: 'Esta parcial não está em diligência.' } });
    }

    await registrarHistorico(cli, {
      tr: b.tr, parcial_num: String(b.parcial_num), setorial_id,
      evento: 'resposta_diligencia',
      // Mesmo cuidado do job: coluna `date` chega como objeto Date, e String(d).slice(0,10)
      // daria "Fri Aug 14" em vez de "2026-08-14".
      valor_anterior: pcs[0].prazo_diligencia
        ? (pcs[0].prazo_diligencia instanceof Date
            ? pcs[0].prazo_diligencia.toLocaleDateString('en-CA')
            : String(pcs[0].prazo_diligencia).slice(0, 10))
        : null,
      valor_novo: null,
      analista_id: b.analista_id ?? null,
      observacao: autoria.observacaoCom(b.observacao, b._autoria, b._autoria?.executor_nome),
      executado_por: b._autoria?.executado_por ?? null,
    });
    await cli.query('COMMIT');
    res.json({ data: { tr: b.tr, parcial_num: String(b.parcial_num), registrado: true }, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// POST /parcela/situacao — body { tr, parcial_num, situacao, prazo_diligencia?, qtd_diligencias?, observacao?, analista_id?, setorial_id? }
// Acompanhamento: NAO baixa, nao mexe em baixada/data_baixa. Pode ir e voltar quantas vezes precisar.
app.post('/parcela/situacao', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  const erro = faltaChave(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });
  if (!SITUACOES_VALIDAS.includes(b.situacao))
    return res.status(400).json({
      data: null,
      error: { message: `situacao inválida. Use uma de: ${SITUACOES_VALIDAS.join(', ')}` }
    });
  if (b.situacao === 'Diligência' && !b.prazo_diligencia)
    return res.status(400).json({ data: null, error: { message: 'Diligência exige prazo_diligencia' } });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // ⚠️ QUEM E O DONO E QUEM EXECUTOU — resolvido contra o perfil lido no BANCO. Dentro
    // da transacao, para nao decidir sobre um cadastro que mudou no meio.
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }
    const pcs = await carregarParcela(cli, b.tr, b.parcial_num, setorial_id);
    if (pcs.length === 0) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Parcial não encontrada' } });
    }
    if (pcs.every(p => p.baixada === true)) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: 'Parcial já baixada. Estorne antes de alterar a situação.' } });
    }

    const { rows } = await cli.query(
      `UPDATE prestacoes_contas
          SET situacao_atual = $1,
              status = $2,
              prazo_diligencia = $3,
              qtd_diligencias = COALESCE($4, qtd_diligencias),
              dt_situacao = NOW(),
              obs_situacao = $5,
              atualizado_em = NOW()
        WHERE setorial_id = $6 AND tr = $7 AND parcial_num = $8 AND baixada = false
        RETURNING codigo_pc`,
      [b.situacao, SITUACAO_PARA_STATUS[b.situacao],
       b.situacao === 'Diligência' ? b.prazo_diligencia : null,
       b.qtd_diligencias ?? null, b.observacao ?? null,
       setorial_id, b.tr, String(b.parcial_num)]
    );

    await registrarHistorico(cli, {
      tr: b.tr, parcial_num: String(b.parcial_num), setorial_id,
      evento: 'situacao',
      valor_anterior: pcs[0].situacao_atual || pcs[0].status || null,
      valor_novo: b.situacao,
      analista_id: b.analista_id ?? null,
      // ⚠️ A marca vai na coluna E no texto: a coluna serve para CONSULTAR, o texto para
      // quem abre uma linha solta. Só a coluna repetiria o erro do `registrado_por`.
      observacao: autoria.observacaoCom(b.observacao, b._autoria, b._autoria?.executor_nome),
      executado_por: b._autoria?.executado_por ?? null
    });

    await cli.query('COMMIT');
    res.json({
      data: { codigos_pc: rows.map(r => r.codigo_pc), tr: b.tr, parcial_num: String(b.parcial_num), situacao: b.situacao },
      count: rows.length,
      error: null
    });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// POST /parcela/ci — body { tr, parcial_num, analista_id, observacao, parecer_ci?, setorial_id? }
// D2: CI e campo proprio. Exige parecer previo e NAO apaga parecer_tipo.
app.post('/parcela/ci', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  const erro = faltaChave(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // ⚠️ QUEM E O DONO E QUEM EXECUTOU — resolvido contra o perfil lido no BANCO. Dentro
    // da transacao, para nao decidir sobre um cadastro que mudou no meio.
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }
    const pcs = await carregarParcela(cli, b.tr, b.parcial_num, setorial_id);
    if (pcs.length === 0) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Parcial não encontrada' } });
    }
    if (!pcs.some(p => p.parecer_tipo)) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: 'CI exige parecer prévio' } });
    }
    if (pcs.every(p => p.enviado_ci === true)) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: 'Parcial já encaminhada ao Controle Interno' } });
    }

    const { rows } = await cli.query(
      `UPDATE prestacoes_contas
          SET enviado_ci = true,
              dt_envio_ci = NOW(),
              parecer_ci = COALESCE($1, parecer_ci),
              -- ⚠️ QUEM CLICOU — ver executorDe. É esta coluna que correcao.podePuxarCi
              -- compara para decidir se o analista desfaz o encaminhamento sozinho. Sem
              -- ela, todo encaminhamento novo nascia sem autor e qualquer um podia puxá-lo.
              enviado_ci_por = $5,
              -- Entra na fila do CI. A coluna enviado_ci continua dizendo "foi ao CI" e
              -- sustenta a baixa; ci_situacao diz onde está no ciclo. Sem esta linha o
              -- encaminhamento não apareceria na tela do CI, que lista por ci_situacao.
              ci_situacao = 'na_fila',
              ci_rodada = GREATEST(ci_rodada, 1),
              atualizado_em = NOW()
        -- ⚠️ AND baixada = true — o terceiro da mesma família, 16/08/2026.
        --
        -- enviado_ci SUSTENTA A BAIXA (ver CLAUDE.md), e as PCs no ciclo do C.I. são todas
        -- baixada = true. Numa parcela MISTA o 409 acima não protege — ele exige que UMA
        -- tenha parecer, não que todas tenham —, então uma PC aberta e nunca analisada era
        -- marcada como encaminhada e passava a contar como baixada nos relatórios.
        --
        -- É a mesma regra que fez as 39 não baixadas ficarem de fora da frente 3 hoje.
        -- Em parcela normal não muda nada: lá todas já são baixadas.
        WHERE setorial_id = $2 AND tr = $3 AND parcial_num = $4
          AND baixada = true
        RETURNING codigo_pc`,
      [b.parecer_ci ?? null, setorial_id, b.tr, String(b.parcial_num), executorDe(b)]
    );

    await registrarHistorico(cli, {
      tr: b.tr, parcial_num: String(b.parcial_num), setorial_id,
      evento: 'ci',
      valor_anterior: pcs.find(p => p.parecer_tipo)?.parecer_tipo || null,
      valor_novo: 'enviado_ci = true',
      analista_id: b.analista_id ?? null,
      // ⚠️ A marca vai na coluna E no texto: a coluna serve para CONSULTAR, o texto para
      // quem abre uma linha solta. Só a coluna repetiria o erro do `registrado_por`.
      observacao: autoria.observacaoCom(b.observacao, b._autoria, b._autoria?.executor_nome),
      executado_por: b._autoria?.executado_por ?? null
    });

    await cli.query('COMMIT');
    res.json({
      data: { codigos_pc: rows.map(r => r.codigo_pc), tr: b.tr, parcial_num: String(b.parcial_num) },
      count: rows.length,
      error: null
    });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// POST /parcela/ci_lote — body { tr, parciais: ['1','2','5'], analista_id, setorial_id? }
//
// Encaminha VÁRIAS parcelas da MESMA TR ao Controle Interno, numa transação só.
//
// ⚠️ POR QUE ELA EXISTE. `enviarAoCI` manda uma parcela por vez, com um modal cada. Medido em
// 16/08/2026: **764 parcelas** baixadas com parecer e fora do C.I., em 41 analistas — a Geisa
// clicaria 63 vezes, a Perla 77.
//
// ⚠️ E POR QUE É ROTA, E NÃO UM LAÇO NA TELA. É a armadilha 16 do `sigpc-gt`: *"a tela não
// conta, não decide e não itera"*. Três lugares caíram nisso em 12–13/08 — a devolução, o
// assumir e o modal do limite —, e todos viraram rota transacional. 63 `POST` em série com a
// rede caindo no meio deixam metade feita.
//
// ⚠️ TUDO OU NADA (decisão do Richard, 16/08/2026). Uma parcela recusada aborta o lote, com a
// lista do porquê. O motivo está na tela: ela só oferece as do **passo 2**, então uma recusa
// significa que o estado mudou embaixo da pessoa — outro analista mexeu, ou a tela está
// velha. Parar e recarregar é mais honesto que encaminhar seis de sete e explicar depois.
//
// ⚠️ UMA LINHA DE HISTÓRICO POR PARCELA. `parcela_historico` é chaveado por
// `(tr, parcial_num)`: uma linha só para as sete não apareceria em seis delas.
app.post('/parcela/ci_lote', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  if (!b.tr) return res.status(400).json({ data: null, error: { message: 'tr é obrigatório' } });

  // ⚠️ LISTA EXPLÍCITA DE CHAVES (regra 12) — nunca "todas as do passo 2 desta TR" calculado
  // aqui. O que o servidor grava tem de ser o que a pessoa viu e confirmou na tela.
  const parciais = [...new Set((Array.isArray(b.parciais) ? b.parciais : [])
    .map(p => String(p ?? '').trim()).filter(Boolean))];
  if (!parciais.length)
    return res.status(400).json({ data: null, error: { message: 'parciais é obrigatório e não pode ser vazio' } });
  if (parciais.length > 200)
    return res.status(400).json({ data: null, error: { message: 'lote grande demais (máximo 200 parciais)' } });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await cli.query(`SET LOCAL lock_timeout = '15s'`);
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }

    // ── 1. carrega e confere TODAS antes de escrever QUALQUER uma ─────────────
    const recusadas = [], aceitas = [];
    for (const num of parciais) {
      const pcs = await carregarParcela(cli, b.tr, num, setorial_id);
      if (pcs.length === 0)            { recusadas.push({ parcial: num, motivo: 'Parcial não encontrada' }); continue; }
      if (!pcs.some(p => p.parecer_tipo)) { recusadas.push({ parcial: num, motivo: 'CI exige parecer prévio' }); continue; }
      const baixadas = pcs.filter(p => p.baixada === true);
      // ⚠️ `enviado_ci` SUSTENTA A BAIXA, e o C.I. vem DEPOIS do parecer: só entra baixada.
      // É a mesma regra do `AND baixada = true` que a rota individual ganhou hoje.
      if (baixadas.length === 0)       { recusadas.push({ parcial: num, motivo: 'Parcial não está baixada' }); continue; }
      if (baixadas.every(p => p.enviado_ci === true))
                                       { recusadas.push({ parcial: num, motivo: 'Já encaminhada ao Controle Interno' }); continue; }
      aceitas.push({ num, pcs, parecer: pcs.find(p => p.parecer_tipo)?.parecer_tipo || null });
    }

    if (recusadas.length) {
      await cli.query('ROLLBACK');
      return res.status(409).json({
        data: { recusadas, aceitas: aceitas.map(a => a.num) },
        error: {
          message: `${recusadas.length} de ${parciais.length} parcelas não podem ser encaminhadas. ` +
                   `Nada foi gravado — recarregue a TR e tente de novo.`,
          recusadas
        }
      });
    }

    // ── 2. a escrita, por lista explícita de parciais ─────────────────────────
    const nums = aceitas.map(a => a.num);
    const { rows } = await cli.query(
      `UPDATE prestacoes_contas
          SET enviado_ci = true,
              dt_envio_ci = NOW(),
              -- ⚠️ QUEM CLICOU — ver executorDe. O lote encaminha até 200 parcelas de uma
              -- vez, e todas ficam com o mesmo autor: foi um clique só.
              enviado_ci_por = $4,
              ci_situacao = 'na_fila',
              ci_rodada = GREATEST(ci_rodada, 1),
              atualizado_em = NOW()
        WHERE setorial_id = $1 AND tr = $2 AND parcial_num = ANY($3)
          AND baixada = true AND enviado_ci = false
        RETURNING codigo_pc, parcial_num`,
      [setorial_id, b.tr, nums, executorDe(b)]);

    // ── 3. uma linha de histórico POR PARCELA ─────────────────────────────────
    for (const a of aceitas) {
      const n = rows.filter(r => r.parcial_num === a.num).length;
      await registrarHistorico(cli, {
        tr: b.tr, parcial_num: a.num, setorial_id,
        evento: 'ci',
        valor_anterior: a.parecer,
        valor_novo: 'enviado_ci = true',
        analista_id: b.analista_id ?? null,
        observacao: autoria.observacaoCom(
          `em lote com outras ${nums.length - 1} parcela${nums.length - 1 === 1 ? '' : 's'} desta TR · ${n} PC${n > 1 ? 's' : ''}`,
          b._autoria, b._autoria?.executor_nome),
        executado_por: b._autoria?.executado_por ?? null
      });
    }

    await cli.query('COMMIT');
    res.json({
      data: { tr: b.tr, encaminhadas: nums, pcs: rows.length,
              codigos_pc: rows.map(r => r.codigo_pc), recusadas: [] },
      count: nums.length,
      error: null
    });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// POST /parcela/estornar — body { tr, parcial_num, motivo, usuario_id, usuario_nome, perfil, setorial_id? }
// So coordenador/superadmin. Desfaz a parcial inteira.
app.post('/parcela/estornar', async (req, res) => {
  const b = req.body || {};
  const erro = faltaChave(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });
  // ⚠️ O perfil vem do BANCO. Antes vinha do corpo, e o corpo nunca provou nada.
  const quemEst = await lerUsuario(pool, b.usuario_id);
  const peEst = papel.perfilEfetivo(quemEst);
  // ⚠️ SÓ SUPERADMIN, desde 18/08/2026 — o coordenador saiu junto com o do lote.
  //
  // Isto NÃO estava na lista do Richard, que citou só a rota em lote. Está aqui porque o
  // pedido dele foi esconder o botão do cartão para o coordenador, e esconder botão sem
  // fechar a rota é cortina, não tranca: quem montar o `POST` à mão continua estornando.
  // É a mesma lição das quatro rotas que liam `perfil` do corpo até 14/08.
  //
  // O coordenador não fica sem saída: ele decide os pedidos da fila de Correções, e a
  // aprovação executa a mesma coisa pelo caminho que deixa rastro.
  if (peEst !== 'superadmin')
    return res.status(403).json({ data: null, error: {
      message: 'Apenas o técnico do sistema estorna. '
             + 'Use "Corrigir situação" — ela desfaz a baixa e fica no histórico da parcial.' } });
  if (!b.motivo || b.motivo.trim().length < 15)
    return res.status(400).json({ data: null, error: { message: 'motivo deve ter no mínimo 15 caracteres' } });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    // ⚠️ O ESTORNO NÃO PASSA PELA AUTORIA DUPLA, de propósito. Não é trabalho do analista: é
    // decisão de coordenação SOBRE o trabalho dele, e já tem autoria própria (`estornado_por`
    // e `motivo_estorno`). É uma das quatro travas que FICAM no modo "ver como" — e o corpo
    // dele nem manda `analista_id`, manda `usuario_id` e `perfil`.
    const pcs = await carregarParcela(cli, b.tr, b.parcial_num, setorial_id);
    if (pcs.length === 0) {
      await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Parcial não encontrada' } });
    }
    if (!pcs.some(p => p.baixada === true)) {
      await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: 'Parcial não está baixada' } });
    }

    // data_baixa fica preservada: a produtividade cumulativa usa
    // (estornada = false OR data_estorno > corte) para saber o que valia em cada data.
    const { rows } = await cli.query(
      `UPDATE prestacoes_contas
          SET baixada = false,
              status = 'livre',
              estornada = true,
              data_estorno = NOW(),
              motivo_estorno = $1,
              estornado_por = $2,
              parecer_tipo = NULL,
              situacao_atual = NULL,
              -- ⚠️ LIMPA O AUTOR DA BAIXA, porque a baixa deixou de existir. Uma PC não
              -- baixada carregando baixado_por afirma uma autoria de algo que não há — e
              -- a migração de 18/08 tem conferência exata para isso ("baixado_por so em
              -- baixada"). É o mesmo que correcao.SQL_TIRAR_DA_PRODUTIVIDADE já faz.
              baixado_por = NULL,
              atualizado_em = NOW()
        -- ⚠️ AND baixada = true — o espelho da correção do parecer, mesma data.
        --
        -- O estorno desfaz a baixa. Sem esta cláusula ele marcava estornada = true e
        -- data_estorno = NOW() em PCs que **nunca foram baixadas**, dentro de uma parcela
        -- mista — e o 409 acima também não protege, porque ele só recusa quando NENHUMA está
        -- baixada (!pcs.some(p => p.baixada)).
        --
        -- Estornar o que nunca foi baixado inventa um evento que não houve, e a produtividade
        -- cumulativa lê data_estorno para saber o que valia em cada data.
        WHERE setorial_id = $3 AND tr = $4 AND parcial_num = $5
          AND baixada = true
        RETURNING codigo_pc`,
      [b.motivo, b.usuario_nome ?? null, setorial_id, b.tr, String(b.parcial_num)]
    );

    await registrarHistorico(cli, {
      tr: b.tr, parcial_num: String(b.parcial_num), setorial_id,
      evento: 'estorno',
      valor_anterior: pcs.find(p => p.parecer_tipo)?.parecer_tipo || 'baixada',
      valor_novo: 'livre',
      analista_id: b.usuario_id ?? null,
      observacao: b.motivo
    });

    await cli.query('COMMIT');
    res.json({
      data: { codigos_pc: rows.map(r => r.codigo_pc), tr: b.tr, parcial_num: String(b.parcial_num) },
      count: rows.length,
      error: null
    });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally {
    cli.release();
  }
});

// ══════════════════════════════════════
//  CORRIGIR SITUAÇÃO · PUXAR DO C.I. · CADASTRAR PC · PEDIR CORREÇÃO   (18/08/2026)
// ══════════════════════════════════════
// A regra mora em `lib/correcao.js`, `lib/pc-nova.js` e `lib/solicitacao-correcao.js`.
// Aqui só se abre a transação, confere-se quem pede (contra o BANCO) e responde.
//
// ⚠️ TODAS ESTAS ROTAS ENTRAM POR `codigo_pc`, NUNCA POR `parcial_num` — decisão do Richard,
// 18/08/2026. `tr`, `parcial_num` e `setorial_id` saem da PRÓPRIA LINHA do banco; o navegador
// não tem como provar nenhum dos três, e a PC final tem quatro grafias de `parcial_num`.

/** Carrega a PC alvo e as irmãs, com lock, e resolve o alcance da ação. */
async function carregarAlvoCorrecao(cli, codigoPc) {
  const { rows } = await cli.query(correcao.SQL_CARREGAR_ALVO, [codigoPc]);
  if (!rows.length) return null;
  const pc = rows[0];
  const { rows: irmas } = await cli.query(correcao.SQL_CARREGAR_IRMAS,
    [pc.setorial_id, pc.tr, pc.parcial_num]);
  return { pc, irmas, alvo: correcao.alvoDaAcao(pc, irmas) };
}

/**
 * Executa a correção de situação. Usada pela rota direta (A) E pela aprovação do
 * coordenador (D) — uma função só, porque duas divergiriam.
 *
 * ⚠️ O RAMO É DECIDIDO PELO ESTADO DA PC, não pelo destino pedido. Estava baixada? sai da
 * produtividade pelas QUATRO colunas. Não estava? só muda a situação — marcar estorno em PC
 * nunca baixada inventa um evento que não houve (é a correção de 16/08 no estornar).
 */
async function aplicarCorrecaoSituacao(cli, { pc, alvo }, destino, motivo, quemNome) {
  const status = correcao.DESTINO_PARA_STATUS[destino];
  const sitAtual = destino === 'Livre' ? null : destino;
  if (pc.baixada === true) {
    const { rows } = await cli.query(correcao.SQL_TIRAR_DA_PRODUTIVIDADE,
      [alvo, status, sitAtual, motivo, quemNome ?? null]);
    return { linhas: rows, desfezBaixa: true };
  }
  const { rows } = await cli.query(correcao.SQL_SO_SITUACAO, [alvo, status, sitAtual, motivo]);
  return { linhas: rows, desfezBaixa: false };
}

/** Executa a volta do C.I. Mesma função para a rota direta (B) e para a aprovação (D). */
async function aplicarPuxarCi(cli, { alvo }, motivo, quemNome) {
  const { rows } = await cli.query(correcao.SQL_PUXAR_CI, [alvo, motivo, quemNome ?? null]);
  return { linhas: rows, desfezBaixa: true };
}

// GET /parcela/acoes?codigo_pc=X&usuario_id=N — o que ESTE usuário pode fazer nesta parcial.
//
// ⚠️ É O SERVIDOR QUE DECIDE, e a tela só desenha. Sem esta rota o `index.html` teria de
// repetir as regras de `podeCorrigirBaixa`/`podePuxarCi` — e a cópia divergiria no primeiro
// ajuste, exatamente como aconteceu com o mapa de nomes curtos, que chegou a ter três cópias.
app.get('/parcela/acoes', async (req, res) => {
  const cli = await pool.connect();
  try {
    const quem = await lerUsuario(cli, req.query.usuario_id);
    if (!quem) return res.status(401).json({ data: null, error: { message: 'Usuário não identificado.' } });
    const pe = papel.perfilEfetivo(quem);

    const { rows } = await cli.query(
      `SELECT codigo_pc, tr, parcial_num, setorial_id, tipo, baixada, status, situacao_atual,
              parecer_tipo, origem_baixa, baixado_por, analista_id, enviado_ci, enviado_ci_por,
              ci_situacao FROM prestacoes_contas WHERE codigo_pc = $1`, [req.query.codigo_pc]);
    if (!rows.length) return res.status(404).json({ data: null, error: { message: 'PC não encontrada.' } });
    const pc = rows[0];

    const corr = correcao.podeCorrigirBaixa(pe, quem.id, pc);
    const puxar = correcao.podePuxarCi(pe, quem.id, pc);

    // Já existe pedido pendente? A tela precisa saber para não oferecer "solicitar" de novo.
    const { rows: pend } = await cli.query(
      `SELECT acao FROM solicitacao_correcao WHERE codigo_pc = $1 AND status = 'pendente'`,
      [pc.codigo_pc]);
    const pendentes = pend.map(p => p.acao);

    res.json({
      data: {
        codigo_pc: pc.codigo_pc, tr: pc.tr, tipo: pc.tipo, baixada: pc.baixada,
        enviado_ci: pc.enviado_ci, destinos: correcao.DESTINOS,
        corrigir_situacao: { ...corr, pendente: pendentes.includes('corrigir_situacao') },
        puxar_ci: { ...puxar, pendente: pendentes.includes('puxar_ci') },
        // Cadastrar PC é por TR, não por PC — a tela usa isto para acender o item do menu.
        cadastrar_pc: pe === 'superadmin' || String(pc.analista_id ?? '') === String(quem.id),
      }, error: null,
    });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /parcela/corrigir_situacao — body { codigo_pc, situacao_destino, motivo, analista_id }
app.post('/parcela/corrigir_situacao', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  if (!b.codigo_pc) return res.status(400).json({ data: null, error: { message: 'codigo_pc é obrigatório' } });
  const eD = correcao.validarDestino(b.situacao_destino);
  if (eD) return res.status(400).json({ data: null, error: { message: eD } });
  const eM = correcao.validarMotivo(b.motivo);
  if (eM) return res.status(400).json({ data: null, error: { message: eM } });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }
    const quem = await lerUsuario(cli, b.executado_por ?? b.analista_id);
    const pe = papel.perfilEfetivo(quem);

    const alvo = await carregarAlvoCorrecao(cli, b.codigo_pc);
    if (!alvo) { await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'PC não encontrada' } }); }

    // ⚠️ A PERMISSÃO É CONFERIDA AQUI, DENTRO DA TRANSAÇÃO E COM A LINHA TRAVADA. Conferir
    // antes do lock deixaria a janela em que outro analista baixa a parcial no meio.
    const ok = correcao.podeCorrigirBaixa(pe, quem.id, alvo.pc);
    if (!ok.pode) { await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: { message: ok.motivo, via_solicitacao: ok.viaSolicitacao } }); }

    const antes = alvo.pc.situacao_atual || alvo.pc.status || null;
    const r = await aplicarCorrecaoSituacao(cli, alvo, b.situacao_destino, b.motivo.trim(), quem.nome);

    await registrarHistorico(cli, {
      tr: alvo.pc.tr, parcial_num: alvo.pc.parcial_num, setorial_id: alvo.pc.setorial_id,
      evento: 'correcao_situacao',
      valor_anterior: antes, valor_novo: b.situacao_destino,
      analista_id: b.analista_id ?? null,
      observacao: autoria.observacaoCom(
        `${b.motivo.trim()} · ${r.desfezBaixa ? 'DESFEZ A BAIXA — sai da produtividade' : 'parcial nao estava baixada'}`
        + ` · ${r.linhas.length} PC${r.linhas.length > 1 ? 's' : ''}`,
        b._autoria, b._autoria?.executor_nome),
      executado_por: b._autoria?.executado_por ?? null,
    });

    await cli.query('COMMIT');
    res.json({ data: { codigos_pc: r.linhas.map(x => x.codigo_pc), desfez_baixa: r.desfezBaixa,
                       situacao: b.situacao_destino }, count: r.linhas.length, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /parcela/puxar_ci — body { codigo_pc, motivo, analista_id }
app.post('/parcela/puxar_ci', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  if (!b.codigo_pc) return res.status(400).json({ data: null, error: { message: 'codigo_pc é obrigatório' } });
  const eM = correcao.validarMotivo(b.motivo);
  if (eM) return res.status(400).json({ data: null, error: { message: eM } });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    if (await resolverAutoria(cli, b, res)) { await cli.query('ROLLBACK'); return; }
    const quem = await lerUsuario(cli, b.executado_por ?? b.analista_id);
    const pe = papel.perfilEfetivo(quem);

    const alvo = await carregarAlvoCorrecao(cli, b.codigo_pc);
    if (!alvo) { await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'PC não encontrada' } }); }

    const ok = correcao.podePuxarCi(pe, quem.id, alvo.pc);
    if (!ok.pode) { await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: { message: ok.motivo, via_solicitacao: ok.viaSolicitacao } }); }

    const r = await aplicarPuxarCi(cli, alvo, b.motivo.trim(), quem.nome);

    await registrarHistorico(cli, {
      tr: alvo.pc.tr, parcial_num: alvo.pc.parcial_num, setorial_id: alvo.pc.setorial_id,
      evento: 'puxar_ci',
      valor_anterior: alvo.pc.ci_situacao || 'enviado_ci = true', valor_novo: 'fora do C.I.',
      analista_id: b.analista_id ?? null,
      observacao: autoria.observacaoCom(
        `${b.motivo.trim()} · DESFEZ A BAIXA — sai da produtividade · ${r.linhas.length} PC${r.linhas.length > 1 ? 's' : ''}`,
        b._autoria, b._autoria?.executor_nome),
      executado_por: b._autoria?.executado_por ?? null,
    });

    await cli.query('COMMIT');
    res.json({ data: { codigos_pc: r.linhas.map(x => x.codigo_pc) }, count: r.linhas.length, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /prestacoes_contas/nova — body { tr, tipo, codigo_pc?, parcial_num?, valor?, codigo_nl?,
//                                       processo_pc?, dt_limite_pc?, prazo_analise_dias?, analista_id }
//
// ⚠️ O NOME DA ROTA É `/nova` E NÃO `POST /prestacoes_contas`, por causa da armadilha 13:
// rota de nome fixo tem de vir ANTES da rota com `:codigo_pc`, e `PATCH
// /prestacoes_contas/:codigo_pc` já existe. Um `POST /prestacoes_contas` puro conviveria,
// mas o par GET/PATCH/POST no mesmo caminho é onde esse erro nasce.
app.post('/prestacoes_contas/nova', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const quem = await lerUsuario(cli, b.analista_id);
    if (!quem) { await cli.query('ROLLBACK');
      return res.status(401).json({ data: null, error: { message: 'Usuário não identificado.' } }); }
    const pe = papel.perfilEfetivo(quem);

    const m = pcNova.montar(b, b.tr);
    if (m.erro) { await cli.query('ROLLBACK');
      return res.status(400).json({ data: null, error: { message: m.erro } }); }
    const linha = m.linha;

    const { rows: daTr } = await cli.query(pcNova.SQL_PCS_DA_TR, [setorial_id, linha.tr]);
    const podeC = pcNova.podeCadastrar(pe, quem.id, daTr);
    if (!podeC.pode) { await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: { message: podeC.motivo } }); }

    const { rows: jaTem } = await cli.query(pcNova.SQL_JA_EXISTE, [linha.codigo_pc]);
    if (jaTem.length) { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: {
        message: `A PC ${linha.codigo_pc} já existe (TR ${jaTem[0].tr}, ${jaTem[0].tipo}).` } }); }

    // Herda o que a TR já sabe. O dono vem do acervo, não do corpo — ver `SQL_INSERIR`.
    const base = daTr.find(p => p.analista_id != null) || daTr[0] || {};
    const dono = pe === 'superadmin' && base.analista_id != null ? base.analista_id : quem.id;
    const donoLinha = daTr.find(p => String(p.analista_id) === String(dono)) || base;

    const { rows: inseridas } = await cli.query(pcNova.SQL_INSERIR, [
      linha.codigo_pc, linha.codigo_nl, linha.tipo, linha.tr, linha.parcela_seq, linha.parcial_num,
      linha.valor, linha.processo_pc, linha.processo_mae || base.processo_mae || null,
      linha.entidade || base.entidade || null, linha.cnpj_cpf || base.cnpj_cpf || null,
      linha.dt_limite_pc, linha.prazo_analise_dias,
      setorial_id, dono, donoLinha.analista_nome ?? null, donoLinha.grupo ?? null, quem.nome,
    ]);

    await registrarHistorico(cli, {
      tr: linha.tr, parcial_num: linha.parcial_num, setorial_id,
      evento: 'pc_nova',
      valor_anterior: null,
      valor_novo: `${linha.codigo_pc} (${linha.tipo})`,
      analista_id: dono,
      observacao: `PC cadastrada por ${quem.nome}`
        + (linha.tipo === 'final'
            ? ` · FINAL: sem valor financeiro, parcela_seq ${pcNova.PARCELA_SEQ_FINAL}, sem NL`
            : ` · parcial ${linha.parcial_num}`),
      executado_por: String(dono) === String(quem.id) ? null : quem.id,
    });

    await cli.query('COMMIT');
    res.json({ data: inseridas[0], count: 1, error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    // O UNIQUE do banco é a trava de verdade — duas abas no mesmo código chegam juntas.
    if (e.code === '23505')
      return res.status(409).json({ data: null, error: { message: 'Esta PC já existe.' } });
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// POST /solicitacao_correcao — o analista PEDE ao coordenador do grupo dele
app.post('/solicitacao_correcao', async (req, res) => {
  const b = req.body || {};
  if (await barrouPreparacao(res, b.analista_id)) return;
  const erro = solCor.validarPedido(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const quem = await lerUsuario(cli, b.analista_id);
    if (!quem) { await cli.query('ROLLBACK');
      return res.status(401).json({ data: null, error: { message: 'Usuário não identificado.' } }); }

    const alvo = await carregarAlvoCorrecao(cli, b.codigo_pc);
    if (!alvo) { await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'PC não encontrada' } }); }

    // ⚠️ SÓ SE PEDE O QUE NÃO SE PODE FAZER SOZINHO. Sem esta conferência o analista mandaria
    // à fila do coordenador uma correção que ele mesmo poderia aplicar num clique — e a fila
    // dos três coordenadores é o recurso escasso aqui.
    const pe = papel.perfilEfetivo(quem);
    const r = b.acao === 'puxar_ci'
      ? correcao.podePuxarCi(pe, quem.id, alvo.pc)
      : correcao.podeCorrigirBaixa(pe, quem.id, alvo.pc);
    if (r.pode) { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: {
        message: 'Você mesmo pode fazer esta correção — não precisa pedir.' } }); }
    if (!r.viaSolicitacao) { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: r.motivo } }); }

    const autorOriginal = b.acao === 'puxar_ci' ? alvo.pc.enviado_ci_por : alvo.pc.baixado_por;
    const { rows } = await cli.query(solCor.SQL_CRIAR, [
      quem.id, alvo.pc.codigo_pc, alvo.pc.tr, alvo.pc.setorial_id, b.acao,
      b.acao === 'corrigir_situacao' ? b.situacao_destino : null,
      b.motivo.trim(), alvo.alvo.length, autorOriginal ?? null,
    ]);

    await registrarHistorico(cli, {
      tr: alvo.pc.tr, parcial_num: alvo.pc.parcial_num, setorial_id: alvo.pc.setorial_id,
      evento: 'solicitacao_correcao',
      valor_anterior: alvo.pc.situacao_atual || alvo.pc.status || null,
      valor_novo: `pedido #${rows[0].id}: ${solCor.acaoTexto(b.acao)}`,
      analista_id: quem.id,
      observacao: `${b.motivo.trim()} · aguardando o coordenador do grupo ${quem.grupo ?? '—'}`,
    });

    await cli.query('COMMIT');

    // O coordenador do grupo é avisado pelo sino. Cai para o superadmin se o grupo não tiver
    // coordenador — a mesma proteção de `notificacao.coordenadoresDoGrupo`.
    notif.coordenadoresDoGrupo(pool, quem.grupo).then(ids => Promise.all(ids.map(id => notif.criar(pool, {
      destinatario_id: id, tipo: 'aprovacao',
      titulo: `Pedido de correção — ${alvo.pc.tr}`,
      mensagem: `${quem.nome} pediu: ${solCor.acaoTexto(b.acao)} na PC ${alvo.pc.codigo_pc}. `
              + `Motivo: "${b.motivo.trim()}"`,
      link: '#aprovacoes', ref_tipo: 'solicitacao_correcao', ref_id: `sc-${rows[0].id}`,
    })))).catch(e => console.error('Falha ao notificar pedido de correcao:', e.message));

    res.json({ data: rows[0], error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    if (e.code === '23505')
      return res.status(409).json({ data: null, error: {
        message: 'Já existe um pedido pendente para esta PC e esta ação.' } });
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// GET /solicitacao_correcao?usuario_id=N&status=pendente — a fila, recortada pelo SERVIDOR
app.get('/solicitacao_correcao', async (req, res) => {
  const cli = await pool.connect();
  try {
    const quem = await lerUsuario(cli, req.query.usuario_id);
    if (!quem) return res.status(403).json({ data: null, error: { message: 'Usuário não identificado.' } });
    const pe = papel.perfilEfetivo(quem);

    // ⚠️ O RECORTE É DO SERVIDOR. O analista vê só os dele; o coordenador, só os do grupo
    // dele; o superadmin, todos. Esconder na tela não impediria ninguém de pedir a fila
    // inteira por HTTP — é a mesma trava de `GET /solicitacao_devolucao`.
    let fAnalista = null, fGrupo = null;
    if (pe === 'analista') fAnalista = quem.id;
    else if (pe === 'coordenador') fGrupo = String(quem.grupo ?? '');
    else if (pe !== 'superadmin')
      return res.status(403).json({ data: null, error: { message: 'Sem acesso a esta fila.' } });

    const { rows } = await cli.query(solCor.SQL_LISTAR, [req.query.status || null, fAnalista, fGrupo]);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// PATCH /solicitacao_correcao/:id — body { status:'aprovada'|'negada', decidido_por, motivo_decisao }
//
// ⚠️ APROVAR EXECUTA A AÇÃO NA MESMA TRANSAÇÃO, e pelas MESMAS funções da rota direta
// (`aplicarCorrecaoSituacao` / `aplicarPuxarCi`). Duas regras de "o que a aprovação faz"
// divergiriam — é o mesmo motivo que faz a aprovação da devolução chamar `devol.SQL_DEVOLVER`.
app.patch('/solicitacao_correcao/:id', async (req, res) => {
  const b = req.body || {};
  const erro = solCor.validarDecisao(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const quem = await lerUsuario(cli, b.decidido_por);
    if (!quem) { await cli.query('ROLLBACK');
      return res.status(403).json({ data: null, error: { message: 'Usuário não identificado.' } }); }
    const pe = papel.perfilEfetivo(quem);

    const { rows: ped } = await cli.query(solCor.SQL_LER_PARA_DECIDIR, [parseInt(req.params.id) || 0]);
    if (!ped.length) { await cli.query('ROLLBACK');
      return res.status(404).json({ data: null, error: { message: 'Pedido não encontrado.' } }); }
    const p = ped[0];

    if (!solCor.podeDecidir(quem, p, pe)) { await cli.query('ROLLBACK');
      const proprio = String(p.analista_id) === String(quem.id);
      return res.status(403).json({ data: null, error: { message: proprio
        ? 'Você não decide o próprio pedido. Ele vai para o coordenador do seu grupo.'
        : 'Só o coordenador do grupo ou o superadmin decidem este pedido.' } }); }

    if (p.status !== 'pendente') { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: `Este pedido já foi ${p.status}.` } }); }

    const autodec = String(p.analista_id) === String(quem.id);
    let aplicadas = [];
    if (b.status === 'aprovada') {
      const alvo = await carregarAlvoCorrecao(cli, p.codigo_pc);
      if (!alvo) { await cli.query('ROLLBACK');
        return res.status(409).json({ data: null, error: { message: 'A PC do pedido não existe mais.' } }); }

      // Reconferido AGORA: entre o pedido e a decisão a parcial pode ter mudado de estado.
      if (p.acao === 'puxar_ci' && alvo.pc.enviado_ci !== true) { await cli.query('ROLLBACK');
        return res.status(409).json({ data: null, error: {
          message: 'Esta parcial já não está no Controle Interno. O pedido perdeu o objeto.' } }); }

      const motivoExec = `${p.motivo} · aprovado por ${quem.nome}: ${b.motivo_decisao.trim()}`
        + (autodec ? ` · ${solCor.MARCA_AUTODECIDIDO}` : '');
      const r = p.acao === 'puxar_ci'
        ? await aplicarPuxarCi(cli, alvo, motivoExec, quem.nome)
        : await aplicarCorrecaoSituacao(cli, alvo, p.situacao_destino, motivoExec, quem.nome);
      aplicadas = r.linhas;

      await registrarHistorico(cli, {
        tr: alvo.pc.tr, parcial_num: alvo.pc.parcial_num, setorial_id: alvo.pc.setorial_id,
        evento: p.acao === 'puxar_ci' ? 'puxar_ci' : 'correcao_situacao',
        valor_anterior: alvo.pc.situacao_atual || alvo.pc.status || null,
        valor_novo: p.acao === 'puxar_ci' ? 'fora do C.I.' : p.situacao_destino,
        // ⚠️ O DONO do trabalho é quem PEDIU; quem clicou foi o coordenador.
        analista_id: p.analista_id,
        observacao: motivoExec + ` · pedido #${p.id} · ${r.desfezBaixa ? 'DESFEZ A BAIXA' : 'sem baixa a desfazer'}`,
        executado_por: autodec ? null : quem.id,
      });
    } else {
      await registrarHistorico(cli, {
        tr: p.tr, parcial_num: null, setorial_id: p.setorial_id,
        evento: 'correcao_negada',
        valor_anterior: `pedido #${p.id}`, valor_novo: 'negada',
        analista_id: p.analista_id,
        observacao: `${quem.nome} negou: ${b.motivo_decisao.trim()}`,
        executado_por: autodec ? null : quem.id,
      });
    }

    const { rows: fim } = await cli.query(solCor.SQL_DECIDIR,
      [p.id, b.status, quem.id, b.motivo_decisao.trim()]);
    if (!fim.length) { await cli.query('ROLLBACK');
      return res.status(409).json({ data: null, error: { message: 'Este pedido acabou de ser decidido.' } }); }

    await cli.query('COMMIT');

    notif.criar(pool, {
      destinatario_id: p.analista_id, tipo: 'aprovacao',
      titulo: (b.status === 'aprovada' ? 'Correção aprovada — ' : 'Correção recusada — ') + p.codigo_pc,
      mensagem: (b.status === 'aprovada'
          ? `${solCor.acaoTexto(p.acao)} foi aplicada em ${aplicadas.length} PC${aplicadas.length > 1 ? 's' : ''}.`
          : `${solCor.acaoTexto(p.acao)} NÃO foi aplicada.`)
        + ` ${quem.nome} escreveu: "${b.motivo_decisao.trim()}"`,
      link: '#planilha', ref_tipo: 'solicitacao_correcao', ref_id: `dec-${p.id}`,
    }).catch(e => console.error('Falha ao notificar decisao de correcao:', e.message));

    res.json({ data: { ...fim[0], aplicadas: aplicadas.map(x => x.codigo_pc), autodecidido: autodec },
               error: null });
  } catch (e) {
    try { await cli.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ data: null, error: { message: e.message } });
  } finally { cli.release(); }
});

// ══════════════════════════════════════
//  METAS_ANALISTAS
// ══════════════════════════════════════
// GET /metas_analistas?analista_id=X&grupo=X&periodo=X&vigente=true&setorial_id=X
app.get('/metas_analistas', async (req, res) => {
  try {
    const { analista_id, grupo, periodo, vigente, setorial_id } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (analista_id) { conditions.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    if (grupo) { conditions.push(`grupo = $${i++}`); values.push(parseInt(grupo)); }
    if (periodo) { conditions.push(`periodo = $${i++}`); values.push(periodo); }
    if (vigente !== undefined) { conditions.push(`vigente = $${i++}`); values.push(vigente === 'true'); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(`SELECT * FROM metas_analistas ${where} ORDER BY analista_nome`, values);
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  ANOTACOES_TR
// ══════════════════════════════════════
app.get('/anotacoes_tr', async (req, res) => {
  try {
    const { tr, trs } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (tr) { conditions.push(`tr = $${i++}`); values.push(tr); }
    // `trs` (lista separada por vírgula) existe para o painel da Minha Planilha: ele precisa
    // saber quais das ~54 TRs do analista têm anotação, e uma chamada por TR seriam 54
    // requisições só para desenhar um ícone.
    if (trs) { conditions.push(`tr = ANY($${i++}::text[])`); values.push(String(trs).split(',').filter(Boolean)); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM anotacoes_tr ${where} ORDER BY criado_em DESC`,
      values
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/anotacoes_tr', async (req, res) => {
  try {
    const { tr, analista_id, analista_nome, texto } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO anotacoes_tr (tr, analista_id, analista_nome, texto)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tr, analista_id, analista_nome, texto]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// DELETE /anotacoes_tr/:id — só apaga se analista_id do body bater com o do registro
app.delete('/anotacoes_tr/:id', async (req, res) => {
  try {
    const { analista_id } = req.body;
    const { rows } = await pool.query(
      `DELETE FROM anotacoes_tr WHERE id = $1 AND analista_id = $2 RETURNING *`,
      [req.params.id, analista_id]
    );
    if (rows.length === 0)
      return res.status(403).json({ data: null, error: { message: 'Não autorizado ou anotação não encontrada' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  AFASTAMENTOS
// ══════════════════════════════════════
app.get('/afastamentos', async (req, res) => {
  try {
    const { analista_id, setorial_id, data_inicio_gte, data_fim_lte } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (analista_id) { conditions.push(`analista_id = $${i++}`); values.push(parseInt(analista_id)); }
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (data_inicio_gte) { conditions.push(`data_inicio >= $${i++}`); values.push(data_inicio_gte); }
    if (data_fim_lte) { conditions.push(`data_fim <= $${i++}`); values.push(data_fim_lte); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM afastamentos ${where} ORDER BY data_inicio DESC`,
      values
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/afastamentos', async (req, res) => {
  try {
    const { analista_id, analista_nome, data_inicio, data_fim, motivo, observacao, setorial_id, registrado_por } = req.body;
    if (!analista_id || !data_inicio || !data_fim || !motivo)
      return res.status(400).json({ data: null, error: { message: 'analista_id, data_inicio, data_fim e motivo são obrigatórios' } });
    const { rows } = await pool.query(
      `INSERT INTO afastamentos (analista_id, analista_nome, data_inicio, data_fim, motivo, observacao, setorial_id, registrado_por, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
      [analista_id, analista_nome || null, data_inicio, data_fim, motivo, observacao || null, setorial_id || null, registrado_por || null]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.patch('/afastamentos/:id', async (req, res) => {
  try {
    const campos = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    const permitidos = ['analista_id', 'analista_nome', 'data_inicio', 'data_fim', 'motivo', 'observacao', 'setorial_id'];
    permitidos.forEach(c => {
      if (campos[c] !== undefined) {
        sets.push(`${c} = $${i++}`);
        values.push(campos[c]);
      }
    });
    if (sets.length === 0)
      return res.status(400).json({ data: null, error: { message: 'nenhum campo permitido informado' } });
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE afastamentos SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.delete('/afastamentos/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM afastamentos WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ data: null, error: { message: 'Afastamento não encontrado' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  RELATÓRIOS CGE
// ══════════════════════════════════════
function toJsonb(v) {
  return (v !== undefined && v !== null && typeof v === 'object') ? JSON.stringify(v) : v;
}

app.get('/relatorios_cge', async (req, res) => {
  try {
    const { setorial_id, status } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    if (status) { conditions.push(`status = $${i++}`); values.push(status); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM relatorios_cge ${where} ORDER BY criado_em DESC`,
      values
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.get('/relatorios_cge/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM relatorios_cge WHERE id = $1', [req.params.id]);
    if (rows.length === 0)
      return res.status(404).json({ data: null, error: { message: 'Relatório não encontrado' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/relatorios_cge', async (req, res) => {
  try {
    const {
      titulo, periodo, processo, data_corte, contextualizacao,
      analise_grupo1, analise_grupo2, analise_grupo3,
      justificativas, quadro3, conclusao, signatarios,
      estoque_manual, baixas_secretario, status, setorial_id, secoes
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO relatorios_cge
         (titulo, periodo, processo, data_corte, contextualizacao,
          analise_grupo1, analise_grupo2, analise_grupo3,
          justificativas, quadro3, conclusao, signatarios,
          estoque_manual, baixas_secretario, status, setorial_id, secoes,
          criado_em, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
       RETURNING *`,
      [
        titulo, periodo, processo, data_corte, contextualizacao,
        analise_grupo1, analise_grupo2, analise_grupo3,
        toJsonb(justificativas), toJsonb(quadro3), conclusao, toJsonb(signatarios),
        estoque_manual, baixas_secretario, status, setorial_id, toJsonb(secoes)
      ]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Campos que podem ser alterados via PATCH /relatorios_cge/:id
const RELATORIOS_CGE_PATCH_PERMITIDOS = [
  'titulo', 'periodo', 'processo', 'data_corte', 'contextualizacao',
  'analise_grupo1', 'analise_grupo2', 'analise_grupo3',
  'justificativas', 'quadro3', 'conclusao', 'signatarios',
  'estoque_manual', 'baixas_secretario', 'status', 'setorial_id', 'secoes'
];
const RELATORIOS_CGE_CAMPOS_JSONB = ['justificativas', 'quadro3', 'signatarios', 'secoes'];

app.patch('/relatorios_cge/:id', async (req, res) => {
  try {
    const campos = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    RELATORIOS_CGE_PATCH_PERMITIDOS.forEach(c => {
      if (campos[c] !== undefined) {
        sets.push(`${c} = $${i++}`);
        values.push(RELATORIOS_CGE_CAMPOS_JSONB.includes(c) ? toJsonb(campos[c]) : campos[c]);
      }
    });
    if (sets.length === 0)
      return res.status(400).json({ data: null, error: { message: 'nenhum campo permitido informado' } });
    sets.push(`atualizado_em = NOW()`);
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE relatorios_cge SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.delete('/relatorios_cge/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM relatorios_cge WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ data: null, error: { message: 'Relatório não encontrado' } });
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  SGPe — link direto para o processo
// ══════════════════════════════════════
// CACHE PRIMEIRO, SEMPRE. O `nu_processo` interno não sai de conta nenhuma (ver lib/sgpe-link.js)
// e nunca muda depois do processo autuado — então o que já foi resolvido fica em
// `sgpe_processo_ref` e o SGPe só é consultado no que falta.

// Teto por chamada: a tela manda o que está visível, não as 14 mil linhas.
const SGPE_MAXIMO = 400;
// Quantos podem ir ao SGPe numa requisição. O SGPe é recurso de terceiro e caro; o resto fica
// para as próximas chamadas, já que o cache vai enchendo.
const SGPE_MAXIMO_AO_VIVO = 25;

// POST /sgpe/links  body: { processos: ["SCC 8855/2025", ...] }
app.post('/sgpe/links', async (req, res) => {
  try {
    const brutos = Array.isArray(req.body && req.body.processos)
      ? req.body.processos.slice(0, SGPE_MAXIMO)
      : [];

    // Normaliza e joga fora o que não é processo. Uma chave por processo — a mesma lista costuma
    // vir com repetidos (2.704 processos do acervo têm mais de uma PC).
    const porChave = new Map();
    for (const b of brutos) {
      const p = normalizarProcesso(b);
      if (!p || !siglaConhecida(p.sigla)) continue;
      porChave.set(formatarProcesso(p), p);
    }
    if (porChave.size === 0) {
      return res.json({ data: { links: {}, naoEncontrados: [], semSessao: 0, temSessao: temSessaoSgpe() }, error: null });
    }

    // ── 1. cache ──
    // `unnest` de três arrays em vez de 3N placeholders: um lote de 400 viraria 1.200 parâmetros.
    const chaves = [...porChave.values()];
    const cacheadas = await pool.query(
      `SELECT sigla, numero_oficial, ano, nu_processo, cd_orgaosetor
         FROM sgpe_processo_ref
        WHERE (sigla, numero_oficial, ano)
              IN (SELECT * FROM unnest($1::text[], $2::int[], $3::int[]))`,
      [chaves.map(p => p.sigla), chaves.map(p => p.numero), chaves.map(p => p.ano)]
    );

    const links = {};
    // Linha com `nu_processo` NULL é NEGATIVA: o SGPe já respondeu que o processo não existe.
    // Sem separá-la aqui a URL sairia como `processoPK=null,null,ano` — e ela também não pode
    // voltar para a fila do SGPe, que é o motivo de ela existir.
    const negativas = new Set();
    for (const c of cacheadas.rows) {
      const chave = `${c.sigla} ${c.numero_oficial}/${c.ano}`;
      if (c.nu_processo == null) { negativas.add(chave); continue; }
      links[chave] = montarUrlSgpe(c.nu_processo, c.cd_orgaosetor, c.ano);
    }
    const doCache = Object.keys(links).length;

    // ── 2. o que faltou, no SGPe ──
    const faltando = [...porChave.entries()].filter(([chave]) => !links[chave] && !negativas.has(chave));
    // As negativas já sabidas vão junto: a tela guarda e para de perguntar.
    const naoEncontrados = [...negativas];
    let semSessao = 0;

    for (const [chave, p] of faltando.slice(0, SGPE_MAXIMO_AO_VIVO)) {
      try {
        // Sequencial de propósito: nada de disparar dezenas de requisições no SGPe ao mesmo tempo.
        const r = await resolverNoSgpe(p);
        links[chave] = montarUrlSgpe(r.nuProcesso, r.cdOrgaosetor, r.ano);
        await gravarResolvido(pool, p, r);
      } catch (e) {
        // Negativa gravada também aqui, não só no job: sem isso o mesmo processo inexistente
        // é reconsultado a cada sessão nova do navegador, queimando a cota de 25 ao vivo.
        if (e instanceof ProcessoNaoEncontrado) {
          naoEncontrados.push(chave);
          await gravarNegativa(pool, p, e.message);
          continue;
        }
        // Sessão caída derruba a rodada inteira: insistir só geraria erro em série.
        if (e instanceof SessaoExpirada) { semSessao = faltando.length - (Object.keys(links).length - doCache); break; }
        naoEncontrados.push(chave);
      }
    }
    // O que passou do teto por requisição não é erro — volta nas próximas chamadas.
    semSessao += Math.max(0, faltando.length - SGPE_MAXIMO_AO_VIVO);

    res.json({
      data: { links, naoEncontrados, semSessao, temSessao: temSessaoSgpe() },
      count: Object.keys(links).length,
      error: null,
    });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  MIGRAÇÃO — colunas de usuarios (Primeiro Acesso / Perfil)
// ══════════════════════════════════════
async function garantirColunasUsuarios() {
  try {
    await pool.query(`
      ALTER TABLE usuarios
        ADD COLUMN IF NOT EXISTS regiao VARCHAR(80),
        ADD COLUMN IF NOT EXISTS municipio VARCHAR(80),
        ADD COLUMN IF NOT EXISTS telefone VARCHAR(20),
        ADD COLUMN IF NOT EXISTS email VARCHAR(120),
        ADD COLUMN IF NOT EXISTS nucleo VARCHAR(80),
        ADD COLUMN IF NOT EXISTS foto_base64 TEXT,
        ADD COLUMN IF NOT EXISTS aprovado BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS aguardando_aprovacao BOOLEAN DEFAULT false,
        -- Troca obrigatória no primeiro acesso. Nasce FALSE de propósito: ligar a coluna
        -- não pode, sozinha, trancar 50 pessoas na tela de troca de senha. Quem marca quem
        -- precisa trocar é o UPDATE de migracao_senhas.sql, que o Richard autoriza.
        ADD COLUMN IF NOT EXISTS senha_provisoria BOOLEAN NOT NULL DEFAULT false,
        -- Fim de sessão: quem clica em Sair some da lista de online na hora. NULL = nunca
        -- encerrou, que é o estado de quem nunca saiu. Ver GET /usuarios/online.
        ADD COLUMN IF NOT EXISTS sessao_fim TIMESTAMP
    `);
    console.log('Colunas de usuarios (Primeiro Acesso / Perfil / senha provisoria) verificadas.');
  } catch (e) {
    console.error('Erro ao garantir colunas de usuarios:', e.message);
  }
}

// ══════════════════════════════════════
//  MIGRAÇÃO — Controle Interno
// ══════════════════════════════════════
// Rodado à mão em 12/08/2026 com autorização do Richard; fica aqui para o ambiente nascer
// pronto e para o boot reparar o que faltar. Idempotente.
//
// ⚠️ `ci_situacao` fica NULL para quem nunca foi ao CI — a coluna não inventa estado para
// as 14.639 PCs que não têm nada a ver com isso.
async function garantirCi() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ci_mensagem (
        id           SERIAL    PRIMARY KEY,
        codigo_pc    TEXT      NOT NULL,
        rodada       INTEGER   NOT NULL DEFAULT 1,
        direcao      TEXT      NOT NULL,
        texto        TEXT      NOT NULL,
        autor_id     INTEGER,
        autor_nome   TEXT,
        autor_perfil TEXT,
        criado_em    TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT ci_msg_direcao CHECK (direcao IN ('ci_para_analista','analista_para_ci')),
        CONSTRAINT ci_msg_texto   CHECK (length(btrim(texto)) > 0)
      )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ci_msg_pc ON ci_mensagem (codigo_pc, criado_em)`);
    await pool.query(`
      ALTER TABLE prestacoes_contas
        ADD COLUMN IF NOT EXISTS ci_situacao      TEXT,
        ADD COLUMN IF NOT EXISTS ci_rodada        INTEGER   NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ci_encerrado_em  TIMESTAMP,
        ADD COLUMN IF NOT EXISTS ci_encerrado_por INTEGER`);
    // Rede: PC encaminhada antes desta versão entraria na fila sem situação e sumiria da tela.
    await pool.query(`
      UPDATE prestacoes_contas SET ci_situacao = 'na_fila', ci_rodada = 1
       WHERE enviado_ci = true AND ci_situacao IS NULL`);
    console.log('Controle Interno (ci_mensagem + colunas do ciclo) verificado.');
  } catch (e) {
    console.error('Erro ao garantir Controle Interno:', e.message);
  }
}

// ══════════════════════════════════════
//  MIGRAÇÃO — configuração do sistema (modo preparação)
// ══════════════════════════════════════
// Tabela NOVA, então `CREATE TABLE IF NOT EXISTS` basta (a armadilha 2 do CLAUDE.md só vale
// para tabela que já existe). Nasce com o modo DESLIGADO: criar a tabela não pode, sozinha,
// trancar a equipe fora do sistema.
async function garantirTabelaConfigSistema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS config_sistema (
        id                  INTEGER PRIMARY KEY DEFAULT 1,
        modo_preparacao     BOOLEAN   NOT NULL DEFAULT false,
        mensagem            TEXT,
        atualizado_por      INTEGER,
        atualizado_por_nome TEXT,
        atualizado_em       TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT config_sistema_linha_unica CHECK (id = 1)
      )`);
    // ⚠️ O CREATE TABLE acima NÃO altera tabela que já existe (armadilha 2 do CLAUDE.md).
    // A config_sistema nasceu em 12/08 sem as colunas de manutenção, então elas precisam
    // vir por ALTER — senão o modo só funcionaria em banco novo.
    // Nascem DESLIGADAS: publicar isto não tranca ninguém.
    await pool.query(`
      ALTER TABLE config_sistema
        ADD COLUMN IF NOT EXISTS modo_manutencao     BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS mensagem_manutencao TEXT`);
    // A linha 1 é o registro. Sem ela o PATCH não teria o que atualizar e a tela ficaria
    // ligando um interruptor que não existe.
    await pool.query(`INSERT INTO config_sistema (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    console.log('Tabela config_sistema (modos preparacao e manutencao) verificada.');
  } catch (e) {
    console.error('Erro ao garantir config_sistema:', e.message);
  }
}

// ══════════════════════════════════════
//  MIGRAÇÃO — preferências do painel por analista
// ══════════════════════════════════════
// Guarda, por analista e por TR, o que é escolha DELE e não do dado: se a TR está fixada no
// topo e se o painel dela fica aberto. Duas colunas em vez de duas tabelas porque a chave é
// a mesma — e porque quase toda linha vai ter as duas.
//
// Tabela NOVA, então `CREATE TABLE IF NOT EXISTS` basta (a armadilha 2 do CLAUDE.md só vale
// para tabela que já existe).
async function garantirTabelaPreferenciaTr() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS preferencia_tr (
        analista_id   INTEGER      NOT NULL,
        tr            VARCHAR(20)  NOT NULL,
        fixada        BOOLEAN      NOT NULL DEFAULT false,
        expandida     BOOLEAN      NOT NULL DEFAULT false,
        atualizado_em TIMESTAMP    NOT NULL DEFAULT NOW(),
        PRIMARY KEY (analista_id, tr)
      )
    `);
    console.log('Tabela preferencia_tr (alfinete e painel aberto) verificada.');
  } catch (e) {
    console.error('Erro ao garantir tabela preferencia_tr:', e.message);
  }
}

// GET /preferencia_tr?analista_id=X — tudo que o analista fixou ou deixou aberto
app.get('/preferencia_tr', async (req, res) => {
  try {
    const { analista_id } = req.query;
    if (!analista_id)
      return res.status(400).json({ data: null, error: { message: 'analista_id é obrigatório' } });
    const { rows } = await pool.query(
      `SELECT tr, fixada, expandida FROM preferencia_tr WHERE analista_id = $1`,
      [parseInt(analista_id)]
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    // Tabela ainda não criada não pode derrubar a tela: sem preferência, tudo recolhido.
    res.json({ data: [], count: 0, error: null });
  }
});

// PATCH /preferencia_tr  body { analista_id, tr, fixada?, expandida? }
// Manda só o que mudou — o campo omitido fica como estava.
app.patch('/preferencia_tr', async (req, res) => {
  try {
    const { analista_id, tr, fixada, expandida } = req.body || {};
    if (!analista_id || !tr)
      return res.status(400).json({ data: null, error: { message: 'analista_id e tr são obrigatórios' } });

    const { rows } = await pool.query(
      `INSERT INTO preferencia_tr (analista_id, tr, fixada, expandida, atualizado_em)
       VALUES ($1, $2, COALESCE($3, false), COALESCE($4, false), NOW())
       ON CONFLICT (analista_id, tr) DO UPDATE
          SET fixada        = COALESCE($3, preferencia_tr.fixada),
              expandida     = COALESCE($4, preferencia_tr.expandida),
              atualizado_em = NOW()
       RETURNING tr, fixada, expandida`,
      [parseInt(analista_id), tr,
       fixada === undefined ? null : !!fixada,
       expandida === undefined ? null : !!expandida]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// ══════════════════════════════════════
//  MIGRAÇÃO — cache de links do SGPe
// ══════════════════════════════════════
// Tabela NOVA, então CREATE TABLE IF NOT EXISTS basta (a armadilha do CLAUDE.md só vale para
// tabela que já existe). Sem TTL de propósito: o `nu_processo` não muda depois do processo
// autuado, então o que foi resolvido uma vez vale para sempre.
//
// `origem`: 'SGPE' = resolvido ao vivo pelo endpoint DWR · 'CONFERIDO' = par verificado à mão
// · 'NAO_ENCONTRADO' = o SGPe respondeu que o processo não existe · 'ERRO' = falha de rede,
// estado provisório que volta para a fila do job depois de um recuo.
async function garantirTabelaSgpe() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sgpe_processo_ref (
        sigla          TEXT      NOT NULL,
        numero_oficial INTEGER   NOT NULL,
        ano            INTEGER   NOT NULL,
        nu_processo    INTEGER   NOT NULL,
        cd_orgaosetor  INTEGER   NOT NULL,
        origem         TEXT      NOT NULL DEFAULT 'SGPE',
        criado_em      TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (sigla, numero_oficial, ano)
      )
    `);
    // A tabela agora EXISTE em produção (388 linhas em 08/08/2026), então o CREATE acima não
    // alcança mais coluna nenhuma — armadilha 2 do CLAUDE.md. O que muda vem por ALTER.
    //
    // `nu_processo`/`cd_orgaosetor` passam a aceitar NULL: é o que distingue a linha de
    // NEGATIVA (processo que o SGPe não tem) da linha resolvida. Toda leitura filtra por
    // `nu_processo IS NOT NULL` — ver lib/sgpe-lote.js.
    await pool.query(`
      ALTER TABLE sgpe_processo_ref
        ALTER COLUMN nu_processo   DROP NOT NULL,
        ALTER COLUMN cd_orgaosetor DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS tentativas       INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ultima_tentativa TIMESTAMP,
        ADD COLUMN IF NOT EXISTS motivo           TEXT
    `);
    console.log('Tabela sgpe_processo_ref (cache de links do SGPe) verificada.');
  } catch (e) {
    console.error('Erro ao garantir tabela sgpe_processo_ref:', e.message);
  }
}

// ══════════════════════════════════════
//  START
// ══════════════════════════════════════
const PORT = process.env.PORT || 3000;
garantirColunasUsuarios()
  .then(garantirTabelaConfigSistema)
  .then(garantirCi)
  .then(garantirTabelaSgpe)
  .then(garantirTabelaPreferenciaTr)
  .then(verificarColunaInicioAnalise)
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`SIGPC-GT API rodando na porta ${PORT}`);
    });
  });
