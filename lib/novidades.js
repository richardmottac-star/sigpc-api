// CAMINHO: sigpc-api/lib/novidades.js
//
// NOVIDADES DO SISTEMA — o que mudou, para quem, e até onde cada um já viu.  (25/08/2026)
//
// ─────────────────────────────────────────────────────────────────────────────
// O PROBLEMA
//
// Cada mudança do sistema virava mensagem de WhatsApp e PDF por e-mail. Quem não leu a
// mensagem não ficava sabendo, e quem entra depois nunca vê — o histórico morava fora do
// sistema, num lugar que não pertence a ninguém.
// ─────────────────────────────────────────────────────────────────────────────

const papel = require('./papel');

// ⚠️ A CATEGORIA DEFINE O ÍCONE E A COR, e a lista mora AQUI, no servidor. A tela só desenha
// o que veio: se cada lado tivesse a sua tabela de cores, publicar uma categoria nova exigiria
// mexer nos dois repositórios e um deles ia ficar para trás.
const CATEGORIAS = {
  tela_nova: { rotulo: 'Tela nova',        bg: '#EEEDFE', cor: '#3C3489' },
  melhoria:  { rotulo: 'Melhoria',         bg: '#E6F1FB', cor: '#185FA5' },
  correcao:  { rotulo: 'Correção',         bg: '#EAF3DE', cor: '#27500A' },
  regra:     { rotulo: 'Regra de negócio', bg: '#FAEEDA', cor: '#854F0B' },
  aviso:     { rotulo: 'Aviso',            bg: '#FCEBEB', cor: '#A32D2D' },
};

const PUBLICOS = {
  todos:            'Todos',
  analistas:        'Para analistas',
  controle_interno: 'Controle Interno',
  coordenacao:      'Coordenação',
};

/**
 * O público de uma pessoa — qual recorte ela enxerga além do `todos`.
 *
 * ⚠️ SAI DO PERFIL EFETIVO, a regra única das rotas desde 14/08. No papel analista o
 * superadmin é analista aqui também: ele vê a tela como a equipe vê, que é para isso que o
 * papel existe.
 */
function publicoDe(u) {
  const p = papel.perfilEfetivo(u);
  if (p === 'controle_interno') return 'controle_interno';
  if (p === 'coordenador') return 'coordenacao';
  return 'analistas';
}

/**
 * Esta pessoa vê esta novidade?
 *
 * ⚠️ O SUPERADMIN VÊ TODAS — é ele quem publica, e publicar sem conseguir reler o que
 * publicou seria escrever no escuro. No papel analista ele deixa de ser superadmin aqui
 * (`perfilEfetivo`) e passa a ver o mesmo que a equipe.
 */
function visivelPara(u, n) {
  if (!u || !n) return false;
  if (papel.perfilEfetivo(u) === 'superadmin') return true;
  return n.publico === 'todos' || n.publico === publicoDe(u);
}

/** Só o superadmin publica, edita e exclui. Conferido contra o perfil lido do BANCO. */
function podePublicar(u) {
  return !!u && papel.perfilEfetivo(u) === 'superadmin';
}

// ── O link do Google Drive ───────────────────────────────────────────────────
//
// ⚠️ O QUE SE COMPARTILHA COM O REPOSITÓRIO É A EXTRAÇÃO DO ID, E NÃO A URL FINAL.
//
// O `repoDriveEmbed` do index.html devolve `/preview`, que é o endereço de EMBUTIR num
// iframe — certo para PDF e documento. Uma `<img src="…/preview">` não desenha imagem
// nenhuma: `/preview` devolve uma PÁGINA HTML com o visualizador dentro, não os bytes do
// arquivo. São dois endereços diferentes para o mesmo arquivo, e o que varia é o consumidor.
//
// Por isso aqui se extrai o ID pelas MESMAS quatro formas de link que o Repositório aceita, e
// só a montagem final difere.

