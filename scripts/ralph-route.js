#!/usr/bin/env node
'use strict';

// ralph-route.js — camada de decisao de modelo do ralph.sh.
//
// Quem decide provedor + faixa (low|balanced|high) e o JEV, pelo decisor do
// harness-kit (scripts/decisor.js, forcado em 'jev'). Este arquivo so:
//   1. monta um resumo PEQUENO e limitado da fase (nunca repo, log ou segredo);
//   2. faz perguntas tipadas (choice) com opcoes fechadas;
//   3. valida cada resposta contra o catalogo local (modelos, esforcos, CLIs
//      instalados) e aplica piso de risco e teto de catalogo DEPOIS da resposta;
//   4. cacheia a resposta bruta do JEV por conteudo da fase + modo + falhas
//      significativas + politica, para retry por limite de uso nao chamar o JEV.
// JEV indisponivel ou resposta invalida => falha FECHADA (exit 3). Nenhuma
// heuristica local substitui o JEV em silencio.
//
// Uso:
//   node ralph-route.js decide --phase <arq> --mode impl|verify --engine auto|codex|claude
//        --available codex,claude [--failures N] [--gate <txt>] [--cause-file <arq>]
//        [--prev-tier low|balanced|high] [--verify-model M] [--cache <arq>] [--log <arq>]
//        [--offline] [--format kv|json]
//   node ralph-route.js check --engine E --available L [--verify-model M]
//   node ralph-route.js preview <arquivo-de-fases> [--engine E] [--available L] [--live]
//   node ralph-route.js catalog
//
// Ambiente:
//   HARNESS_KIT              raiz do kit (default ~/.harness-kit) -> scripts/decisor.js
//   RALPH_DECISOR_MODULE     caminho de um modulo com decidir(state,questions,opts);
//                            sobrepoe HARNESS_KIT (usado pelos testes offline)
//   TYPESAFE_API_KEY         chave do JEV; se faltar, vem do .env da pasta de execucao
//                            (jev-credential.js, ao lado deste arquivo)
//   RALPH_ROUTER_TIMEOUT_MS  timeout da chamada ao JEV (default 30000)
//   RALPH_ROUTER_ON_FAIL     abort (default) | low | balanced | high — faixa fixa
//                            EXPLICITA quando o JEV falha (registrada como tal)
//   RALPH_ROUTER_OFFLINE     1 = politica fixa offline (sem JEV); faixa em
//                            RALPH_ROUTER_OFFLINE_TIER (default balanced)

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const POLICY_VERSION = 'v1';
const TIER_ORDER = ['low', 'balanced', 'high']; // high = teto: Sol (OpenAI) / Opus (Anthropic)
const PROVIDERS = ['codex', 'claude'];
const RISK_CONF_MIN = 0.5;

// Catalogo local: unica fonte do que pode ser executado. effort null = o modelo
// nao recebe flag de esforco (haiku). Nada de fast/priority, nada acima de Sol/Opus.
const TIERS = {
  low:      { codex: { model: 'gpt-6-luna',   effort: 'low' },    claude: { model: 'haiku',  effort: null } },
  balanced: { codex: { model: 'gpt-6-sol',    effort: 'medium' }, claude: { model: 'sonnet', effort: 'medium' } },
  high:     { codex: { model: 'gpt-6.1-sol',  effort: 'high' },   claude: { model: 'opus',   effort: 'high' } }
};
const EFFORTS = ['low', 'medium', 'high'];
const MODELS = {};
for (const t of TIER_ORDER) for (const p of PROVIDERS) MODELS[TIERS[t][p].model] = { provider: p, tier: t };

const CRITERIOS_TIER = {
  low: 'trabalho trivial: documentacao, texto, renomear, config pontual, 1 a 2 arquivos com padrao ja existente, sem decisao de desenho',
  balanced: 'codigo normal: varias tasks ou arquivos, testes novos, camadas ligadas, sem risco estrutural',
  high: 'arquitetura, seguranca, sistema distribuido, concorrencia, migracao de dados, integracao externa delicada ou falha repetida que pede o modelo mais forte'
};
const CRITERIOS_RISCO = {
  none: 'nada sensivel',
  security: 'autenticacao, permissao, credencial, dado pessoal exposto, superficie de ataque',
  data_loss: 'migracao, exclusao ou sobrescrita de dados, perda ou corrupcao de estado',
  architecture: 'decisao estrutural, concorrencia, sistema distribuido, contrato entre servicos'
};
const CRITERIOS_PROVEDOR = {
  codex: 'OpenAI Codex CLI (familia gpt-6)',
  claude: 'Anthropic Claude Code CLI (haiku, sonnet, opus)'
};

