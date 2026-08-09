const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const {
  normalizarProcesso, formatarProcesso, siglaConhecida, montarUrlSgpe,
  ProcessoNaoEncontrado, SessaoExpirada,
} = require('./lib/sgpe-link');
const { resolverNoSgpe, temSessaoSgpe } = require('./lib/sgpe-dwr');
const { linksDeLinhas, gravarResolvido, gravarNegativa } = require('./lib/sgpe-lote');

const { semAcento, condicaoBusca } = require('./lib/busca');

const app = express();
app.use(cors());
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
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.get('/usuarios/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [req.params.id]);
    res.json({ data: rows, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

app.post('/usuarios', async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO usuarios (nome, cpf, senha_hash, perfil, setorial_id, grupo, ativo,
                             matricula, portaria, data_ingresso, data_saida, meta_mensal, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *`,
      [b.nome, b.cpf, b.senha_hash, b.perfil, b.setorial_id, b.grupo ?? null, b.ativo ?? true,
       b.matricula ?? null, b.portaria ?? null, b.data_ingresso ?? null, b.data_saida ?? null, b.meta_mensal ?? 10]
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// Campos que podem ser alterados via PATCH /usuarios/:id
const USUARIOS_PATCH_PERMITIDOS = [
  'nome', 'cpf', 'perfil', 'setorial_id', 'grupo', 'ativo', 'senha_hash', 'ultimo_acesso',
  'regiao', 'municipio', 'telefone', 'email', 'nucleo', 'foto_base64', 'aprovado', 'aguardando_aprovacao',
  'matricula', 'portaria', 'data_ingresso', 'data_saida', 'meta_mensal'
];

app.patch('/usuarios/:id', async (req, res) => {
  try {
    const b = req.body;
    const sets = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(b)) {
      if (!USUARIOS_PATCH_PERMITIDOS.includes(k)) continue;
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
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// DELETE /usuarios/:id — só exclui se não houver PC vinculada (analista_id) em prestacoes_contas
// body { perfil } — só superadmin pode excluir
app.delete('/usuarios/:id', async (req, res) => {
  try {
    const { perfil } = req.body || {};
    if (perfil !== 'superadmin')
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

    // Compara só os dígitos do CPF — planilha e formulário podem formatar diferente
    const existente = await pool.query(
      `SELECT id, senha_hash, ativo, aprovado, aguardando_aprovacao
       FROM usuarios
       WHERE regexp_replace(cpf, '[^0-9]', '', 'g') = regexp_replace($1, '[^0-9]', '', 'g')`,
      [cpf]
    );

    if (existente.rows.length > 0) {
      const u = existente.rows[0];

      // Já tem cadastro completo e ativo — não recadastra, manda usar o login normal
      if (u.senha_hash && u.aprovado && u.ativo) {
        return res.status(409).json({ data: null, error: { message: 'Este CPF já possui cadastro ativo. Use o login normal para acessar o sistema.' } });
      }

      // Registro já existe (ex.: analista pré-cadastrado com PCs vinculadas) — atualiza só dados
      // de contato/senha e reabre para aprovação. NÃO mexe em nome, grupo, perfil nem analista_id,
      // que são o que liga o registro às PCs em prestacoes_contas.
      const { rows } = await pool.query(
        `UPDATE usuarios
           SET email = $1, telefone = $2, regiao = $3, municipio = $4, nucleo = $5,
               senha_hash = $6, aguardando_aprovacao = true, ativo = false, aprovado = false
         WHERE id = $7
         RETURNING id, nome, cpf`,
        [email || null, telefone || null, regiao || null, municipio || null, nucleo || null, senha_hash, u.id]
      );
      return res.json({
        data: rows[0],
        error: null,
        message: 'Cadastro atualizado! Aguarde a aprovação do seu coordenador para acessar o sistema.'
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO usuarios
         (nome, cpf, email, telefone, regiao, municipio, nucleo, senha_hash, setorial_id,
          perfil, ativo, aprovado, aguardando_aprovacao, grupo, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'analista',false,false,true,NULL,NOW())
       RETURNING id, nome, cpf`,
      [nome, cpf, email || null, telefone || null, regiao || null, municipio || null, nucleo || null, senha_hash, setorial_id]
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

// PATCH /usuarios/:id/aprovar — body opcional { grupo }
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
    res.json({ data: rows[0], error: null });
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
    const { perfil } = req.body || {};
    if (perfil !== 'superadmin' && perfil !== 'coordenador')
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
// (dias = CURRENT_DATE - dt_limite_pc: positivo = vencida, negativo = a vencer)
app.get('/prestacoes_contas/alertas_prazo', async (req, res) => {
  try {
    const { analista_id, setorial_id } = req.query;
    if (!analista_id)
      return res.status(400).json({ data: null, error: { message: 'analista_id é obrigatório' } });
    const conditions = [`analista_id = $1`, `status <> 'baixada'`, `dt_limite_pc IS NOT NULL`, `(CURRENT_DATE - dt_limite_pc) >= -30`];
    const values = [parseInt(analista_id)];
    let i = 2;
    if (setorial_id) { conditions.push(`setorial_id = $${i++}`); values.push(setorial_id); }
    const { rows } = await pool.query(
      `SELECT tr, entidade, codigo_pc, processo_pc, dt_limite_pc,
              (CURRENT_DATE - dt_limite_pc) AS dias
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

// PATCH /prestacoes_contas/baixar — body { codigos_pc: [], parecer_tipo, analista_id, registrado_por, override }
app.patch('/prestacoes_contas/baixar', async (req, res) => {
  try {
    const { codigos_pc, parecer_tipo, analista_id, registrado_por, override } = req.body;
    if (!Array.isArray(codigos_pc) || codigos_pc.length === 0)
      return res.status(400).json({ data: null, error: { message: 'codigos_pc é obrigatório' } });
    const params = [parecer_tipo, registrado_por, codigos_pc];
    let where = 'codigo_pc = ANY($3)';
    if (override !== true) {
      params.push(analista_id);
      where += ' AND analista_id = $4';
    }
    const { rows } = await pool.query(
      `UPDATE prestacoes_contas
       SET baixada = true, data_baixa = NOW(), origem_baixa = 'sistema', status = 'baixada',
           parecer_tipo = $1, registrado_por = $2, atualizado_em = NOW()
       WHERE ${where}
       RETURNING codigo_pc`,
      params
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /prestacoes_contas/estornar — body { codigos_pc: [], motivo, usuario_id, usuario_nome, perfil, grupo }
app.patch('/prestacoes_contas/estornar', async (req, res) => {
  try {
    const { codigos_pc, motivo, usuario_id, usuario_nome, perfil, grupo } = req.body;
    if (!Array.isArray(codigos_pc) || codigos_pc.length === 0)
      return res.status(400).json({ data: null, error: { message: 'codigos_pc é obrigatório' } });
    if (!motivo || motivo.trim().length < 15)
      return res.status(400).json({ data: null, error: { message: 'motivo deve ter no mínimo 15 caracteres' } });

    const params = [motivo, usuario_nome, codigos_pc];
    let where = 'codigo_pc = ANY($3)';
    if (perfil === 'analista') {
      params.push(usuario_id);
      where += ` AND analista_id = $${params.length}`;
    } else if (perfil === 'coordenador') {
      params.push(parseInt(grupo));
      where += ` AND grupo = $${params.length}`;
    } else if (perfil !== 'superadmin') {
      return res.status(403).json({ data: null, error: { message: 'perfil não autorizado a estornar' } });
    }

    const { rows } = await pool.query(
      `UPDATE prestacoes_contas
       SET estornada = true, data_estorno = NOW(), status = 'analise', baixada = false,
           motivo_estorno = $1, estornado_por = $2, atualizado_em = NOW()
       WHERE ${where}
       RETURNING codigo_pc`,
      params
    );
    res.json({ data: rows, count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// PATCH /prestacoes_contas/:codigo_pc — atualização pontual (ex: assumir TR)
// precisa vir depois de /baixar e /estornar, senão "baixar"/"estornar" seriam capturados como codigo_pc
app.patch('/prestacoes_contas/:codigo_pc', async (req, res) => {
  try {
    const campos = req.body;
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
    sets.push(`atualizado_em = NOW()`);
    values.push(req.params.codigo_pc);
    const { rows } = await pool.query(
      `UPDATE prestacoes_contas SET ${sets.join(', ')} WHERE codigo_pc = $${i} RETURNING *`,
      values
    );
    res.json({ data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
});

// POST /prestacoes_contas/registrar_parecer — body { codigo_pc, parecer_tipo, analista_nome, analista_id, baixar_nl_completa }
app.post('/prestacoes_contas/registrar_parecer', async (req, res) => {
  try {
    const { codigo_pc, parecer_tipo, analista_nome, baixar_nl_completa } = req.body;
    if (!codigo_pc)
      return res.status(400).json({ data: null, error: { message: 'codigo_pc é obrigatório' } });

    const pcRes = await pool.query('SELECT codigo_nl FROM prestacoes_contas WHERE codigo_pc = $1', [codigo_pc]);
    if (pcRes.rows.length === 0)
      return res.status(404).json({ data: null, error: { message: 'PC não encontrada' } });
    const { codigo_nl } = pcRes.rows[0];

    const params = [parecer_tipo, analista_nome];
    let where;
    if (baixar_nl_completa === true && codigo_nl) {
      params.push(codigo_nl);
      where = `codigo_nl = $3 AND status != 'baixada'`;
    } else {
      params.push(codigo_pc);
      where = `codigo_pc = $3`;
    }

    const { rows } = await pool.query(
      `UPDATE prestacoes_contas
       SET baixada = true, status = 'baixada', parecer_tipo = $1,
           data_baixa = NOW(), origem_baixa = 'sistema', registrado_por = $2,
           atualizado_em = NOW()
       WHERE ${where}
       RETURNING codigo_pc`,
      params
    );
    res.json({ data: rows.map(r => r.codigo_pc), count: rows.length, error: null });
  } catch (e) {
    res.status(500).json({ data: null, error: { message: e.message } });
  }
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

function registrarHistorico(cli, h) {
  return cli.query(
    `INSERT INTO parcela_historico
       (tr, parcial_num, setorial_id, evento, valor_anterior, valor_novo, analista_id, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [h.tr, h.parcial_num, h.setorial_id, h.evento,
     h.valor_anterior ?? null, h.valor_novo ?? null, h.analista_id ?? null, h.observacao ?? null]
  );
}

// Carrega as PCs da parcial com lock, para a transacao ser toda-ou-nenhuma.
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
              situacao_atual = NULL,
              estornada = false,
              data_estorno = NULL,
              atualizado_em = NOW()
        WHERE setorial_id = $4 AND tr = $5 AND parcial_num = $6
        RETURNING codigo_pc`,
      [b.parecer_tipo, b.analista_id ?? null, b.registrado_por ?? null,
       setorial_id, b.tr, String(b.parcial_num)]
    );

    await registrarHistorico(cli, {
      tr: b.tr, parcial_num: String(b.parcial_num), setorial_id,
      evento: 'parecer',
      valor_anterior: pcs[0].situacao_atual || pcs[0].status || null,
      valor_novo: b.parecer_tipo,
      analista_id: b.analista_id ?? null,
      observacao: b.observacao ?? null
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

// POST /parcela/situacao — body { tr, parcial_num, situacao, prazo_diligencia?, qtd_diligencias?, observacao?, analista_id?, setorial_id? }
// Acompanhamento: NAO baixa, nao mexe em baixada/data_baixa. Pode ir e voltar quantas vezes precisar.
app.post('/parcela/situacao', async (req, res) => {
  const b = req.body || {};
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
      observacao: b.observacao ?? null
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
  const erro = faltaChave(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
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
              atualizado_em = NOW()
        WHERE setorial_id = $2 AND tr = $3 AND parcial_num = $4
        RETURNING codigo_pc`,
      [b.parecer_ci ?? null, setorial_id, b.tr, String(b.parcial_num)]
    );

    await registrarHistorico(cli, {
      tr: b.tr, parcial_num: String(b.parcial_num), setorial_id,
      evento: 'ci',
      valor_anterior: pcs.find(p => p.parecer_tipo)?.parecer_tipo || null,
      valor_novo: 'enviado_ci = true',
      analista_id: b.analista_id ?? null,
      observacao: b.observacao ?? null
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

// POST /parcela/estornar — body { tr, parcial_num, motivo, usuario_id, usuario_nome, perfil, setorial_id? }
// So coordenador/superadmin. Desfaz a parcial inteira.
app.post('/parcela/estornar', async (req, res) => {
  const b = req.body || {};
  const erro = faltaChave(b);
  if (erro) return res.status(400).json({ data: null, error: { message: erro } });
  if (b.perfil !== 'coordenador' && b.perfil !== 'superadmin')
    return res.status(403).json({ data: null, error: { message: 'Apenas coordenador ou superadmin podem estornar' } });
  if (!b.motivo || b.motivo.trim().length < 15)
    return res.status(400).json({ data: null, error: { message: 'motivo deve ter no mínimo 15 caracteres' } });

  const setorial_id = b.setorial_id || 'FCEE';
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
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
              atualizado_em = NOW()
        WHERE setorial_id = $3 AND tr = $4 AND parcial_num = $5
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
        ADD COLUMN IF NOT EXISTS aguardando_aprovacao BOOLEAN DEFAULT false
    `);
    console.log('Colunas de usuarios (Primeiro Acesso / Perfil) verificadas.');
  } catch (e) {
    console.error('Erro ao garantir colunas de usuarios:', e.message);
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
  .then(garantirTabelaSgpe)
  .then(garantirTabelaPreferenciaTr)
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`SIGPC-GT API rodando na porta ${PORT}`);
    });
  });