/** O id do arquivo, nas quatro formas de link que o Drive entrega. */
function driveId(url) {
  const u = String(url || '');
  let m;
  if ((m = u.match(/drive\.google\.com\/file\/d\/([^/?#]+)/i))) return m[1];
  if ((m = u.match(/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([^/?#]+)/i))) return m[1];
  if ((m = u.match(/drive\.google\.com\/drive\/folders\/([^/?#]+)/i))) return m[1];
  if (/drive\.google\.com|docs\.google\.com/i.test(u) && (m = u.match(/[?&]id=([^&#]+)/i))) return m[1];
  return null;
}

/**
 * O endereço que uma `<img>` consegue desenhar.
 *
 * ⚠️ `thumbnail?id=…&sz=w1600` E NÃO `uc?export=view`. O `uc?export=view` foi o caminho
 * clássico e passou a redirecionar para uma página de aviso de antivírus em arquivos acima de
 * poucos MB — e o navegador desenha esse HTML como imagem quebrada, sem erro que dê para
 * tratar. O `thumbnail` devolve os bytes, respeita o compartilhamento do arquivo e aceita a
 * largura pedida; é o mesmo que a função IMAGE() do Google Planilhas usa.
 *
 * ⚠️ E ISTO NÃO CONTORNA PERMISSÃO: arquivo restrito continua restrito. O link tem de estar
 * compartilhado como "qualquer pessoa com o link", igual ao que o Repositório já exige.
 *
 * Link que não é do Drive volta INTACTO — quem colar um endereço de imagem comum continua
 * funcionando, e não é papel desta função recusar o que o navegador aceita.
 */
function imagemDireta(url) {
  const id = driveId(url);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1600` : (url || null);
}

const TITULO_MAX = 160;
const TEXTO_MAX = 4000;

/** O que a tela mandou serve? Devolve a mensagem de erro, ou null. */
function validar(b) {
  if (!b) return 'Nada informado.';
  const t = String(b.titulo ?? '').trim();
  const x = String(b.texto ?? '').trim();
  if (!t) return 'O título é obrigatório.';
  if (t.length > TITULO_MAX) return `O título passa de ${TITULO_MAX} caracteres.`;
  if (!x) return 'O texto é obrigatório.';
  if (x.length > TEXTO_MAX) return `O texto passa de ${TEXTO_MAX} caracteres.`;
  if (b.categoria && !CATEGORIAS[b.categoria]) return 'Categoria inválida.';
  if (b.publico && !PUBLICOS[b.publico]) return 'Público inválido.';
  // ⚠️ A data é OPCIONAL e cai em hoje. Quando vem, vem no formato do `<input type="date">`;
  // qualquer outra coisa é recusada aqui em vez de virar `NULL` silencioso no banco.
  if (b.data && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.data))) return 'Data inválida.';
  return null;
}

/**
 * A lista que uma pessoa vê, já com o "novo para você" resolvido.
 *
 * ⚠️ "NÃO LIDA" É `criado_em > novidades_visto_em`, e NUNCA `data > visto_em`. A `data` é
 * editorial: o formulário deixa o superadmin datar a novidade para trás, e ela serve para
 * agrupar a lista. Se a conta usasse ela, publicar hoje algo datado de semana passada
 * nasceria JÁ LIDO para todo mundo — e ninguém veria justamente o que se quis contar.
 *
 * ⚠️ `visto_em` NULO significa "nunca abriu a tela", e aí TUDO é novo. É a resposta ao "quem
 * entra depois nunca vê": o cadastro novo encontra o histórico inteiro esperando por ele.
 */
function marcarNovas(linhas, vistoEm) {
  const corte = vistoEm ? new Date(vistoEm).getTime() : null;
  return (linhas || []).map(n => ({
    ...n,
    nova: corte === null ? true : new Date(n.criado_em).getTime() > corte,
  }));
}

/** Os contadores dos chips, sobre a lista que a pessoa JÁ pode ver. */
function contar(linhas) {
  const c = { tudo: linhas.length, novas: linhas.filter(n => n.nova).length };
  Object.keys(PUBLICOS).forEach(p => {
    if (p !== 'todos') c[p] = linhas.filter(n => n.publico === p).length;
  });
  c.todos = linhas.filter(n => n.publico === 'todos').length;
  return c;
}

const SQL_LISTAR = `
  SELECT id, titulo, texto, categoria, publico, imagem_url, imagem_legenda, guia_url,
         data, criado_em, criado_por, criado_por_nome, atualizado_em
    FROM novidade
   ORDER BY data DESC, id DESC`;

const SQL_INSERIR = `
  INSERT INTO novidade (titulo, texto, categoria, publico, imagem_url, imagem_legenda,
                        guia_url, data, criado_por, criado_por_nome)
  VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE),$9,$10)
  RETURNING *`;

const SQL_ATUALIZAR = `
  UPDATE novidade
     SET titulo = $2, texto = $3, categoria = $4, publico = $5, imagem_url = $6,
         imagem_legenda = $7, guia_url = $8, data = COALESCE($9::date, data),
         atualizado_em = NOW()
   WHERE id = $1
  RETURNING *`;

// ⚠️ `NOW()` e não uma data vinda da tela: quem carimba "vi até aqui" é o servidor. Com a
// data do cliente, um relógio adiantado marcaria como visto o que ainda vai ser publicado.
const SQL_MARCAR_VISTO = `UPDATE usuarios SET novidades_visto_em = NOW() WHERE id = $1 RETURNING novidades_visto_em`;

module.exports = {
  CATEGORIAS, PUBLICOS, TITULO_MAX, TEXTO_MAX,
  publicoDe, visivelPara, podePublicar, driveId, imagemDireta, validar, marcarNovas, contar,
  SQL_LISTAR, SQL_INSERIR, SQL_ATUALIZAR, SQL_MARCAR_VISTO,
};