class RouteError extends Error {}

// ---------------------------------------------------------------------------
// utilitarios
// ---------------------------------------------------------------------------

function arg(argv, nome, padrao = null) {
  const i = argv.indexOf('--' + nome);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : padrao;
}
const flag = (argv, nome) => argv.includes('--' + nome);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rank = (tier) => TIER_ORDER.indexOf(tier);
const maxTier = (a, b) => (rank(a) >= rank(b) ? a : b);

const SEGREDOS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|secret|token|password|senha|passwd)\b\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g
];

// Causa de falha: o erro de verdade esta no FIM do log. Mantem o cabecalho (1a linha)
// e a cauda, tudo dentro de max caracteres.
function limparCauda(texto, max) {
  const t = limpar(texto, Infinity);
  if (t.length <= max) return t;
  const cab = (t.split('\n')[0] || '').slice(0, 100);
  const sep = ' […] ';
  const cauda = t.slice(-(max - cab.length - sep.length));
  return cab + sep + cauda;
}

function limpar(texto, max) {
  let t = String(texto || '').replace(/\r/g, '');
  for (const re of SEGREDOS) t = t.replace(re, '[redigido]');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function lista(csv) {
  return String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function validarContexto(engine, available) {
  if (!['auto', ...PROVIDERS].includes(engine)) throw new RouteError(`engine invalida: '${engine}' (use auto, codex ou claude)`);
  const bad = available.filter((p) => !PROVIDERS.includes(p));
  if (bad.length) throw new RouteError(`provedor desconhecido em --available: ${bad.join(',')}`);
  const permitidos = (engine === 'auto' ? PROVIDERS : [engine]).filter((p) => available.includes(p));
  if (!permitidos.length) {
    throw new RouteError(engine === 'auto'
      ? 'nenhum CLI disponivel (instale codex ou claude)'
      : `o CLI '${engine}' nao esta disponivel`);
  }
  return permitidos;
}

// RALPH_VERIFY_MODEL: so entra se existir no catalogo e for de provedor permitido.
function validarModeloVerificador(model, permitidos) {
  if (!model) return null;
  const m = MODELS[model];
  if (!m) throw new RouteError(`RALPH_VERIFY_MODEL='${model}' fora do catalogo permitido (${Object.keys(MODELS).join(', ')})`);
  if (!permitidos.includes(m.provider)) {
    throw new RouteError(`RALPH_VERIFY_MODEL='${model}' e do provedor ${m.provider}, que esta fora do permitido/disponivel (${permitidos.join(',')})`);
  }
  return { provider: m.provider, tier: m.tier, ...TIERS[m.tier][m.provider] };
}

// ---------------------------------------------------------------------------
// resumo limitado da fase
// ---------------------------------------------------------------------------

const RE_ARQ = /[A-Za-z0-9_./-]+\.(?:php|tsx?|jsx?|vue|html|s?css|sql|json|ya?ml|py|rb|go|rs|java|cs|sh|md|toml|lock|env)\b/g;
const SINAIS = {
  // 'token' solto nao conta (token economy, tokens de design); so credencial de verdade
  seguranca: /\b(auth|autentic|autoriz|permiss|credencial|criptograf|jwt|oauth|csrf|xss|senha|password|secret|seguran|rbac|api[ _-]?token|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|bearer)/i,
  // 'schema' so como mudanca de schema; lock/fila/race so como palavra inteira (lockfile nao conta)
  migracao: /\b(migra[cç][aã]o|migration|drop table|alter table|backfill|seed de producao|schema (change|migration)|(altera[a-z]*|mudan[a-z]*|migra[a-z]*) (de |do |no )?schema)/i,
  distribuido: /\b(distribu|concorr|idempot|queue|kafka|rabbit|saga|eventual|deadlock|race condition|cluster|replica)|\b(filas?|locks?|races?)\b/i,
  arquitetura: /\b(arquitetur|refator[a-z]* estrutural|monolito|microsserv|boundary|camada de dominio|breaking change|contrato (entre|de api|de servi))/i
};

function resumirFase(texto) {
  const t = String(texto || '').replace(/\r/g, '');
  const linhas = t.split('\n');
  const titulo = limpar((linhas.find((l) => /^#{1,3}\s/.test(l)) || linhas[0] || '').replace(/^#+\s*/, ''), 160);
  const tasks = linhas.filter((l) => /^\s*- \[[ x]\]/.test(l)).map((l) => limpar(l.replace(/^\s*- \[[ x]\]\s*/, '').replace(/\*\*/g, ''), 140));
  const arquivos = [...new Set(t.match(RE_ARQ) || [])];
  const so_docs = arquivos.length > 0 && arquivos.every((f) => /\.(md|txt)$/i.test(f)) ||
    (arquivos.length === 0 && !/\b(teste|test|endpoint|rota|classe|funcao|migration|api)\b/i.test(t));
  const sinais = {};
  for (const [k, re] of Object.entries(SINAIS)) sinais[k] = re.test(t);
  return {
    hash: sha(t),
    titulo,
    tasks_total: tasks.length,
    tasks: tasks.slice(0, 12),
    arquivos_total: arquivos.length,
    arquivos: arquivos.slice(0, 15).map((f) => limpar(f, 80)),
    criterios: linhas.filter((l) => /^\s+- /.test(l) && !/^\s*- \[[ x]\]/.test(l)).length,
    caracteres: t.length,
    so_documentacao: so_docs,
    sinais,
    trecho: limpar(t, 900)
  };
}

// Piso objetivo de risco, aplicado DEPOIS da resposta do JEV. Nao escolhe nada:
// so impede subavaliar trabalho sensivel.
function pisoObjetivo(resumo) {
  // fase so de documentacao nao tem concorrencia nem arquitetura a quebrar:
  // ignora esses dois sinais; seguranca e migracao continuam valendo
  const ignorar = resumo.so_documentacao ? ['arquitetura', 'distribuido'] : [];
  const ativos = Object.entries(resumo.sinais).filter(([k, v]) => v && !ignorar.includes(k)).map(([k]) => k);
  return ativos.length ? { tier: 'high', motivo: 'sinais objetivos: ' + ativos.join(',') } : { tier: 'low', motivo: '' };
}

// ---------------------------------------------------------------------------
// decisor (harness-kit) — JEV forcado
// ---------------------------------------------------------------------------

function caminhoDecisor() {
  if (process.env.RALPH_DECISOR_MODULE) return process.env.RALPH_DECISOR_MODULE;
  const kit = process.env.HARNESS_KIT || path.join(os.homedir(), '.harness-kit');
  return path.join(kit, 'scripts', 'decisor.js');
}

function carregarDecisor() {
  const p = caminhoDecisor();
  if (!fs.existsSync(p)) {
    throw new RouteError(`decisor do harness-kit nao encontrado em ${p} (defina HARNESS_KIT=<raiz do kit>)`);
  }
  const mod = require(path.resolve(p));
  if (typeof mod.decidir !== 'function') throw new RouteError(`${p} nao exporta decidir()`);
  return mod.decidir;
}

function esperadasPara(oferecidos) {
  const e = { faixa: TIER_ORDER, risco: Object.keys(CRITERIOS_RISCO) };
  if (oferecidos.length > 1) e.provedor = oferecidos;
  return e;
}

function validarResposta(r, perguntas) {
  if (!r || typeof r !== 'object' || !r.answers || typeof r.answers !== 'object') throw new RouteError('resposta do JEV sem answers');
  if (r.provedor !== 'jev') throw new RouteError(`resposta nao veio do JEV (provedor=${JSON.stringify(r.provedor)})`);
  return validarAnswers(r.answers, perguntas);
}

// mesma validacao para resposta nova do JEV e para entrada de cache
function validarAnswers(answers, perguntas) {
  if (!answers || typeof answers !== 'object') throw new RouteError('answers ausente');
  const out = {};
  for (const [nome, opcoes] of Object.entries(perguntas)) {
    const a = answers[nome];
    if (!a || typeof a.choice !== 'string' || !opcoes.includes(a.choice)) {
      throw new RouteError(`resposta invalida do JEV em '${nome}': ${JSON.stringify(a && a.choice)} nao esta em [${opcoes.join(', ')}]`);
    }
    if (typeof a.confidence !== 'number' || !(a.confidence >= 0 && a.confidence <= 1)) {
      throw new RouteError(`resposta invalida do JEV em '${nome}': confianca ${JSON.stringify(a.confidence)}`);
    }
    out[nome] = { choice: a.choice, confidence: a.confidence };
  }
  return out;
}

async function consultarJev({ resumo, modo, falhas, gate, causa, provedoresOferecidos, uso }) {
  // chave do .env da pasta de execucao entra no PROPRIO process.env (nada de argv/log); decisor proprio nao
  if (!process.env.RALPH_DECISOR_MODULE) {
    const cred = path.join(__dirname, 'jev-credential.js');
    if (fs.existsSync(cred)) require(cred).carregarChave();
  }
  const decidir = carregarDecisor();
  const state = {
    tarefa: 'escolher provedor, faixa de modelo e esforco para uma sessao de agente de codigo',
    modo: modo === 'verify' ? 'verificador independente (leitura, confere o codigo)' : 'implementacao',
    fase: {
      titulo: resumo.titulo, tasks_total: resumo.tasks_total, tasks: resumo.tasks,
      arquivos_total: resumo.arquivos_total, arquivos: resumo.arquivos, criterios: resumo.criterios,
      caracteres: resumo.caracteres, so_documentacao: resumo.so_documentacao, sinais: resumo.sinais, trecho: resumo.trecho
    },
    falhas_significativas: falhas,
    ...(falhas > 0 && (String(gate || '').trim() || String(causa || '').trim())
      ? { ultima_falha: { gate: limpar(gate, 80), causa: limparCauda(causa, 400) } } : {}),
    sessoes_recentes_por_provedor: uso,
    faixas: TIER_ORDER
  };
  const perguntas = {
    faixa: { type: 'choice', instructions: 'Qual a MENOR faixa de modelo suficiente para esta sessao? A maioria das tarefas e mais simples do que parece; suba so com razao concreta (risco, tamanho, falha repetida).', criteria: CRITERIOS_TIER },
    risco: { type: 'choice', instructions: 'O trabalho mexe em algo sensivel?', criteria: CRITERIOS_RISCO }
  };
  const esperadas = esperadasPara(provedoresOferecidos);
  if (provedoresOferecidos.length > 1) {
    perguntas.provedor = {
      type: 'choice',
      instructions: 'Qual provedor usar? Equilibre o uso entre os dois quando a qualidade esperada for equivalente; considere sessoes_recentes_por_provedor.',
      criteria: Object.fromEntries(provedoresOferecidos.map((p) => [p, CRITERIOS_PROVEDOR[p]]))
    };
  }
  if (JSON.stringify(state).length > 7000) throw new RouteError('resumo da fase passou do limite de 7000 caracteres (bug do roteador)');

  const salvo = process.env.HARNESS_DECISOR;
  process.env.HARNESS_DECISOR = 'jev'; // HARNESS_DECISOR do ambiente venceria a opcao: nada de Laya em silencio
  let r;
  try {
    r = await decidir(state, perguntas, { decisor: 'jev', timeoutMs: Number(process.env.RALPH_ROUTER_TIMEOUT_MS) || 30000 });
  } catch (e) {
    throw new RouteError('JEV indisponivel: ' + limpar(e && e.message || e, 200));
  } finally {
    if (salvo === undefined) delete process.env.HARNESS_DECISOR; else process.env.HARNESS_DECISOR = salvo;
  }
  const ans = validarResposta(r, esperadas);
  return {
    faixa: ans.faixa, risco: ans.risco, provedor: ans.provedor || null,
    tokens: r.usage && Number.isFinite(r.usage.input_tokens) ? r.usage.input_tokens : null
  };
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

function lerJson(arq, padrao) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}

function gravarCache(arq, chave, valor) {
  if (!arq) return;
  fs.mkdirSync(path.dirname(arq), { recursive: true });
  const c = lerJson(arq, {});
  c[chave] = valor;
  fs.writeFileSync(arq, JSON.stringify(c, null, 1));
}

function usoRecente(logArq) {
  const uso = { codex: 0, claude: 0 };
  if (!logArq || !fs.existsSync(logArq)) return uso;
  for (const l of fs.readFileSync(logArq, 'utf8').split('\n').slice(-200)) {
    try { const j = JSON.parse(l); if (j.provider in uso && j.cached === false && j.source === 'jev') uso[j.provider]++; } catch { /* linha ruim */ }
  }
  return uso;
}

// ---------------------------------------------------------------------------
// decisao
// ---------------------------------------------------------------------------

function aplicar({ bruto, resumo, modo, engine, permitidos, prevTier, falhas, override, fonte }) {
  const pisos = [];
  const exigencias = []; // toda exigencia de risco ativa, tenha ou nao subido a faixa
  let faixa = bruto.faixa.choice;
  const registrarPiso = (tier, motivo) => {
    exigencias.push(`${motivo} -> ${tier}`);
    if (rank(tier) > rank(faixa)) { pisos.push(`${motivo} -> ${tier}`); faixa = tier; }
  };
  // risco informado pelo JEV (com confianca) e piso objetivo local
  if (bruto.risco.choice !== 'none' && bruto.risco.confidence >= RISK_CONF_MIN) {
    registrarPiso(modo === 'verify' ? 'balanced' : 'high', `risco ${bruto.risco.choice} (conf ${bruto.risco.confidence.toFixed(2)})`);
  }
  const obj = pisoObjetivo(resumo);
  if (obj.motivo) registrarPiso(modo === 'verify' ? 'balanced' : 'high', obj.motivo);
  // verificador de trabalho sensivel nunca abaixo de balanced (acima ja vem do JEV)
  // depois de falha, a implementacao nunca desce de faixa
  if (modo === 'impl' && falhas > 0 && prevTier && TIER_ORDER.includes(prevTier)) registrarPiso(prevTier, `falha significativa: nao desce de ${prevTier}`);
  if (rank(faixa) > rank(TIER_ORDER[TIER_ORDER.length - 1])) faixa = TIER_ORDER[TIER_ORDER.length - 1]; // teto Sol/Opus

  let provider = bruto.provedor ? bruto.provedor.choice : permitidos[0];
  if (!permitidos.includes(provider)) throw new RouteError(`provedor '${provider}' fora do permitido (${permitidos.join(',')})`);

  let { model, effort } = TIERS[faixa][provider];
  let origem = fonte;
  if (override) {
    // modelo do verificador fixado pelo usuario: continua valendo o piso de risco
    if (!permitidos.includes(override.provider)) throw new RouteError(`modelo fixado '${override.model}' fora do provedor permitido`);
    if (rank(override.tier) < rank(faixa) && exigencias.length) {
      throw new RouteError(`RALPH_VERIFY_MODEL='${override.model}' esta abaixo do piso de risco (${faixa}) desta fase: ${exigencias.join('; ')}`);
    }
    provider = override.provider; model = override.model; effort = override.effort; faixa = override.tier; origem = 'override';
  }
  if (!MODELS[model] || MODELS[model].provider !== provider) throw new RouteError(`modelo '${model}' invalido para ${provider}`);
  if (effort !== null && !EFFORTS.includes(effort)) throw new RouteError(`esforco '${effort}' invalido`);

  return {
    provider, model, effort: effort || '', tier: faixa, mode: modo, engine, source: origem,
    reason: [
      origem === 'override' ? `modelo fixado por RALPH_VERIFY_MODEL (${model})` : `JEV: faixa ${bruto.faixa.choice} (${bruto.faixa.confidence.toFixed(2)})`,
      bruto.provedor ? `provedor ${bruto.provedor.choice} (${bruto.provedor.confidence.toFixed(2)})` : `provedor ${provider}${permitidos.length === 1 ? (engine === 'auto' ? ' (unico disponivel)' : ' (restrito por --engine)') : ' (padrao: primeiro permitido, sem decisao do JEV)'}`,
      `risco ${bruto.risco.choice}`,
      pisos.length ? 'pisos: ' + pisos.join('; ') : 'sem piso aplicado',
      `falhas ${falhas}`
    ].join(' | ')
  };
}

function brutoOffline() {
  const tier = process.env.RALPH_ROUTER_OFFLINE_TIER || 'balanced';
  if (!TIER_ORDER.includes(tier)) throw new RouteError(`RALPH_ROUTER_OFFLINE_TIER='${tier}' invalido`);
  return { faixa: { choice: tier, confidence: 1 }, risco: { choice: 'none', confidence: 1 }, provedor: null };
}

async function decidirSessao(o) {
  const permitidos = validarContexto(o.engine, o.available);
  const override = o.mode === 'verify' ? validarModeloVerificador(o.verifyModel, permitidos) : null;
  const resumo = resumirFase(o.phaseText);
  const falhas = Math.max(0, Number(o.failures) || 0);
  const oferecidos = permitidos;
  const offline = o.offline || process.env.RALPH_ROUTER_OFFLINE === '1';
  const base = { resumo, modo: o.mode, engine: o.engine, permitidos, prevTier: o.prevTier, falhas, override };

  let bruto; let fonte; let cached = false; let tokens = null;
  if (offline) {
    bruto = brutoOffline(); fonte = 'offline';
  } else {
    const chave = sha(JSON.stringify([POLICY_VERSION, 'jev', resumo.hash, o.mode, falhas, o.engine, [...permitidos].sort(), TIER_ORDER, Object.keys(MODELS)]));
    const hit = o.cache ? lerJson(o.cache, {})[chave] : null;
    let valido = null;
    if (hit) {
      // entrada corrompida ou de outra versao: descarta e reconsulta o JEV
      try {
        const a = validarAnswers(hit, esperadasPara(oferecidos));
        valido = { faixa: a.faixa, risco: a.risco, provedor: a.provedor || null };
        aplicar({ ...base, override: null, bruto: valido, fonte: 'jev' });
      } catch { valido = null; }
    }
    if (valido) {
      bruto = valido; fonte = 'jev'; cached = true;
    } else {
      try {
        const r = await consultarJev({ resumo, modo: o.mode, falhas, gate: o.gate, causa: o.cause, provedoresOferecidos: oferecidos, uso: usoRecente(o.log) });
        bruto = { faixa: r.faixa, risco: r.risco, provedor: r.provedor };
        tokens = r.tokens; fonte = 'jev';
        // valida antes de cachear: resposta invalida nao entra no cache
        aplicar({ ...base, bruto, fonte });
        gravarCache(o.cache, chave, bruto);
      } catch (e) {
        const alvo = process.env.RALPH_ROUTER_ON_FAIL || 'abort';
        if (alvo === 'abort' || !TIER_ORDER.includes(alvo)) {
          if (alvo !== 'abort' && !TIER_ORDER.includes(alvo)) throw new RouteError(`RALPH_ROUTER_ON_FAIL='${alvo}' invalido (abort|low|balanced|high); causa original: ${e.message}`);
          throw e;
        }
        bruto = { faixa: { choice: alvo, confidence: 1 }, risco: { choice: 'none', confidence: 1 }, provedor: null };
        fonte = 'fallback-explicito';
        const d = aplicar({ ...base, bruto, fonte });
        d.reason = `JEV falhou (${limpar(e.message, 160)}); RALPH_ROUTER_ON_FAIL=${alvo} | ` + d.reason.split(' | ').slice(1).join(' | ');
        d.cached = false;
        return registrar(o.log, d, resumo, tokens);
      }
    }
  }
  const d = aplicar({ ...base, bruto, fonte });
  if (cached) d.reason = d.reason.replace(/^JEV:/, 'JEV (cache):');
  if (fonte === 'offline') d.reason = 'OFFLINE (sem JEV, politica fixa ' + bruto.faixa.choice + ') | ' + d.reason.split(' | ').slice(1).join(' | ');
  d.cached = cached;
  return registrar(o.log, d, resumo, tokens);
}

function registrar(logArq, d, resumo, tokens) {
  if (logArq) {
    fs.mkdirSync(path.dirname(logArq), { recursive: true });
    fs.appendFileSync(logArq, JSON.stringify({ ts: new Date().toISOString(), fase: resumo.titulo, ...d, jev_tokens: tokens }) + '\n');
  }
  return d;
}

function formatar(d, fmt) {
  if (fmt === 'json') return JSON.stringify(d, null, 2);
  const un = (s) => String(s).replace(/[\r\n]+/g, ' ');
  return ['provider', 'model', 'effort', 'tier', 'source', 'cached', 'reason'].map((k) => `${k}=${un(d[k])}`).join('\n');
}

// ---------------------------------------------------------------------------
// preview
// ---------------------------------------------------------------------------

function fasesDoDocumento(texto) {
  const fases = []; let atual = null;
  for (const l of texto.replace(/\r/g, '').split('\n')) {
    if (/^## Phase \d+:/.test(l)) { atual = { titulo: l.replace(/^## /, ''), linhas: [l] }; fases.push(atual); }
    else if (/^## /.test(l)) atual = null;
    else if (atual) atual.linhas.push(l);
  }
  return fases.map((f) => ({ titulo: f.titulo, texto: f.linhas.join('\n') }));
}

async function preview(argv) {
  const arq = argv.find((a, i) => i > 0 && !a.startsWith('--') && !['--engine', '--available'].includes(argv[i - 1]));
  if (!arq || !fs.existsSync(arq)) throw new RouteError('uso: preview <arquivo-de-fases> [--engine E] [--available L] [--live]');
  const engine = arg(argv, 'engine', 'auto');
  const available = lista(arg(argv, 'available', 'codex,claude'));
  const live = flag(argv, 'live');
  const out = [live ? 'PREVIEW AO VIVO: cada fase consulta o JEV (resumo limitado, sem cache de run).' :
    'PREVIEW OFFLINE: SIMULACAO, nao e decisao do JEV. Politica fixa + pisos objetivos; nenhum agente nem rede.'];
  for (const f of fasesDoDocumento(fs.readFileSync(arq, 'utf8'))) {
    for (const modo of ['impl', 'verify']) {
      const d = await decidirSessao({ phaseText: f.texto, mode: modo, engine, available, failures: 0, offline: !live, cache: null, log: null });
      out.push(`${f.titulo} [${modo}] -> ${d.provider}/${d.model}${d.effort ? '/' + d.effort : ''} (faixa ${d.tier}; ${d.reason})`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'catalog') {
    console.log(JSON.stringify({ policy: POLICY_VERSION, tiers: TIERS, efforts: EFFORTS, standardMode: 'sem fast/priority' }, null, 2));
  } else if (cmd === 'check') {
    const permitidos = validarContexto(arg(argv, 'engine', 'auto'), lista(arg(argv, 'available', '')));
    validarModeloVerificador(arg(argv, 'verify-model', ''), permitidos);
    const offline = flag(argv, 'offline') || process.env.RALPH_ROUTER_OFFLINE === '1';
    if (!offline) {
      const p = caminhoDecisor();
      if (!fs.existsSync(p)) throw new RouteError(`decisor do harness-kit nao encontrado em ${p} (defina HARNESS_KIT=<raiz do kit>)`);
    }
    console.log('ok');
  } else if (cmd === 'decide') {
    const phase = arg(argv, 'phase');
    const mode = arg(argv, 'mode', 'impl');
    if (!phase || !fs.existsSync(phase)) throw new RouteError('--phase <arquivo> obrigatorio');
    if (!['impl', 'verify'].includes(mode)) throw new RouteError(`--mode invalido: ${mode}`);
    const causaArq = arg(argv, 'cause-file');
    const d = await decidirSessao({
      phaseText: fs.readFileSync(phase, 'utf8'), mode, engine: arg(argv, 'engine', 'auto'),
      available: lista(arg(argv, 'available', '')), failures: arg(argv, 'failures', 0), gate: arg(argv, 'gate', ''),
      cause: causaArq && fs.existsSync(causaArq) ? fs.readFileSync(causaArq, 'utf8') : '',
      prevTier: arg(argv, 'prev-tier', ''), verifyModel: arg(argv, 'verify-model', ''),
      cache: arg(argv, 'cache'), log: arg(argv, 'log'), offline: flag(argv, 'offline')
    });
    console.log(formatar(d, arg(argv, 'format', 'kv')));
  } else if (cmd === 'preview') {
    console.log(await preview(argv));
  } else {
    console.error('uso: ralph-route.js decide|check|preview|catalog (veja o cabecalho do arquivo)');
    process.exit(2);
  }
}

module.exports = { resumirFase, decidirSessao, validarModeloVerificador, TIERS, MODELS, RouteError };

if (require.main === module) {
  main().catch((e) => {
    console.error('ralph-route: ' + (e instanceof RouteError ? e.message : (e && e.stack) || e));
    process.exit(e instanceof RouteError ? 3 : 1);
  });
}
