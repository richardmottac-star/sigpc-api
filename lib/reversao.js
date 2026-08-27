// CAMINHO: sigpc-api/lib/reversao.js
//
// ESCREVER O JSON DE REVERSÃO SEM DESTRUIR O DE UMA GRAVAÇÃO ANTERIOR.
//
// ─────────────────────────────────────────────────────────────────────────────
// O DEFEITO QUE ISTO CORRIGE — medido em 27/08/2026, no próprio dia
//
// Os scripts de migração deste projeto separam o arquivo de reversão em DOIS nomes, um do
// dry-run e um da gravação, para que um dry-run rodado depois não apague o caminho de volta.
// Isso cobria o dry-run contra a gravação — e deixava a gravação exposta A ELA MESMA.
//
// Em 27/08 o `migracao_sigef_status_20260827.js --gravar` rodou uma segunda vez. Como já não
// havia nada a gravar (o script é idempotente), a lista `valores_anteriores` saiu VAZIA — e
// sobrescreveu o arquivo que guardava as 3.466 chaves com o valor anterior de cada PC. As
// conferências passaram todas, o script disse COMMIT, e o único registro de como voltar tinha
// virado uma lista de zero itens. Nada acusaria isso até alguém precisar reverter.
//
// ⚠️ A LIÇÃO NÃO É "NÃO RODE DUAS VEZES". Idempotência existe justamente para que rodar de
// novo seja seguro; se rodar de novo destrói alguma coisa, o script não era idempotente —
// era idempotente no BANCO e destrutivo no DISCO.
//
// ⚠️ E O CRITÉRIO É `modo === 'gravacao'`, NÃO "tem conteúdo". Uma gravação legítima pode ter
// `valores_anteriores` vazio (a segunda rodada de uma migração só-DDL, por exemplo), e ainda
// assim é o registro de que aquela escrita aconteceu, com as duas fotos e os md5. Perder isso
// é perder a prova, mesmo sem perder chave nenhuma.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');

/**
 * Grava `conteudo` em `caminho`, a menos que ali já exista a reversão de uma GRAVAÇÃO — caso
 * em que escreve ao lado, com sufixo de hora, e preserva o arquivo antigo.
 *
 * @param caminho  o arquivo pretendido
 * @param conteudo o objeto de reversão; espera-se `modo` ('gravacao' | 'dry-run') e `quando`
 * @returns {{caminho, preservou, motivo}} onde escreveu de fato, e o que foi preservado
 */
function escreverReversao(caminho, conteudo) {
  const gravar = (destino) => {
    fs.writeFileSync(destino, JSON.stringify(conteudo, null, 2), 'utf8');
    return destino;
  };

  if (!fs.existsSync(caminho)) return { caminho: gravar(caminho), preservou: null, motivo: null };

  let antigo = null, ilegivel = false;
  try { antigo = JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch (_) { ilegivel = true; }

  // ⚠️ ARQUIVO ILEGÍVEL TAMBÉM É PRESERVADO. Se não dá para saber o que ele era, não dá para
  // saber que sobrescrevê-lo é seguro — e o caso em que ele importa é justamente o caso em
  // que algo já deu errado.
  const preservar = ilegivel || (antigo && antigo.modo === 'gravacao');
  if (!preservar) return { caminho: gravar(caminho), preservou: null, motivo: null };

  // O sufixo vem do `quando` do próprio conteúdo, para o nome dizer de quando é a rodada
  // NOVA. Sem ele, um carimbo do relógio na hora da escrita diria quase a mesma coisa — mas
  // o `quando` é o que aparece dentro do arquivo, e os dois batendo poupam a conferência.
  const carimbo = String((conteudo && conteudo.quando) || new Date().toISOString())
    .replace(/[:.]/g, '-');
  const base = caminho.replace(/\.json$/, '');
  let alt = `${base}_${carimbo}.json`;
  // ⚠️ E se o alternativo também existir, não sobrescreve: numera. Duas rodadas no mesmo
  // milissegundo é improvável, mas "improvável" foi exatamente o que aconteceu hoje.
  let n = 2;
  while (fs.existsSync(alt)) { alt = `${base}_${carimbo}_${n}.json`; n++; }

  return {
    caminho: gravar(alt),
    preservou: caminho,
    motivo: ilegivel ? 'o arquivo existente nao pode ser lido' : 'ja existe a reversao de uma gravacao',
  };
}

module.exports = { escreverReversao };
