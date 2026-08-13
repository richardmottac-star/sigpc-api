// CAMINHO: sigpc-api/teste_processo_edit.js
//
// CORRIGIR O PROCESSO SGPe — validação, leitura do link colado e as travas.
// Sem rede e sem banco. A seção 4 lê server.js e job/lote: transação, ordem e a trava do MANUAL.

const fs = require('fs');
const pe = require('./lib/processo-edit');

let ok = 0, falhou = 0;
const conf = (c, n) => { c ? (ok++, console.log('  OK    ' + n)) : (falhou++, console.log('  FALHA  ' + n)); };
const secao = t => console.log('\n═══ ' + t + ' ═══');

const base = { codigo_pc: '2020PC001540', usuario_id: 36, campo: 'processo_pc', sigla: 'SCC', numero: 8855, ano: 2025 };

// ─────────────────────────────────────────────────────────────
secao('1. VALIDACAO');
conf(pe.validar(base) === null, 'corpo bom passa');
conf(pe.validar(null) !== null, 'corpo vazio recusado');
conf(pe.validar({ ...base, codigo_pc: null }) !== null, 'sem codigo_pc recusa');
conf(pe.validar({ ...base, usuario_id: null }) !== null, 'sem usuario_id recusa');
conf(pe.validar({ ...base, campo: 'valor' }) !== null, 'campo fora da lista recusa');
conf(pe.validar({ ...base, campo: 'processo_mae' }) === null, 'processo_mae e editavel');
conf(pe.validar({ ...base, sigla: '' }) !== null, 'sem sigla recusa');
conf(pe.validar({ ...base, sigla: 'S' }) !== null, 'sigla de 1 letra recusa');
conf(pe.validar({ ...base, sigla: 'ADR26' }) === null, 'sigla com regional passa');
conf(pe.validar({ ...base, sigla: 'SCC!' }) !== null, 'sigla com simbolo recusa');
conf(pe.validar({ ...base, numero: 0 }) !== null, 'numero zero recusa');
conf(pe.validar({ ...base, numero: 'abc' }) !== null, 'numero nao numerico recusa');
conf(pe.validar({ ...base, ano: 1999 }) !== null, 'ano antigo demais recusa');
conf(pe.validar({ ...base, ano: 2031 }) !== null, 'ano futuro demais recusa');
conf(pe.validar({ ...base, ano: 2017 }) === null, 'ano de 2017 passa');

secao('2. O TEXTO MONTADO');
conf(pe.montar(base) === 'SCC 8855/2025', 'monta no formato do sistema');
conf(pe.montar({ sigla: ' scc ', numero: '0008855', ano: '2025' }) === 'SCC 8855/2025',
     'normaliza: maiuscula, sem espaco, sem zero a esquerda');
conf(pe.montar({ sigla: 'adr26', numero: 1701, ano: 2017 }) === 'ADR26 1701/2017', 'idem com regional');

// ─────────────────────────────────────────────────────────────
secao('3. O LINK COLADO');
const URL_OK = 'https://sgpe.sea.sc.gov.br/cpav/visualizarDocumentosProcesso.do?processoPK=137111,7059,2025&itemAba=aba_pecas';
{
  const r = pe.lerLink(URL_OK);
  conf(!r.erro, 'link do SGPe e aceito');
  conf(r.nu_processo === 137111 && r.cd_orgaosetor === 7059 && r.ano === 2025,
       'e os tres numeros saem do processoPK');
}
conf(!!pe.lerLink('').erro, 'vazio recusa');
conf(!!pe.lerLink('nao e url').erro, 'texto solto recusa');
// ⚠️ O HOST E CONFERIDO: sem isso qualquer endereco com processoPK entraria no cache e
// viraria um link que a equipe clicaria confiando no sistema.
conf(!!pe.lerLink('https://exemplo.com/x?processoPK=1,2,2025').erro, 'OUTRO HOST recusa');
conf(/SGPe/.test(pe.lerLink('https://exemplo.com/x?processoPK=1,2,2025').erro), 'e diz que precisa ser do SGPe');
conf(!!pe.lerLink('https://sgpe.sea.sc.gov.br/cpav/x.do').erro, 'sem processoPK recusa');
conf(!!pe.lerLink('https://sgpe.sea.sc.gov.br/cpav/x.do?processoPK=1,2').erro, 'processoPK com 2 numeros recusa');
conf(!!pe.lerLink('https://sgpe.sea.sc.gov.br/cpav/x.do?processoPK=1,2,3,4').erro, 'com 4 numeros recusa');
conf(!!pe.lerLink('https://sgpe.sea.sc.gov.br/cpav/x.do?processoPK=0,7059,2025').erro, 'numero zero recusa');
conf(!!pe.lerLink('https://sgpe.sea.sc.gov.br/cpav/x.do?processoPK=1,2,1998').erro, 'ano implausivel recusa');
conf(!pe.lerLink('http://sgpe.sea.sc.gov.br/cpav/x.do?processoPK=1,2,2025').erro, 'http tambem serve');

