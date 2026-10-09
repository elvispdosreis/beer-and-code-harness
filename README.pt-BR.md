# Beer and Code Harness (`bc-harness`)

Plugin de [Claude Code](https://claude.com/claude-code) com comandos, agentes e scripts para levar um projeto da ideia à implementação de forma estruturada: especificação formal, planejamento em fases e execução autônoma com validação mecânica — sem abrir mão do controle humano nos pontos de decisão.

O harness é **agnóstico de stack**: quem define linguagem, framework, comandos e convenções são os documentos do próprio projeto (`AGENTS.md`, `CLAUDE.md`, cadeia `.spec/`), nunca o harness.

## Visão geral do fluxo

```
 IDEIA                                             CÓDIGO
   │                                                 ▲
   ▼                                                 │
 /init:project-description  ──┐                      │
 /init:user-stories           │  cadeia init         │
 /init:database-schema        │  (.spec/init/)       │
 /init:project-phases       ──┘                      │
   │                                                 │
   │            /plan "<descrição da feature>"       │
   │            (.spec/features/<slug>/)             │
   ▼                                                 │
 project-phases.md  ou  PHASES.md ────────► scripts/ralph.sh
                                            (execução autônoma
                                             com 4 gates)

 /ai-context ─► AGENTS.md + docs/agents/*  (documenta o código JÁ implementado;
                                            alimenta /plan e o ralph)
```

Três pipelines independentes que se encaixam:

1. **`/init`** — do zero ao plano de construção do projeto (descrição → user stories → schema → fases).
2. **`/plan`** — de uma descrição de feature a SPEC formal + plano faseado, pronto para execução.
3. **`ralph.sh`** — executa qualquer documento de fases de forma autônoma, uma sessão nova de agente por fase, com gates mecânicos e um commit por fase concluída.

Transversal a tudo: **`/ai-context`** mantém a árvore de contexto (`AGENTS.md`, `CLAUDE.md`, `docs/agents/*.md`) sincronizada com o código real.

## Instalação

O repositório é um plugin de Claude Code (`.claude-plugin/plugin.json`). Instale via marketplace/caminho local conforme sua configuração de plugins:

```
/plugin install bc-harness
```

Os comandos ficam disponíveis com namespace: `/bc-harness:init`, `/bc-harness:plan`, etc. (nesta documentação, abreviados sem o namespace).

O `ralph.sh` é um script bash independente — copie ou referencie `scripts/ralph.sh` e rode direto no repositório do projeto-alvo. O roteador de modelo mora na mesma pasta: **copie `scripts/ralph-route.js` e `scripts/jev-credential.js` para o lado do `ralph.sh`** (ou aponte `RALPH_ROUTER=<caminho>` / `RALPH_CREDENTIAL=<caminho>`). Sem eles o ralph aborta no preflight com mensagem explícita.

**Pré-requisitos do ralph.sh:**

- Ao menos um CLI de engine — `--engine auto` (default) oferece ao roteador só os CLIs instalados:
  - Codex: `npm install -g @openai/codex` + `OPENAI_API_KEY`
  - Claude: `npm install -g @anthropic-ai/claude-code` + `ANTHROPIC_API_KEY`
- Node ≥ 18 (o roteador) e o decisor do harness-kit que fala com o JEV — veja [Roteamento de modelo](#roteamento-de-modelo-jev)
- Raiz de um repositório git com árvore de trabalho **limpa**

## Comandos

### `/init` — roteador da cadeia init

Mostra o estado dos artefatos de `.spec/init/` (presente / ausente / desatualizado) e **invoca o próximo comando da cadeia** (um passo por execução — re-rode `/init` para avançar). Não escreve nada por conta própria; toda autoria vive no comando `init:*` invocado.

A cadeia, em ordem:

| # | Artefato | Comando | Insumos |
|---|---|---|---|
| 1 | `.spec/init/project-description.md` | `/init:project-description` | — (cabeça da cadeia) |
| 2 | `.spec/init/user-stories.md` | `/init:user-stories` | project-description |
| 3 | `.spec/init/database-schema.md` | `/init:database-schema` | description + stories |
| 4 | `.spec/init/project-phases.md` | `/init:project-phases` | description + stories + schema |
| — | `.spec/init/design/` | manual (opcional) | — |

Cada artefato gerado carrega na linha 3 um **stamp** dos insumos (`arquivo@sha256:<12 chars>`). Se um insumo mudar depois, o `/init` detecta e reporta o downstream como *stale* — re-rodar o comando correspondente é upsert-safe: ele entrevista só sobre os deltas e atualiza o stamp.

- **`/init:project-description`** — entrevista o desenvolvedor, descobre a stack e produz a descrição estruturada do projeto.
- **`/init:user-stories`** — deriva user stories estruturadas e testáveis da descrição.
- **`/init:database-schema`** — deriva um schema de banco sugerido em DBML.
- **`/init:project-phases`** — planeja a construção em fases numeradas, agent-ready, com tasks, acceptance criteria e feature tests. **É o input padrão do `ralph.sh`.** Lê `.spec/init/design/` quando existir (refs de telas/componentes).

### `/plan` — pipeline de planejamento de feature

```
/plan "<descrição da feature ou caminho para arquivo de descrição>"
```

Produz, sob `.spec/features/<slug>/`:

| Artefato | Conteúdo |
|---|---|
| `SPEC.md` | Especificação formal em GEARS, com seções RIGID/FLEXIBLE, diagramas AS IS / TO BE e acceptance criteria binários |
| `PLAN.md` | Decomposição de tasks consciente da arquitetura, com fases de dependência, riscos e critérios de validação |
| `PHASES.md` | Visão do PLAN no formato executável pelo `ralph.sh` |
| `openapi.yaml` / `service.proto` / `asyncapi.yaml` | Contratos formais, quando a SPEC declara superfície de API (condicional) |

Características:

- **Sem issue tracker** — a descrição confirmada + ACs são a fonte de verdade. Nada de Jira.
- **Tier de complexidade** (`light` / `standard` / `complete`) classificado por sinais objetivos (nº de requisitos, multi-repo, contratos, mensageria); ajusta a profundidade da SPEC, a obrigatoriedade do clarifier e a emissão de contratos.
- **Checkpoints humanos** em cada etapa: confirmação do input normalizado, aprovação da SPEC, resolução de ambiguidades, confirmação da decomposição.
- **Clarifier em duas fases** — o agente analisa a SPEC e devolve perguntas priorizadas; o roteador as apresenta ao desenvolvedor e re-invoca o agente com as respostas, que atualiza a SPEC in-place.
- **Gate de arquitetura** — exige `AGENTS.md` / `docs/agents/` (ou avisa e marca `architecture_reference_status: missing`). Sem contexto de arquitetura o pipeline nunca planeja em silêncio.
- **Nunca escreve código de aplicação.** O fechamento aponta o handoff de execução:

```bash
./ralph.sh .spec/features/<slug>/PHASES.md
```

### `/ai-context` — árvore de contexto canônica

```
/ai-context [path] [+id] [-id] [--adopt]
```

Gera ou atualiza 10 artefatos a partir do **código implementado** (nunca lê `.spec/`):

| Artefato | Conteúdo |
|---|---|
| `AGENTS.md` | 6 seções: comandos, convenções, regras comportamentais, setup, referências, índice de docs |
| `CLAUDE.md` | Redirect ≤ 400 bytes para AGENTS.md |
| `docs/agents/project_overview.md` | Propósito, consumidores, fluxo macro |
| `docs/agents/architecture.md` | Estilo, layout, responsabilidades por camada |
| `docs/agents/tech_stack.md` | Linguagem, framework, runtime, tooling de teste |
| `docs/agents/coding_guidelines.md` | ≥ 3 padrões observados + enforcement |
| `docs/agents/domain_rules.md` | Regras de negócio como implementadas |
| `docs/agents/api_contracts.md` | Endpoints, payloads, formatos de mensagem |
| `docs/agents/data_model.md` | Entidades, storage, migrations |
| `docs/agents/dependencies.md` | Serviços externos, libs internas, infra compartilhada |

Regras centrais:

- **Idempotente** — upsert seguro; re-rodar atualiza só o que sofreu drift.
- **Documenta a realidade (AS IS)** — código, manifests, CI e configs são as únicas fontes; nunca inventa, nunca prescreve.
- **Contrato de ownership** — todo arquivo gerado carrega banner na linha 3. Arquivo sem banner (escrito à mão) nunca é sobrescrito; `--adopt` incorpora as regras concretas dele à árvore gerada e assume a posse.
- **Preserva blocos de terceiros** — regiões `<tag>...</tag>` (ex.: Laravel Boost) são re-anexadas verbatim na regeneração.
- Filtros `+id` / `-id` geram só um subconjunto (ex.: `/ai-context +AGENTS +architecture`).

## `scripts/ralph.sh` — orquestrador de execução

Lê um documento de fases, quebra pelo heading `## Phase N: <título>` e alimenta cada fase a uma sessão **nova** do Codex CLI ou Claude Code, sem interação humana, do início ao fim.

```bash
./scripts/ralph.sh [opções] [caminho-do-arquivo]
```

Sem argumento, resolve o input nesta ordem: `.spec/init/project-phases.md` → `.spec/project-phases.md` (layout pré-init, com aviso). Um `PHASES.md` de feature também é input válido.

### Invariantes

1. Cada fase **e** cada ciclo de correção roda em sessão nova, com prompt auto-contido. Nunca reutiliza sessão.
2. Zero perguntas — execução totalmente autônoma.
3. Fase só é "completa" quando passa pelos **4 gates mecânicos**, nunca pelo exit code do engine.
4. Limite de uso da API → espera o reset e re-executa a **mesma** fase, sem consumir ciclo de correção.
5. **Um commit por fase concluída** (`feat(phase-N): <título>`).

### Os 4 gates

| Gate | Pergunta | Como decide |
|---|---|---|
| 0 | O engine terminou de verdade? | claude: `is_error` no JSON de resultado; codex: exit code |
| 1 | A sessão escreveu código? | Assinatura da árvore antes/depois. **Sinal, não veredito** — fase já implementada faz o engine (corretamente) não escrever nada; o sinal alimenta a causa do ciclo de correção |
| 2 | A suite de testes passa? | Rodada **pelo ralph**, fora da sessão do agente — o agente não pode "mentir verde" |
| 3 | Cada task está de fato no código? | Sessão verificadora independente, read-only, que emite `TASK <n>: DONE/INCOMPLETE` por task. Roda em toda fase por default (`RALPH_VERIFY=always`); provedor/modelo vêm do [roteador](#roteamento-de-modelo-jev) (nunca abaixo de `balanced` em fase de risco) |

Qualquer gate vermelho → **ciclo de correção**: sessão nova recebe a fase inteira + a causa real da falha (nunca "os testes falharam" genérico). Default: 3 ciclos por fase.

Gates verdes com árvore limpa → fase já estava implementada em HEAD: marcada como feita, sem commit.

### Detecção do comando de teste (gate 2)

Primeira regra que resolver: `--test-cmd` → `RALPH_TEST_CMD` → detecção por manifest (Laravel Sail → `composer test` → `php artisan test` → `npm test` → `pytest` → `go test ./...` → `cargo test`) → nada resolvido = gate 2 pulado com aviso alto (gate 3 segura sozinho).

Projeto Laravel Sail: a suite roda **dentro do container** (`vendor/bin/sail test`); containers parados abortam no preflight — todo gate 2 falharia e queimaria ciclos à toa.

### Opções e variáveis

| Opção | Efeito |
|---|---|
| `--engine auto\|codex\|claude` | `auto` (default): o roteador escolhe o provedor por sessão entre os CLIs instalados. `codex`/`claude` restringe o provedor; o roteador ainda escolhe a faixa de modelo dentro dele |
| `--route-preview` | Mostra a decisão de roteamento por fase **sem rodar agente** (simulação offline, salvo `--route-live`) |
| `--route-live` | Com `--route-preview`: consulta o JEV de verdade (uma chamada por fase e modo) |
| `--from N` | Começa na fase N (limpa o progresso das fases ≥ N) |
| `--keep-going` | Continua após fase falhar (cria commit `wip(phase-N)`; default: para) |
| `--max-cycles N` | Ciclos de correção por fase (default: 3) |
| `--test-cmd "<cmd>"` | Comando de teste do projeto (gate 2) |
| `--no-verify` | Desliga o gate 3 |
| `--dashboard` | Painel ao vivo no terminal (ver abaixo) |

| Variável | Efeito |
|---|---|
| `RALPH_TEST_CMD` | Comando de teste (gate 2) |
| `RALPH_VERIFY` | Gate 3: `always` (default) \| `auto` (economiza: só quando o gate 2 não basta) \| `off` |
| `RALPH_VERIFY_MODEL` | Fixa o modelo do verificador. Só vale o catálogo abaixo (`gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, `haiku`, `sonnet`, `opus`), de provedor permitido e instalado; modelo abaixo do piso de risco da fase é rejeitado |
| `RALPH_ROUTER` | Caminho do `ralph-route.js` (default: ao lado do `ralph.sh`) |
| `TYPESAFE_API_KEY` | Chave do JEV. No CI, defina no ambiente (ou forneça um `.env`). Se faltar, vale o `.env` da pasta do projeto; se também não houver, a primeira execução interativa pergunta e grava nesse `.env` |
| `RALPH_CREDENTIAL` | Caminho do `jev-credential.js` (default: ao lado do `ralph.sh`) |
| `HARNESS_KIT` | Raiz do harness-kit cujo `scripts/decisor.js` é usado (default `~/.harness-kit`) |
| `RALPH_ROUTER_ON_FAIL` | `abort` (default, fail-closed) \| `low` \| `balanced` \| `high` — faixa fixa **explícita** quando o JEV falha; sempre rotulada `fallback-explicito` no log e na auditoria |
| `RALPH_ROUTER_OFFLINE` | `1` = política fixa offline sem JEV (testes/preview); rotulada `OFFLINE` |
| `RALPH_ROUTER_TIMEOUT_MS` | Timeout da chamada ao JEV (default 30000) |
| `RALPH_MAX_CYCLES` | Ciclos de correção por fase (default: 3) |
| `RALPH_MAX_LIMIT_WAITS` | Esperas consecutivas por limite de uso, por fase (default: 20) |
| `RALPH_LIMIT_WAIT_DEFAULT` | Fallback de espera em segundos (default: 1800) |
| `RALPH_LIMIT_BUFFER` | Segundos extras após o reset (default: 60) |

Durante cada sessão, o ralph exporta `RALPH_ENGINE` (o provedor daquela sessão), `RALPH_MODEL`, `RALPH_EFFORT`, `RALPH_TIER`, `RALPH_PHASE_TITLE`, `RALPH_PHASE_NUM`, `RALPH_PHASE_TOTAL`, `RALPH_PHASE_ATTEMPT` e `RALPH_PHASE_MAX_ATTEMPTS` — úteis para hooks de notificação (ex.: n8n).

### Roteamento de modelo (JEV)

Toda sessão de agente — cada ciclo de implementação e cada verificador independente — recebe provedor, modelo e esforço de raciocínio do **JEV**, o modelo de decisão alcançado pelo decisor do harness-kit. O objetivo é o modelo mais barato que dá conta, sessão a sessão, sem um default único.

**Quem decide o quê**

- **O JEV decide** (julgamento de modelo — uma heurística, não uma garantia): o provedor (quando há mais de um permitido), a faixa `low | balanced | high` e a classe de risco (`none | security | data_loss | architecture`). Ele recebe só um resumo pequeno e limitado da *fase real* (título, tasks, arquivos, sinais, um trecho curto, segredos redigidos, ≤ 7000 caracteres) e, em ciclo de correção, o gate que falhou e uma causa curta — nunca o repositório, os logs nem o prompt inteiro.
- **O ralph-route.js garante** (código, conferido depois de cada resposta): o catálogo de modelos, os esforços, os CLIs instalados, o teto, o piso de risco e o modo padrão.

| Faixa | Codex | Claude |
|---|---|---|
| `low` | `gpt-6-luna` · esforço `low` | `haiku` · sem flag `--effort` |
| `balanced` | `gpt-6-sol` · `medium` | `sonnet` · `medium` |
| `high` (teto) | `gpt-6.1-sol` · `high` | `opus` · `high` |

Nada acima de Sol / Opus é escolhido, e o esforço nunca passa de `high`. Os nomes do Claude são **aliases** do CLI (`haiku`, `sonnet`, `opus`): o Claude Code pode apontar um alias para um modelo mais novo da mesma família. Os IDs do Codex são explícitos. Não afirmamos preços nem percentual de economia.

**Só modo padrão.** Toda chamada passa modelo e esforço explícitos e nunca herda configuração global de fast: o Codex recebe `-c service_tier="default"` (a faixa `fast` equivale a processamento prioritário); o Claude recebe `CLAUDE_CODE_DISABLE_FAST_MODE=1` mais `--settings '{"fastMode":false}'`. O esforço também é fixado por chamada em `CLAUDE_CODE_EFFORT_LEVEL` (a variável de ambiente se sobrepõe ao esforço de skill e subagente, conforme a [documentação de configuração de modelo do Claude Code](https://code.claude.com/docs/en/model-config)): vale o esforço roteado, e `low` no Haiku, que não recebe a flag `--effort` (compatibilidade com aliases antigos), mas tem o ambiente limitado para não herdar esforço caro.

**Regras aplicadas depois da resposta do JEV**

- *Piso de risco:* classe de risco diferente de `none`, ou sinais objetivos na fase (segurança, migração de dados, concorrência/distribuição, arquitetura), elevam a faixa a no mínimo `high` na implementação e `balanced` no verificador. Fase só de documentação ignora os sinais de arquitetura/concorrência, e palavras soltas como "token economy", "lockfile" ou "schema" sozinho não são sinal. `RALPH_VERIFY_MODEL` não consegue fixar modelo abaixo desse piso, mesmo quando o JEV já respondeu `high`.
- *Ciclos de correção:* falha significativa (ciclo de correção) gera nova decisão do JEV com a contagem de falhas e a causa; a faixa pode subir, **nunca desce** abaixo da tentativa anterior, e para no teto.
- *Limite de uso:* esperar o reset do limite repete a **mesma** sessão com o mesmo modelo — sem escalar, sem nova chamada ao JEV.
- *Isolamento de provedor:* o gate 0 sempre lê o log com o provedor da sessão de *implementação*; o verificador em outro provedor não o corrompe.
- *Disponibilidade:* só CLIs instalados são oferecidos; `--engine codex|claude` restringe àquele provedor.

**Fail-closed.** Se o JEV estiver fora do ar, sem credencial ou responder algo inválido (faixa desconhecida, provedor fora do permitido, confiança inválida, resposta que não veio do JEV), o ralph **aborta antes de gastar uma sessão**. Não há heurística silenciosa. Opt-ins, sempre rotulados no log e no `routes.jsonl`: `RALPH_ROUTER_ON_FAIL=<low|balanced|high>` e `RALPH_ROUTER_OFFLINE=1`.

**Credencial.** O ralph nunca lê chave nenhuma. Ele força o decisor do kit no JEV (`decisor: 'jev'`, `HARNESS_DECISOR=jev` — nunca o fallback padrão do kit para outro decisor), e esse decisor precisa de `TYPESAFE_API_KEY` (ambiente ou `.env` do projeto, que o roteador carrega no próprio processo). Sem ela aparece `jev: sem TYPESAFE_API_KEY` e o aborto acima. As suítes de teste sempre usam um decisor falso (sem rede, sem chave). O caminho ao vivo foi validado uma vez com o JEV real (certificados padrão do Node): `--route-preview --route-live` devolveu `codex/gpt-6-luna/low`, `source=jev`. A chave vem do ambiente ou do `.env` do projeto (veja abaixo); nada mais é persistido. `--route-preview` sem `--route-live` é totalmente offline e funciona mesmo com `HARNESS_KIT` apontando para um kit inexistente.

**Cache e auditoria.** A resposta bruta do JEV fica em `.phases/state/route-cache.json`, chaveada por versão da política, hash do conteúdo da fase, modo, contagem de falhas, engine, provedores permitidos e catálogo. Pedido idêntico sai do cache; cada acerto é revalidado exatamente como uma resposta nova, e entrada corrompida ou antiga é descartada e perguntada de novo. Cada decisão é anexada a `.phases/state/routes.jsonl` (provedor, modelo, esforço, faixa, fonte `jev | override | fallback-explicito | offline`, cache, motivo, tokens do JEV) e logada como `Roteamento [impl|verify] -> provedor/modelo/esforço`.

**Preview, sem rodar agente**

```bash
./scripts/ralph.sh --route-preview                 # SIMULAÇÃO offline (rotulada; não é decisão do JEV)
./scripts/ralph.sh --route-preview --route-live    # consulta o JEV de verdade, uma chamada por fase e modo
node scripts/ralph-route.js catalog                # o catálogo permitido em JSON
```

**Escopo.** Esta camada vale para as sessões que o próprio ralph abre. Ela não faz os subagentes nativos do plugin Claude (`agents/`) rodarem no Codex — trocar de fornecedor ali não é transparente e está fora do escopo.

**Chave do JEV.** Ordem de busca: `TYPESAFE_API_KEY` no ambiente, depois um arquivo `.env` na pasta onde você roda o ralph (a raiz do projeto) e, se nenhum tiver e o terminal for interativo, a primeira execução pergunta uma vez (digitação oculta) e grava `TYPESAFE_API_KEY` nesse `.env`, em texto puro, e segue no mesmo run. As próximas reaproveitam e não perguntam. Outras chaves e comentários do seu `.env` ficam como estão; uma linha `TYPESAFE_API_KEY=` em branco é preenchida no lugar. O ralph põe `/.env` em `.git/info/exclude` antes de gravar (o `.gitignore` versionado não é tocado), então o `git add -A` nunca pega o arquivo; se o `.env` já estiver rastreado pelo git, o ralph se recusa a gravar nele — rode `git rm --cached .env` antes. O `.env` é lido por um parser pequeno (`CHAVE=valor`, `export` opcional, aspas, comentários `#`) — nunca é executado nem passa por `source` — e a chave não vai para argv, log nem saída. Sem terminal o ralph para antes de qualquer agente e diz como resolver (CI: defina `TYPESAFE_API_KEY` ou forneça um `.env`). Preview offline e `RALPH_ROUTER_OFFLINE=1` nunca perguntam; um `RALPH_ROUTER_ON_FAIL` explícito mantém o fallback sem terminal. Resposta vazia, Ctrl-C ou `.env` ilegível não gravam nada. Chave recusada ou erro de rede não é chave ausente: não pergunta nem sobrescreve.

**Onde mora.** O código-fonte é este repositório (`scripts/ralph-route.js`, `scripts/jev-credential.js`); o `~/.harness-kit` só é consultado pelo decisor e nunca é modificado.

### Estado e progresso

Trabalho interno em `.phases/` (registrado em `.git/info/exclude`, sem tocar o `.gitignore` do projeto): fases quebradas, prompts, logs, manifest e `.progress`. O progresso sobrevive entre execuções, mas só vale para o **mesmo input** (stamp sha256) — documento de fases alterado zera o progresso.

Exit code: `0` = todas as fases verdes; `1` = alguma falhou ou abortou.

## `scripts/ralph-watch.sh` — painel ao vivo

O ralph publica o estado do run em `.phases/state/` **sempre**, com ou sem `--dashboard`. O `ralph-watch.sh` lê esse estado e desenha o painel:

```bash
./scripts/ralph.sh --engine claude --dashboard   # painel no próprio terminal
./scripts/ralph-watch.sh /caminho/do/repo        # painel de outro terminal
```

```
┌─────────────────── PROGRESSO ───────────────────┐ ┌──────────────── TRABALHO ATUAL ─────────────────┐
│ Fases  1/2      [███████████░░░░░░░░░░░░]  50%  │ │ Fase:      2 · Interface observável             │
│ Tasks  1/2      [███████████░░░░░░░░░░░░]  50%  │ │ Ciclo:     1/3    Gate: G2                      │
└─────────────────────────────────────────────────┘ └─────────────────────────────────────────────────┘
┌──────┬────────────────────────────────────────────┬────────────────┬───────────┬─────────────────────┐
│ F1   │ Preparação                                 │ ✓ Concluída    │ 1         │ G0 ✓ G1 ✓ G2 ✓ G3 ✓ │
│ F2   │ Interface observável                       │ ▶ Em execução  │ 1         │ G0 ✓ G1 ✓ G2 ⋯ G3 · │
│ T1   │   ↳ renderizar títulos longos              │ ✓ Concluída    │ –         │ –                   │
│ T2   │   ↳ cobrir falhas de rede com retry        │ ▶ Em execução  │ –         │ –                   │
└──────┴────────────────────────────────────────────┴────────────────┴───────────┴─────────────────────┘
```

### De onde vem o progresso por task

Uma fase é **uma** sessão de agente, então o ralph não teria como saber onde a sessão está — a menos que a sessão conte. No engine claude ela conta:

A sessão roda com `--output-format stream-json`, que emite eventos linha a linha **enquanto** trabalha. O ralph lê esse stream e reescreve o progresso em `.phases/state/live.tsv`, de quatro fontes, nesta ordem de precedência:

1. **Marcadores de texto** (fonte primária). O prompt manda o agente escrever, como linha isolada, `RALPH-TASK <n> START` antes de começar o item *n* e `RALPH-TASK <n> DONE` quando ele estiver pronto. É texto puro: **não depende de ferramenta nenhuma** — e isso é o que importa, porque em sessão headless (`claude -p`) as ferramentas de lista de tarefas simplesmente não existem, mesmo que o agente tente carregá-las com `ToolSearch`.
2. **Lista de tarefas do agente**, quando a sessão tiver uma (`TaskCreate`/`TaskUpdate` ou `TodoWrite`): as transições `in_progress`/`completed` viram progresso.
3. **Reserva observacional** — sem marcador e sem lista, o ralph deduz pelo que o agente edita. Um plano do `/plan` declara `Arquivos:` em cada item, e é esse casamento (caminho editado ↔ arquivo declarado pela task) que dá a granularidade; sem a declaração, cai no enunciado da task. Ao entrar numa task, as anteriores contam como concluídas — o agente trabalha em ordem, e nem toda task tem arquivo próprio.
4. **Sinal de vida**: assim que a sessão abre, a task 1 aparece em execução — nunca uma fase inteira parada em "Pendente".

No fim da fase, o **gate 3 tem a palavra final**: o veredito `TASK <n>: DONE/INCOMPLETE` do verificador sobrepõe marcador, lista e dedução. Uma task marcada como pronta que não está no código aparece como `! Incompleta`.

Ou seja: durante a fase o painel mostra a intenção do agente; ao fim da fase mostra a verdade verificada.

No engine **codex** não há stream equivalente — a granularidade fica por fase, e as tasks aparecem como pendentes até o veredito do gate 3.

### Planos grandes: topo fixo e tabela rolante

Com dezenas de tasks a tabela não cabe na tela. O painel então mantém **o topo fixo** (identificação, barras, trabalho atual) e faz a tabela de fases e tasks rolar dentro de uma janela do tamanho do terminal — com barra de rolagem na borda direita e um rodapé dizendo quanto ficou fora:

```
  ▲ 23 acima · ▼ 9 abaixo · seguindo a fase atual · ↑↓ PgUp/PgDn rolam · f segue a fase
```

A linha em execução — fase e task — fica **realçada de ponta a ponta**, para ser achada de relance na tabela cheia.

Por padrão a janela **segue a fase corrente**: mostra o bloco da fase inteiro quando ele cabe e centra a task em execução quando não cabe. As teclas abaixo assumem o controle a qualquer momento e valem também com `--dashboard`, com o painel embutido no ralph:

| Tecla | Efeito |
|---|---|
| `↑` `↓` ou `k` `j` | Rola uma linha |
| `PgUp` `PgDn`, `b` ou espaço | Rola uma página |
| `Home`/`g` e `End`/`G` | Primeira e última linha |
| `f` | Volta a seguir a fase corrente |
| `q` | Sai do painel (só no modo avulso; não interrompe o ralph) |

| Opção do watch | Efeito |
|---|---|
| `--once` | Desenha um frame e sai (útil em script/CI); dump completo, sem recorte |
| `--interval N` | Segundos entre frames (default: 1) |
| `--no-color` | Desliga ANSI |
| `--color` | Força ANSI mesmo sem terminal (teste, arquivo) |
| `RALPH_WATCH_COLS` | Fixa a largura, para terminal que não reporta |
| `RALPH_WATCH_LINES` | Fixa a altura; com `--once` também liga a janela rolante |

Com `--dashboard`, as linhas de log do ralph vão para `.phases/logs/ralph.log` (o painel é dono da tela) e o relatório final é impresso no terminal ao sair. Sem o `ralph-watch.sh` ao lado do `ralph.sh`, o `--dashboard` avisa e segue no modo de log — o `ralph.sh` continua sendo copiável sozinho para outro repositório.

### Contrato de formato do input

Validado no preflight:

- ≥ 1 heading `## Phase N: <título>`
- Nenhum heading `## Phase ...` fora desse formato (heading torto some silenciosamente do run — o preflight aborta antes de gastar tokens)
- Sub-fases em `### Phase N.M:` (não viram sessão própria)
- Qualquer outro `## ` encerra a captura da fase anterior

## Agentes

Os comandos são **roteadores finos** — todo conhecimento de template vive nos agentes:

| Agente | Pipeline | Papel |
|---|---|---|
| `specifier` | `/plan` §5 | Descrição confirmada + ACs → SPEC.md formal (GEARS, RIGID/FLEXIBLE) |
| `clarifier` | `/plan` §6 | QA adversarial de requisitos: analisa ambiguidades, resolve com as respostas do dev |
| `planner` | `/plan` §7 | SPEC → PLAN.md + PHASES.md + contratos; read-only sobre o código |
| `ai-context-inspector` | `/ai-context` §3 | Varredura read-only do repo → digest estruturado |
| `ai-context-core` | `/ai-context` §4 | Digest → `AGENTS.md` + `CLAUDE.md` |
| `ai-context-docs` | `/ai-context` §4 | Digest → 8 arquivos `docs/agents/*.md` |

Os dois writers de `/ai-context` rodam em paralelo (arquivos disjuntos, digest read-only).

## Estrutura do repositório

```
.claude-plugin/plugin.json     manifest do plugin
commands/
  init.md                      /init (roteador diagnóstico)
  init/                        /init:project-description, user-stories,
                               database-schema, project-phases
  plan.md                      /plan (roteador do pipeline de planejamento)
  ai-context.md                /ai-context (roteador da árvore de contexto)
agents/                        specifier, clarifier, planner,
                               ai-context-{inspector,core,docs}
scripts/
  ralph.sh                     orquestrador de execução por fases
  ralph-route.js               roteador de modelo (decisão do JEV, catálogo, pisos, cache)
  jev-credential.js            confere a chave do JEV: ambiente, depois .env do projeto, senão pergunta uma vez e grava lá
  ralph-watch.sh               painel ao vivo do run (lê .phases/state/)
  test-ralph.sh                suite red/green do ralph com engine mock
  test-ralph-route.js          testes offline do roteador (decisor falso)
  test-jev-credential.js       testes offline do auxiliar de chave (provedor falso)
  check-init-drift.sh          guarda contra drift textual das regras
                               duplicadas nos comandos init
  check-shell.sh               bash -n + shellcheck em scripts/*.sh
docs/plans/                    planos de hardening internos do harness
```

## Desenvolvimento

```bash
scripts/test-ralph.sh        # suite do ralph.sh — binários fake `claude`/`codex`
                             # no PATH, zero rede, zero token; exit 0 = verde
scripts/test-ralph.sh <caso> # roda um caso específico
node scripts/test-ralph-route.js  # testes do roteador — decisor falso, zero rede
node scripts/test-jev-credential.js  # testes do auxiliar de chave — pastas temporárias e chaves falsas, nunca um .env real
scripts/check-shell.sh       # bash -n em todos os scripts + shellcheck se disponível
scripts/check-init-drift.sh  # âncoras verbatim das regras compartilhadas dos init:*
```

Sobre o `check-init-drift.sh`: os quatro `commands/init/*.md` **inlinam de propósito** as mesmas regras de entrevista, idioma, re-run e staleness — comandos de plugin precisam ser auto-contidos em runtime (executam dentro do projeto do desenvolvedor, onde a raiz do plugin não é alcançável via `@`-includes). O custo dessa duplicação é drift silencioso; o script torna o drift barulhento.

## Princípios de design

- **Roteadores finos, agentes donos do conteúdo** — comandos orquestram, verificam artefatos em disco e reportam; nunca autoram SPEC/PLAN/docs.
- **Confie, mas verifique** — todo artefato entregue por agente é validado mecanicamente (existência, headings, contagens) pelo roteador.
- **Realidade ≠ intenção** — `/ai-context` documenta só o implementado; `.spec/` é invisível para ele. A cadeia `.spec/` documenta a intenção.
- **Sem escrita em git pelos comandos** — o desenvolvedor revisa com `git diff` e commita manualmente. O único que commita é o `ralph.sh`, por design (um commit por fase validada).
- **Sem segredos** — `.env` nunca é lido; nomes de variáveis vêm de `.env.example`.
- **Staleness explícita, nunca bloqueante** — stamps sha256 detectam insumos desatualizados; a decisão é sempre do desenvolvedor.
