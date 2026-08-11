# SIGPC-GT — Contexto do Projeto

Sistema de Gestão de Prestações de Contas do Grupo de Trabalho da FCEE
(Fundação Catarinense de Educação Especial, Governo de Santa Catarina).

**Responsável:** Richard Motta Coelho — superadmin e analista do Grupo 3.
**Última sessão:** 19/07/2026

---

## Arquitetura

| Camada | Stack | Repositório |
|---|---|---|
| Frontend | HTML single-file no GitHub Pages | `sigpc-gt` → `index.html` |
| API | Node.js/Express no Railway | `sigpc-api` → `server.js` |
| Banco | PostgreSQL no Railway | — |

- Sistema: https://richardmottac-star.github.io/sigpc-gt/
- API: https://sigpc-api-production.up.railway.app
- Banco: string de conexão em `DATABASE_URL` (variável de ambiente — ver Railway; não versionar a senha)

O deploy é automático: `git push` no `sigpc-api` redeploya o Railway; no `sigpc-gt` atualiza o GitHub Pages.

---

## Regra de negócio

```
TR ──── processo mãe (1:1)
 └── PC (1 a 83)   ← chave única = codigo_pc | unidade de produtividade
      ├── processo SGPe da PC   (compartilhado entre PCs)
      └── NL (1 por PC)         (compartilhada entre PCs → 1 parecer baixa N)
```

- **1 PC = exatamente 1 NL.** Sem exceção nas 13.626 parciais.
- **1 NL pode ser quitada por várias PCs** — até 19 (ex: `2022NL008336`).
  É o que a CGE descreve como *"um parecer baixa 8 PCs"*.
- O analista assume a **TR inteira** e analisa todas as PCs dela.
- A unidade de produtividade é a **PC baixada**, conforme CGE nº 727/2025.
- Meta padrão: 110 PCs por analista no período; proporcional para quem entrou depois.

---

## Banco de dados

### `usuarios` — 50 registros

Além do cadastro: `senha_hash` (bcrypt desde 11/08/2026) e **`senha_provisoria`** — quando
`true`, o login desvia para a tela de troca antes de abrir o painel. Criada no boot por
`garantirColunasUsuarios()`, nasce `false`; quem marca é `migracao_senhas.sql`.

⚠️ **Login é por CPF.** Nove usuários estão sem CPF e não conseguem entrar — ver Pendências.

### `prestacoes_contas` — 14.652 registros (fonte única)

Chave: `codigo_pc`. Tipos: `parcial` (13.626) e `final` (1.026, sem NL, id `{TR}-PFINAL`).

Status: `livre`, `analise`, `diligencia`, `reanalise`, `baixada`.

Campos: `codigo_pc`, `codigo_nl`, `tipo`, `tr`, `processo_pc`, `processo_mae`,
`parcela_seq`, `entidade`, `cnpj_cpf`, `valor`, `situacao_origem`, `status`,
`analista_nome`, `analista_id`, `grupo`, `conflito`, `parecer_tipo`, `baixada`,
`data_baixa`, `origem_baixa`, `registrado_por`, `setorial_id`, `dt_limite_pc`,
`dt_recebimento_pc`, `prazo_analise_dias`, `dias_atraso`, `prazo_diligencia`,
`num_diligencia`, `enviado_ci`, `dt_envio_ci`

### Outras
- `metas_analistas` — 46 analistas, `vigente = true`, período Nov/2025 a Abr/2026
- `anotacoes_tr` — anotações por TR com histórico
- `usuarios` — cadastro e login
- `planilha_analista` — **DESCONTINUADA.** Nenhuma tela usa. Não reintroduzir.

### Baixas históricas
`origem_baixa = 'carga_historica'` · `data_baixa = 2026-06-30`

---

## Equipe

| Grupo | Coordenador | Analistas |
|---|---|---|
| 1 | Nayara Limas Ferreira | 15 |
| 2 | Zadir T. Machado Ferreira | 14 |
| 3 | Gustavo (**sem cadastro em `usuarios`**) | 17 |

Coordenadores não contam produtividade e não aparecem no Quadro 2 do relatório CGE.

---

## Armadilhas conhecidas

1. **Nome curto vs completo** — `prestacoes_contas.analista_nome` é curto ("Richard");
   `usuarios.nome` é completo ("Richard Motta Coelho").
   **Sempre filtrar por `analista_id`**, nunca por nome.