// ─────────────────────────────────────────────────────────────
secao('4. TRAVAS NO SERVIDOR');
const src = fs.readFileSync('./server.js', 'utf8');
const rota = src.slice(src.indexOf("app.patch('/prestacoes_contas/:codigo_pc/processo'"),
                       src.indexOf("app.patch('/prestacoes_contas/:codigo_pc/processo'") + 5200);

conf(/quemEdita/.test(rota), 'confere quem edita');
conf(/PERFIS_EDITAM_PROCESSO = \['analista', 'coordenador', 'superadmin'\]/.test(src),
     'analista, coordenador e superadmin — como o Richard pediu');
conf(/SELECT id, nome, perfil FROM usuarios WHERE id = \$1/.test(
       src.slice(src.indexOf('async function quemEdita'), src.indexOf('async function quemEdita') + 300)),
     'e o perfil vem do BANCO, nao do corpo');
conf(/barrouPreparacao/.test(rota), 'e respeita preparacao/manutencao');
conf(/BEGIN/.test(rota) && /COMMIT/.test(rota) && /ROLLBACK/.test(rota), 'a escrita e transacional');

// ⚠️ A ORDEM: automatico PRIMEIRO, manual DEPOIS.
const resolver = src.slice(src.indexOf('async function resolverProcesso'),
                           src.indexOf('async function resolverProcesso') + 1800);
conf(resolver.indexOf('siglaConhecida') < resolver.indexOf('sgpe_processo_ref'), 'primeiro o mapa de orgaos');
conf(resolver.indexOf('sgpe_processo_ref') < resolver.indexOf('resolverNoSgpe'), 'depois o cache');
conf(/resolverNoSgpe/.test(resolver), 'e so entao o SGPe ao vivo');
// a correcao do dado nao pode depender do SGPe estar no ar
// ⚠️ Ancorar no PRIMEIRO `resolverProcesso(novo)` daria falso negativo: ha um atalho antes
// da transacao, para quando o texto nao mudou. O que se quer provar e' que EXISTE uma
// chamada depois do COMMIT — a que devolve o link para a tela.
conf(/await cli\.query\('COMMIT'\);[\s\S]{0,400}?resolverProcesso\(novo\)/.test(rota),
     'o link e buscado DEPOIS do COMMIT — o texto salva mesmo com o SGPe fora');

// fusao de parcela
conf(/409/.test(rota) && /fusao/.test(rota), 'fusao de parcela devolve 409 com aviso');
conf(/b\.juntar !== true/.test(rota), 'e so junta com confirmacao explicita');
conf(/parcial_num = \$2/.test(rota),
     'ao juntar, iguala o parcial_num — senao ficaria (tr,processo) com dois numeros');
conf(/codigo_pc = ANY\(\$1\)/.test(rota), 'escreve por lista explicita de chaves (regra 12)');
conf(/parcela_historico/.test(rota), 'e registra quem, quando e o valor anterior');

const manual = src.slice(src.indexOf("app.post('/sgpe/link_manual'"),
                         src.indexOf("app.post('/sgpe/link_manual'") + 2600);
conf(/quemEdita/.test(manual), 'o link manual tambem confere perfil');
conf(/lido\.ano !== p\.ano/.test(manual),
     'e recusa link de OUTRO ano — o engano mais facil com varias abas do SGPe abertas');
conf(/ORIGEM_MANUAL/.test(manual), "grava com origem 'MANUAL'");
conf(/sgpe_link_manual/.test(manual), 'e registra quem colou no historico');

// ─────────────────────────────────────────────────────────────
secao("5. A TRAVA DO 'MANUAL' — obrigatoria");
const job = fs.readFileSync('./job_sgpe_links.js', 'utf8');
const lote = fs.readFileSync('./lib/sgpe-lote.js', 'utf8');

// ⚠️ EM DOIS LUGARES, de proposito: a fila nao inclui, e a escrita recusa mesmo se alguem
// chamar direto (--retentar-erros, script novo, engano).
conf(/if \(ja\.origem === 'MANUAL'\) continue;/.test(job), 'o job NAO poe MANUAL na fila');
conf(job.indexOf("ja.origem === 'MANUAL'") < job.indexOf("ja.origem === 'SGPE'"),
     'e confere MANUAL antes dos demais estados');
const gravacoes = lote.match(/WHERE sgpe_processo_ref\.origem[^`]*/g) || [];
conf(gravacoes.length === 3, 'as tres gravacoes tem clausula de protecao');
conf(gravacoes.every(g => /'MANUAL'/.test(g)), 'e as TRES protegem MANUAL');
conf(/gravarNegativa[\s\S]{0,700}?'MANUAL'/.test(lote), 'inclusive a negativa, que e a que apagaria o link');

console.log(`\n═══ RESULTADO: ${ok} passaram · ${falhou} falharam ═══`);
process.exit(falhou ? 1 : 0);
