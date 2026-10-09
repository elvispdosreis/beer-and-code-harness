#!/usr/bin/env node
'use strict';

// test-ralph-route.js — testes OFFLINE do roteador (scripts/ralph-route.js).
//
// Nenhuma rede, nenhum agente, nenhum token: o decisor do harness-kit e trocado
// por um modulo falso (RALPH_DECISOR_MODULE) que responde o que o teste manda.
// A integracao com o ralph.sh de verdade fica em scripts/test-ralph.sh.
//
// Uso: node scripts/test-ralph-route.js   (exit 0 = tudo verde)

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-route-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* melhor esforco */ } });

// Decisor falso: delega para global.__jev (conta chamadas, devolve o programado).
const fakeMod = path.join(tmp, 'decisor.js');
fs.writeFileSync(fakeMod, "exports.decidir = (s, q, o) => global.__jev(s, q, o);\n");
process.env.RALPH_DECISOR_MODULE = fakeMod;
for (const k of ['RALPH_ROUTER_ON_FAIL', 'RALPH_ROUTER_OFFLINE', 'RALPH_ROUTER_OFFLINE_TIER', 'HARNESS_DECISOR']) delete process.env[k];

const { decidirSessao, resumirFase, MODELS, TIERS, RouteError } = require('./ralph-route.js');

let calls = [];
function programar({ faixa = 'balanced', risco = 'none', provedor = 'codex', raw } = {}) {
  calls = [];
  global.__jev = async (state, questions, opts) => {
    calls.push({ state, questions, opts, harnessDecisor: process.env.HARNESS_DECISOR });
    if (raw) return typeof raw === 'function' ? raw(state, questions) : raw;
    const answers = { faixa: { choice: faixa, confidence: 0.9 }, risco: { choice: risco, confidence: 0.9 } };
    if (questions.provedor) answers.provedor = { choice: provedor, confidence: 0.8 };
    return { provedor: 'jev', answers, usage: { input_tokens: 10 } };
  };
}

const FASE_SIMPLES = '## Phase 1: Doc\n\n- [ ] **Task:** ajusta o texto do README.md\n  - **Acceptance criteria:**\n    - texto atualizado\n';
const FASE_TOKEN_ECONOMY = '## Phase 1: Token economy\n\n- [ ] **Task:** documenta a token economy e o lockfile em README.md (schema do worker so descrito)\n  - **Acceptance criteria:**\n    - README.md explica o gasto de tokens\n';
const FASE_AUTH = '## Phase 1: Login\n\n- [ ] **Task:** autenticacao com jwt em src/auth.ts\n  - **Acceptance criteria:**\n    - rota protegida\n';
const FASE_CODIGO = '## Phase 1: Codigo\n\n- [ ] **Task:** cria a funcao soma em src/soma.ts\n  - **Acceptance criteria:**\n    - teste passa\n';

const base = (extra) => ({ phaseText: FASE_CODIGO, mode: 'impl', engine: 'auto', available: ['codex', 'claude'], failures: 0, ...extra });

let verdes = 0; let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); verdes++; console.log(`  ok   ${nome}`); } catch (e) { falhas++; console.log(`  FAIL ${nome}\n       ${(e && e.message || e).split('\n').join('\n       ')}`); }
}
const rejeita = async (p, re, msg) => {
  let err = null;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, msg + ' (nao falhou)');
  assert.ok(err instanceof RouteError, msg + ' (erro nao tipado: ' + (err && err.stack) + ')');
  if (re) assert.match(err.message, re, msg);
};