2. **`CREATE TABLE IF NOT EXISTS` não altera tabela existente.**
   Para colunas novas usar `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

3. **Datas futuras zeram o relatório.** `data_baixa` sempre no passado.

4. **Colunas que NÃO existem em `usuarios`:** `email`, `obs`, `atualizado_em`.
   Incluí-las no payload gera erro. Se precisar, criar antes com `ALTER TABLE`.

5. **Não editar `index.html` por número de linha via PowerShell** — risco de corromper
   o arquivo inteiro. Usar edição por busca de texto.

6. **Setorial é sempre FCEE.** Os processos são abertos pelos núcleos (SCC, ADR, SDR),
   mas a concedente é a FCEE.

7. **Chave de agrupamento é `codigo_pc`**, nunca `processo_sgp` — 2.704 processos
   têm mais de uma PC.

8. **`senha_hash` NUNCA sai do servidor.** Toda rota que devolve linha de `usuarios` passa
   por `auth.semSegredo()`. Até 11/08/2026 não era assim: `GET /usuarios` entregava as 49
   senhas em texto puro a quem pedisse, sem credencial nenhuma — medido em produção.
   `teste_auth.js` falha se qualquer `SELECT *` ou `RETURNING *` de `usuarios` chegar à
   resposta sem o filtro. **Não contornar a trava: ela é a correção.**

9. **A senha não se confere no front.** Quem confere é `POST /usuarios/login`. A regra de
   quem pode entrar mora em `lib/auth.js`, não no `index.html` — lá ela era contornável
   pelo DevTools.

10. **Comentário dentro de template literal não leva crase.** Uma crase no meio de uma
    `` `...` `` fecha a string e o arquivo deixa de compilar. Aconteceu duas vezes em
    11/08, no `server.js` e no `index.html`. Escrever `FALSE`, não `` `false` ``.

---

## Método: TRABALHAR EM BLOCO, NÃO PASSO A PASSO (desde 12/08/2026)

**Motivo:** em 10/08 o método passo a passo — mockup, parar, implementar uma tela, parar,
reportar — consumiu o dia inteiro e cansou o Richard sem necessidade.

- **Agrupar frentes relacionadas num único ciclo**, em vez de parar entre cada tela.
- **Parar só quando a decisão for realmente dele:** regra de negócio, prioridade, ou
  dado de analista real.
- **Não parar** para confirmar detalhe de implementação, texto de mensagem ou escolha
  técnica — decidir, seguir, e reportar depois.
- **Reportar em bloco no fim**, não a cada etapa.
- **Rodar contra o banco antes de publicar continua valendo** — foi o que pegou os quatro
  defeitos de SQL de 10–11/08, todos invisíveis aos 220 testes com dublê.

Isto NÃO afrouxa a regra de escrita no banco: `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE`
continuam exigindo autorização expressa. O que muda é o ritmo do trabalho, não a permissão.

---

## Padrões de trabalho

- Validar sempre com `node --check` antes de commit.
- No `index.html`, extrair os blocos `<script>` para um arquivo temporário e validar.
- Testar rotas contra o banco antes do push; reverter dados de teste em seguida.
- Nunca commitar CSVs de carga nem scripts com credencial.
- Comunicação com o Richard em português do Brasil.

---

## Pendências

> Conferida contra o banco em **11/08/2026**. O que está marcado `[x]` foi verificado, não
> presumido — a consulta que provou está escrita ao lado. Não reabrir sem medir de novo.

### ABERTURA AOS 47 ANALISTAS — o que trava (varredura de 11/08/2026)
- [ ] **Nove analistas sem CPF não conseguem entrar. O login é por CPF.**
      Nayara (**coordenadora do G1**), Aline, Daniela, Franciani, Marisa, Ana Leticia,
      Miriam, Marlene, Scheila. Mais a **Grazielly** (id 42, `senha_hash` NULL) e o
      **Eduardo** (id 52, `ativo = false`). **Entram 39 de 50.** Falta o dado, só.
- [ ] **`migracao_senhas.sql` não foi executado** — sem ele ninguém é obrigado a trocar a
      senha, e as 44 senhas iguais continuam valendo.
- [ ] **`migracao_senhas_hash.js` (opcional)** — converte de uma vez o texto puro que
      sobrar. O login já converte a de quem entra.

### Aberto — precisa de decisão do Richard
- [ ] **Caroline** — meta 27 vigente, **sem usuário em `usuarios`**. É a única meta vigente
      nessa situação (conferido: 46 metas vigentes, 45 com usuário).
- [ ] **Meta vigente: CGE (Ago/25) ou Monitoramento (Nov/25)** — nunca decidido.
- [ ] **Gustavo: nome completo e portaria.** O cadastro existe (id 56, coordenador, grupo 3),
      mas a assinatura segue comentada no PDF do relatório CGE.

### Aberto — trabalho técnico
- [ ] **Quadro 2 do relatório CGE** lista os 45 servidores? (estava truncando em 5) — nunca
      conferido depois da correção.
- [ ] **Estoque no Quadro 1.** A anotação antiga diz 11.552; o banco tem **11.033 abertas**
      (14.652 total − 3.619 baixadas). Os números não batem: conferir de onde sai o 11.552.
- [ ] **Código morto no `index.html`:** `confDev` e modal `moDev` — 14 ocorrências.
- [ ] **`identidade_sigpc.css` e `logo_sc_base64.js`** (no `sigpc-gt`): nenhum `<script>` ou
      `<link>` os carrega. Mesmo caso do `sgpe-link-standalone.js` que foi removido —
      candidatos a exclusão, **confirmar com o Richard antes**.

### Resolvido — não reabrir
- [x] **16 TRs com 2+ analistas** — `SELECT COUNT(DISTINCT tr) WHERE conflito = true` → **0**.
- [x] **6 TRs que não casaram** (`2020 TR000777`, `2022TR 002065`, `2019TR000319`,
      `2021TR000719`, `2021TR000804`, `2024TR000204`) — **nenhuma existe** em
      `prestacoes_contas`. A lista está obsoleta.
- [x] **Gustavo sem cadastro** — existe desde então: id 56, coordenador, grupo 3. A armadilha
      antiga ("Grupo 3 não tem coordenador em `usuarios`") **não vale mais**, mas o
      cai-para-o-superadmin em `notificacao.coordenadoresDoGrupo` fica: protege qualquer grupo
      que venha a ficar sem coordenador.
- [x] **Claudia com meta "—"** — id 36 em `usuarios`, meta 120 vigente. O dado está completo;
      reabrir só se voltar a aparecer no relatório.
- [x] **Notificações internas / sininho** — implementado em 10–11/08. Quatro canais.
- [x] **Tela Produtividade com linhas neutras** — corrigido em 19/07/2026.

### Decisões registradas (não são pendências — são o motivo de o sistema ser assim)
- **`dt_limite_pc` histórico NÃO é prazo — é cálculo em lote. Decisão do Richard, 10/08/2026.**
      Não é defeito a investigar: é dado que não deve ser usado como prazo.
      A prova está na própria distribuição — **29/07/2024** é a `dt_limite_pc` mais recente de
      *todos* os 44 analistas, e as 231 de 2027 caem *todas* em 30/01/2027. Nenhuma PC vence
      entre ago/2026 e jan/2027, num acervo de 4.721.
      **Prazo real só passa a existir quando o analista inserir a data no sistema**, a partir
      da abertura para a equipe.
      Consequência já implementada: `CORTE_PRAZO = '2026-08-01'` em `job_notificacoes.js`.
      O sino não emite prazo sobre o acervo antigo — só sobre data inserida daqui pra frente.
      **Não baixar esse corte** achando que é conservador demais: baixá-lo faz o sino avisar
      sobre datas que ninguém definiu.
- **Prazo é data civil brasileira, nunca `CURRENT_DATE`.** O Postgres do Railway roda em UTC,
  então `CURRENT_DATE` vira o dia seguinte às 21h de Brasília. Medido em 11/08 às 23h55:
  as **11.033** PCs com prazo mostravam um dia a mais de atraso, e o número voltava de manhã.
  Use `HOJE_BR` de `lib/datas.js`. Há teste que falha se um `CURRENT_DATE` cru voltar.

### E-mails dos analistas — não é pendência de dado
O campo `email` existe e é preenchido (Primeiro Acesso e Meu Perfil, desde 19/07/2026).
O que não existe é **envio** de e-mail — isso é funcionalidade nova, não item em aberto.