(async () => {
  await caso('catalogo: so Luna/Sol/6.1-Sol e haiku/sonnet/opus; sem fast/priority', () => {
    assert.deepStrictEqual(Object.keys(MODELS).sort(), ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'haiku', 'opus', 'sonnet']);
    assert.strictEqual(TIERS.high.codex.model, 'gpt-6.1-sol');
    assert.strictEqual(TIERS.high.claude.model, 'opus');
    assert.strictEqual(TIERS.low.claude.effort, null, 'haiku nao recebe esforco');
    assert.ok(!/fast|priority/i.test(JSON.stringify(TIERS)));
    for (const t of Object.values(TIERS)) for (const c of Object.values(t)) assert.ok(c.effort === null || ['low', 'medium', 'high'].includes(c.effort));
  });

  await caso('faixas -> modelo/esforco por provedor', async () => {
    const esperado = { low: ['gpt-6-luna', 'low'], balanced: ['gpt-6-sol', 'medium'], high: ['gpt-6.1-sol', 'high'] };
    for (const [faixa, [model, effort]] of Object.entries(esperado)) {
      programar({ faixa, provedor: 'codex' });
      const d = await decidirSessao(base({ phaseText: FASE_SIMPLES }));
      assert.strictEqual(d.provider, 'codex'); assert.strictEqual(d.model, model); assert.strictEqual(d.effort, effort); assert.strictEqual(d.source, 'jev');
    }
    const claude = { low: ['haiku', ''], balanced: ['sonnet', 'medium'], high: ['opus', 'high'] };
    for (const [faixa, [model, effort]] of Object.entries(claude)) {
      programar({ faixa, provedor: 'claude' });
      const d = await decidirSessao(base({ phaseText: FASE_SIMPLES }));
      assert.strictEqual(d.provider, 'claude'); assert.strictEqual(d.model, model); assert.strictEqual(d.effort, effort);
    }
  });

  await caso('JEV forcado: decisor=jev, HARNESS_DECISOR=jev durante a chamada e restaurado depois', async () => {
    process.env.HARNESS_DECISOR = 'laya';
    programar();
    await decidirSessao(base());
    assert.strictEqual(calls[0].opts.decisor, 'jev');
    assert.strictEqual(calls[0].harnessDecisor, 'jev');
    assert.strictEqual(process.env.HARNESS_DECISOR, 'laya');
    delete process.env.HARNESS_DECISOR;
  });

  await caso('resumo enviado ao JEV e pequeno e sem segredo', async () => {
    programar();
    const texto = FASE_CODIGO + '\napi_key = sk-abcdefghijklmnopqrstuvwxyz123456\nAKIAABCDEFGHIJKLMNOP\n' + 'x'.repeat(50000);
    await decidirSessao(base({ phaseText: texto }));
    const s = JSON.stringify(calls[0].state);
    assert.ok(s.length <= 7000, 'resumo grande: ' + s.length);
    assert.ok(!/sk-abcdefghijkl|AKIAABCDEFGHIJKLMNOP/.test(s), 'segredo vazou no resumo');
  });

  await caso('so o CLI instalado e oferecido ao JEV; sem CLI => erro tipado', async () => {
    programar({ provedor: 'claude' });
    const d = await decidirSessao(base({ available: ['claude'] }));
    assert.strictEqual(d.provider, 'claude');
    assert.strictEqual(calls[0].questions.provedor, undefined, 'nao deve perguntar provedor quando so um existe');
    programar();
    await decidirSessao(base({ available: ['codex', 'claude'] }));
    assert.deepStrictEqual(Object.keys(calls[0].questions.provedor.criteria).sort(), ['claude', 'codex']);
    await rejeita(decidirSessao(base({ available: [] })), /nenhum CLI/, 'sem CLI');
    await rejeita(decidirSessao(base({ engine: 'claude', available: ['codex'] })), /nao esta disponivel/, 'engine sem CLI');
    await rejeita(decidirSessao(base({ engine: 'gemini' })), /engine invalida/, 'engine fora do catalogo');
  });

  await caso('--engine explicito restringe o provedor mesmo se o JEV preferir o outro', async () => {
    programar({ provedor: 'codex' });
    const d = await decidirSessao(base({ engine: 'claude' }));
    assert.strictEqual(d.provider, 'claude');
    assert.strictEqual(calls[0].questions.provedor, undefined);
  });

  await caso('resposta invalida do JEV => falha fechada (faixa, provedor, confianca, origem, vazio)', async () => {
    const ruins = {
      'faixa fora do catalogo': { faixa: 'ultra' },
      'provedor fora do permitido': { provedor: 'gemini' },
      'risco invalido': { risco: 'catastrofe' }
    };
    for (const [nome, ov] of Object.entries(ruins)) {
      programar(ov);
      await rejeita(decidirSessao(base()), /resposta invalida/, nome);
    }
    programar({ raw: (s, q) => ({ provedor: 'jev', answers: { faixa: { choice: 'low', confidence: 7 }, risco: { choice: 'none', confidence: 1 }, provedor: { choice: 'codex', confidence: 1 } } }) });
    await rejeita(decidirSessao(base()), /confianca/, 'confianca fora de 0..1');
    programar({ raw: { provedor: 'laya', answers: {} } });
    await rejeita(decidirSessao(base()), /nao veio do JEV/, 'resposta da Laya');
    programar({ raw: {} });
    await rejeita(decidirSessao(base()), /sem answers/, 'resposta vazia');
    global.__jev = async () => { throw new Error('jev: sem TYPESAFE_API_KEY'); };
    await rejeita(decidirSessao(base()), /JEV indisponivel/, 'JEV fora do ar');
  });

  await caso('fallback so por opt-in explicito e rotulado como tal', async () => {
    global.__jev = async () => { throw new Error('jev: sem TYPESAFE_API_KEY'); };
    process.env.RALPH_ROUTER_ON_FAIL = 'low';
    const d = await decidirSessao(base({ phaseText: FASE_SIMPLES }));
    assert.strictEqual(d.source, 'fallback-explicito'); assert.strictEqual(d.tier, 'low'); assert.match(d.reason, /JEV falhou/);
    process.env.RALPH_ROUTER_ON_FAIL = 'ultra';
    await rejeita(decidirSessao(base()), /RALPH_ROUTER_ON_FAIL/, 'valor invalido do fallback');
    delete process.env.RALPH_ROUTER_ON_FAIL;
    process.env.RALPH_ROUTER_OFFLINE = '1';
    const o = await decidirSessao(base({ phaseText: FASE_SIMPLES }));
    assert.strictEqual(o.source, 'offline'); assert.match(o.reason, /^OFFLINE/);
    delete process.env.RALPH_ROUTER_OFFLINE;
  });

  await caso('piso de risco: seguranca real sobe para high (impl) / balanced (verify)', async () => {
    programar({ faixa: 'low' });
    const d = await decidirSessao(base({ phaseText: FASE_AUTH }));
    assert.strictEqual(d.tier, 'high'); assert.match(d.reason, /sinais objetivos: seguranca/);
    const v = await decidirSessao(base({ phaseText: FASE_AUTH, mode: 'verify' }));
    assert.strictEqual(v.tier, 'balanced');
    programar({ faixa: 'low', risco: 'data_loss' });
    assert.strictEqual((await decidirSessao(base({ phaseText: FASE_SIMPLES }))).tier, 'high');
    assert.strictEqual((await decidirSessao(base({ phaseText: FASE_SIMPLES, mode: 'verify' }))).tier, 'balanced');
  });

  await caso('documentacao de token economy/lockfile/schema/worker NAO forca o modelo mais caro', async () => {
    programar({ faixa: 'low' });
    const r = resumirFase(FASE_TOKEN_ECONOMY);
    assert.strictEqual(r.so_documentacao, true);
    assert.strictEqual(r.sinais.seguranca, false, 'token solto nao e seguranca');
    assert.strictEqual(r.sinais.distribuido, false, 'lockfile/worker nao sao distribuido');
    assert.strictEqual(r.sinais.migracao, false, 'schema solto nao e migracao');
    const d = await decidirSessao(base({ phaseText: FASE_TOKEN_ECONOMY }));
    assert.strictEqual(d.tier, 'low'); assert.strictEqual(d.model, 'gpt-6-luna');
    // o que e real continua valendo
    assert.strictEqual(resumirFase('mudanca de schema do banco: ALTER TABLE users').sinais.migracao, true);
    assert.strictEqual(resumirFase('usa um api token e bearer no header').sinais.seguranca, true);
    assert.strictEqual(resumirFase('fila com workers e deadlock').sinais.distribuido, true);
    // doc sobre concorrencia: ignora arquitetura/distribuido, mas seguranca e migracao seguem
    programar({ faixa: 'low' });
    const doc = await decidirSessao(base({ phaseText: '## Phase 1: Doc\n\n- [ ] **Task:** explica a fila e o lock em README.md\n' }));
    assert.strictEqual(doc.tier, 'low');
    const docSeg = await decidirSessao(base({ phaseText: '## Phase 1: Doc\n\n- [ ] **Task:** documenta a autenticacao em README.md\n' }));
    assert.strictEqual(docSeg.tier, 'high');
  });

  await caso('falha significativa: sobe conforme o JEV, nunca desce e nunca passa de Sol/Opus', async () => {
    programar({ faixa: 'low' });
    const d = await decidirSessao(base({ failures: 1, prevTier: 'balanced' }));
    assert.strictEqual(d.tier, 'balanced'); assert.match(d.reason, /nao desce/);
    programar({ faixa: 'high' });
    const e = await decidirSessao(base({ failures: 5, prevTier: 'high' }));
    assert.strictEqual(e.tier, 'high'); assert.strictEqual(e.model, 'gpt-6.1-sol');
    programar({ faixa: 'ultra' });
    await rejeita(decidirSessao(base({ failures: 5 })), /resposta invalida/, 'JEV nao pode pedir faixa acima do teto');
  });

  await caso('RALPH_VERIFY_MODEL: fora do catalogo / provedor ausente => erro; dentro do catalogo vale', async () => {
    programar();
    for (const m of ['gpt-6-fast', 'gpt-7', 'opus-max', 'astra', 'fable', 'gpt-6.1-sol-priority']) {
      await rejeita(decidirSessao(base({ mode: 'verify', verifyModel: m })), /fora do catalogo/, m);
    }
    await rejeita(decidirSessao(base({ mode: 'verify', engine: 'codex', available: ['codex'], verifyModel: 'opus' })), /fora do permitido/, 'opus em engine codex');
    await rejeita(decidirSessao(base({ mode: 'verify', available: ['codex'], verifyModel: 'sonnet' })), /fora do permitido/, 'sonnet sem claude instalado');
    programar({ faixa: 'balanced' });
    const d = await decidirSessao(base({ mode: 'verify', verifyModel: 'haiku', phaseText: FASE_SIMPLES }));
    assert.strictEqual(d.model, 'haiku'); assert.strictEqual(d.source, 'override'); assert.strictEqual(d.provider, 'claude');
    // override so vale no verificador
    const i = await decidirSessao(base({ mode: 'impl', verifyModel: 'haiku', phaseText: FASE_SIMPLES }));
    assert.notStrictEqual(i.source, 'override');
  });

  await caso('override NAO fura o piso de risco, mesmo com o JEV ja em high (bug P1 da revisao)', async () => {
    programar({ faixa: 'high', risco: 'security' });
    await rejeita(decidirSessao(base({ mode: 'verify', verifyModel: 'gpt-6-luna', phaseText: FASE_SIMPLES })), /abaixo do piso de risco/, 'high+security+luna');
    await rejeita(decidirSessao(base({ mode: 'verify', verifyModel: 'haiku', phaseText: FASE_SIMPLES })), /abaixo do piso de risco/, 'high+security+haiku');
    // piso objetivo (texto de auth) com JEV em high tambem
    programar({ faixa: 'high', risco: 'none' });
    await rejeita(decidirSessao(base({ mode: 'verify', verifyModel: 'haiku', phaseText: FASE_AUTH })), /abaixo do piso de risco/, 'high+auth no texto');
    // sem risco ativo, o usuario manda no modelo barato
    programar({ faixa: 'high', risco: 'none' });
    const ok = await decidirSessao(base({ mode: 'verify', verifyModel: 'haiku', phaseText: FASE_SIMPLES }));
    assert.strictEqual(ok.model, 'haiku');
    // risco ativo e override no proprio patamar exigido passa
    programar({ faixa: 'low', risco: 'security' });
    const bal = await decidirSessao(base({ mode: 'verify', verifyModel: 'sonnet', phaseText: FASE_SIMPLES }));
    assert.strictEqual(bal.model, 'sonnet');
  });

  await caso('cache: decisao identica nao chama o JEV de novo; falha/modo/fase diferentes chamam', async () => {
    const cache = path.join(tmp, 'c1.json');
    programar({ faixa: 'balanced' });
    const a = await decidirSessao(base({ cache }));
    const b = await decidirSessao(base({ cache }));
    assert.strictEqual(calls.length, 1); assert.strictEqual(a.cached, false); assert.strictEqual(b.cached, true);
    assert.match(b.reason, /JEV \(cache\)/);
    assert.strictEqual(b.model, a.model);
    await decidirSessao(base({ cache, failures: 1 }));
    await decidirSessao(base({ cache, mode: 'verify' }));
    await decidirSessao(base({ cache, phaseText: FASE_SIMPLES }));
    assert.strictEqual(calls.length, 4);
  });

  await caso('cache: entrada corrompida ou de outra politica e descartada e reconsultada', async () => {
    const corruptos = {
      'faixa fora do catalogo': (e) => { e.faixa.choice = 'ultra'; },
      'confianca invalida': (e) => { e.faixa.confidence = 'alta'; },
      'risco ausente': (e) => { delete e.risco; },
      'provedor fora do permitido': (e) => { e.provedor = { choice: 'gemini', confidence: 0.9 }; },
      'forma errada': (e) => { for (const k of Object.keys(e)) delete e[k]; e.faixa = 'high'; e.risco = 'none'; }
    };
    for (const [nome, estraga] of Object.entries(corruptos)) {
      const cache = path.join(tmp, `c-${nome.replace(/\W+/g, '_')}.json`);
      programar({ faixa: 'balanced' });
      await decidirSessao(base({ cache }));
      const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
      const chave = Object.keys(c)[0];
      estraga(c[chave]);
      fs.writeFileSync(cache, JSON.stringify(c));
      programar({ faixa: 'balanced' });
      const d = await decidirSessao(base({ cache }));
      assert.strictEqual(calls.length, 1, nome + ': deveria reconsultar o JEV');
      assert.strictEqual(d.cached, false, nome);
      // o cache foi reparado: a proxima chamada ja acerta
      const e2 = await decidirSessao(base({ cache }));
      assert.strictEqual(e2.cached, true, nome + ': cache reparado');
    }
    // arquivo de cache ilegivel tambem nao quebra nem engana
    const lixo = path.join(tmp, 'lixo.json'); fs.writeFileSync(lixo, '{nao e json');
    programar();
    assert.strictEqual((await decidirSessao(base({ cache: lixo }))).cached, false);
  });

  await caso('cache nunca guarda resposta invalida; nunca serve tier que o piso nao aceita', async () => {
    const cache = path.join(tmp, 'c2.json');
    programar({ faixa: 'ultra' });
    await rejeita(decidirSessao(base({ cache })), /resposta invalida/, 'invalida');
    assert.ok(!fs.existsSync(cache) || Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8'))).length === 0, 'resposta invalida entrou no cache');
    // hit de cache continua sujeito ao piso de risco e ao override
    programar({ faixa: 'high', risco: 'security' });
    await decidirSessao(base({ cache, mode: 'verify', phaseText: FASE_SIMPLES }));
    await rejeita(decidirSessao(base({ cache, mode: 'verify', phaseText: FASE_SIMPLES, verifyModel: 'gpt-6-luna' })), /abaixo do piso de risco/, 'override apos cache');
    assert.strictEqual(calls.length, 1, 'override rejeitado nao deve custar chamada extra');
  });

  await caso('offline com dois provedores: motivo nunca diz "unico disponivel"; com um so, mantem', async () => {
    process.env.RALPH_ROUTER_OFFLINE = '1';
    const dois = await decidirSessao(base());
    delete process.env.RALPH_ROUTER_OFFLINE;
    assert.strictEqual(dois.provider, 'codex');
    assert.ok(!/unico disponivel/.test(dois.reason), dois.reason);
    assert.match(dois.reason, /padrao: primeiro permitido/);
    process.env.RALPH_ROUTER_OFFLINE = '1';
    const um = await decidirSessao(base({ available: ['claude'] }));
    delete process.env.RALPH_ROUTER_OFFLINE;
    assert.match(um.reason, /provedor claude \(unico disponivel\)/);
  });

  await caso('contexto de falha ao JEV: cabecalho + cauda em <=400 chars; vazio some; falhas preservadas', async () => {
    const causa = 'Gate 3 vermelho: testes\n' + 'ruido de teste '.repeat(200) + '\nERRO FINAL: expected 3 got 4';
    programar();
    await decidirSessao(base({ failures: 2, prevTier: 'balanced', gate: 'tests', cause: causa }));
    const f = calls[0].state;
    assert.strictEqual(f.falhas_significativas, 2);
    assert.ok(f.ultima_falha.causa.length <= 401, 'tamanho ' + f.ultima_falha.causa.length);
    assert.match(f.ultima_falha.causa, /^Gate 3 vermelho: testes/);
    assert.match(f.ultima_falha.causa, /ERRO FINAL: expected 3 got 4$/);
    programar();
    await decidirSessao(base({ failures: 2, prevTier: 'balanced', gate: '', cause: '  ' }));
    assert.ok(!('ultima_falha' in calls[0].state), 'sem gate/causa nao envia ultima_falha');
    assert.strictEqual(calls[0].state.falhas_significativas, 2);
  });

  await caso('log de auditoria (routes.jsonl): provedor, modelo, esforco, fonte e motivo', async () => {
    const log = path.join(tmp, 'routes.jsonl');
    programar({ faixa: 'high', provedor: 'claude' });
    await decidirSessao(base({ log }));
    const l = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
    assert.strictEqual(l.provider, 'claude'); assert.strictEqual(l.model, 'opus'); assert.strictEqual(l.effort, 'high');
    assert.strictEqual(l.source, 'jev'); assert.ok(l.reason && l.fase && l.ts);
  });

  // Roteador de verdade (processo filho) + kit falso em HARNESS_KIT: o decisor anota a chave que viu.
  const { spawnSync } = require('child_process');
  const ROTEADOR = path.join(__dirname, 'ralph-route.js');
  const kit = path.join(tmp, 'kit'); fs.mkdirSync(path.join(kit, 'scripts'), { recursive: true });
  const visto = path.join(tmp, 'visto.txt');
  const decisorTxt = (prefixo) => [
    "exports.decidir = async (s, q) => {",
    "  require('fs').appendFileSync(" + JSON.stringify(visto) + ", " + JSON.stringify(prefixo) + " + String(process.env.TYPESAFE_API_KEY) + '\\n');",
    "  const a = { faixa: { choice: 'low', confidence: 0.9 }, risco: { choice: 'none', confidence: 0.9 } };",
    "  if (q.provedor) a.provedor = { choice: 'codex', confidence: 0.9 };",
    "  return { provedor: 'jev', answers: a };",
    "};"].join('\n');
  fs.writeFileSync(path.join(kit, 'scripts', 'decisor.js'), decisorTxt(''));
  const faseArq = path.join(tmp, 'fase.md'); fs.writeFileSync(faseArq, FASE_SIMPLES);
  const filho = (cwd, extra = {}, args = []) => {
    const env = { ...process.env, HARNESS_KIT: kit, ...extra };
    for (const k of ['RALPH_DECISOR_MODULE', 'RALPH_ROUTER_OFFLINE', 'RALPH_ROUTER_ON_FAIL', 'HARNESS_DECISOR']) if (!(k in extra)) delete env[k];
    if (!('TYPESAFE_API_KEY' in extra)) delete env.TYPESAFE_API_KEY;
    return spawnSync(process.execPath, [ROTEADOR, 'decide', '--phase', faseArq, '--mode', 'impl', '--engine', 'codex', '--available', 'codex', ...args], { cwd, env, encoding: 'utf8' });
  };
  const vistas = () => (fs.existsSync(visto) ? fs.readFileSync(visto, 'utf8').trim().split(/\r?\n/) : []);
  const limparVisto = () => { try { fs.unlinkSync(visto); } catch { /* ainda nao existe */ } };

  await caso('chave do .env da pasta de execucao chega ao decisor do kit (sem argv, sem log)', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'cwd-')); const log = path.join(tmp, 'rotas.jsonl');
    fs.writeFileSync(path.join(d, '.env'), `OUTRA=x
TYPESAFE_API_KEY="chave-falsa#1=2"
`);
    limparVisto();
    const r = filho(d, {}, ['--log', log]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(vistas(), ['chave-falsa#1=2']);
    assert.ok(!(r.stdout + r.stderr + fs.readFileSync(log, 'utf8')).includes('chave-falsa'), 'chave fora de saida e log');
  });

  await caso('ambiente vence o .env; sem chave em lugar nenhum o decisor ve vazio (falha fica com o JEV)', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'cwd-')); fs.writeFileSync(path.join(d, '.env'), `TYPESAFE_API_KEY=do-arquivo
`);
    limparVisto(); filho(d, { TYPESAFE_API_KEY: 'do-ambiente' });
    assert.deepStrictEqual(vistas(), ['do-ambiente']);
    const vazio = fs.mkdtempSync(path.join(tmp, 'cwd-')); limparVisto(); filho(vazio);
    assert.deepStrictEqual(vistas(), ['undefined']);
  });

  await caso('offline e decisor proprio nao leem o .env', () => {
    const d = fs.mkdtempSync(path.join(tmp, 'cwd-')); fs.writeFileSync(path.join(d, '.env'), `TYPESAFE_API_KEY=nao-deve-ler
`);
    limparVisto(); const r = filho(d, { RALPH_ROUTER_OFFLINE: '1' });
    assert.strictEqual(r.status, 0, r.stderr); assert.deepStrictEqual(vistas(), [], 'offline nem chama o decisor');
    const proprio = path.join(tmp, 'proprio.js'); fs.writeFileSync(proprio, decisorTxt('proprio:')); // decisor proprio
    limparVisto(); const r2 = filho(d, { RALPH_DECISOR_MODULE: proprio });
    assert.strictEqual(r2.status, 0, r2.stderr); assert.deepStrictEqual(vistas(), ['proprio:undefined']);
  });

  console.log(falhas === 0 ? `\nTODOS VERDES: ${verdes} casos do roteador` : `\nFALHAS: ${falhas} / verdes: ${verdes}`);
  process.exit(falhas === 0 ? 0 : 1);
})();
