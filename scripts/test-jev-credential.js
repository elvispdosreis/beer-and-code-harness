#!/usr/bin/env node
'use strict';

// test-jev-credential.js — testes OFFLINE do auxiliar de chave (scripts/jev-credential.js).
// Tudo em pastas temporarias com chaves FALSAS: nenhum .env real e lido ou gravado, sem rede.
// Uso: node scripts/test-jev-credential.js   (exit 0 = tudo verde)

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cred-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* melhor esforco */ } });

const { garantirChave, parseEnv, lerEnv, carregarChave } = require('./jev-credential.js');
const SCRIPT = path.join(__dirname, 'jev-credential.js');
const DUMMY = 'dummy-chave-de-teste-0123456789';
const ESTRANHA = 'ab#c=d"e\\f $(x) \'g';

let n = 0;
function pasta({ git = false, env } = {}) {
  const d = path.join(tmp, 'p' + (n++)); fs.mkdirSync(d);
  if (git) spawnSync('git', ['init', '-q'], { cwd: d });
  if (env !== undefined) fs.writeFileSync(path.join(d, '.env'), env);
  return d;
}
const lerArq = (d) => fs.readFileSync(path.join(d, '.env'), 'utf8');
// Terminal falso: conta perguntas; `resposta` e a chave digitada ('' = vazio/cancelado).
function terminal({ tty = true, resposta = DUMMY } = {}) {
  const t = { perguntas: [], interativo: () => tty, pedir: async (msg) => { t.perguntas.push(msg); return resposta; } };
  return t;
}
const rodar = (cwd, t, env = {}) => garantirChave({ env, cwd, terminal: t });
const ignorado = (d) => spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: d }).status === 0;

let verdes = 0; let falhas = 0;
async function caso(nome, fn) {
  try { await fn(); verdes++; console.log(`  ok   ${nome}`); } catch (e) { falhas++; console.log(`  FAIL ${nome}\n       ${(e && e.message || e).split('\n').join('\n       ')}`); }
}

(async () => {
  await caso('parser: comentarios, export, aspas, # e = no valor, sem eval/interpolacao', () => {
    const { valores } = parseEnv('﻿# c\n\nA=1\nexport B = "x # y=z"\nC=\'$(touch pwn) ${A}\'\nD=v # inline\r\nE="a\\"b\\\\c"\nF=\nlixo sem igual\n');
    assert.deepStrictEqual(valores, { A: '1', B: 'x # y=z', C: '$(touch pwn) ${A}', D: 'v', E: 'a"b\\c', F: '' });
  });

  await caso('ambiente tem precedencia: nao le o .env (nem ilegivel) e nao pergunta', async () => {
    const d = pasta(); fs.mkdirSync(path.join(d, '.env')); const t = terminal();
    const r = await rodar(d, t, { TYPESAFE_API_KEY: DUMMY });
    assert.deepStrictEqual([r.ok, r.origem, t.perguntas.length], [true, 'ambiente', 0]);
  });

  await caso('.env existente com chave: reuso sem prompt nem escrita; carregarChave poe no env', async () => {
    const d = pasta({ env: `X=1\nTYPESAFE_API_KEY=${DUMMY}\n` }); const t = terminal();
    const antes = lerArq(d);
    const r = await rodar(d, t);
    assert.deepStrictEqual([r.ok, r.origem, t.perguntas.length, lerArq(d)], [true, '.env', 0, antes]);
    const env = {}; assert.strictEqual(carregarChave({ env, cwd: d }), '.env'); assert.strictEqual(env.TYPESAFE_API_KEY, DUMMY);
    const outro = { TYPESAFE_API_KEY: 'do-ambiente' }; assert.strictEqual(carregarChave({ env: outro, cwd: d }), 'ambiente'); assert.strictEqual(outro.TYPESAFE_API_KEY, 'do-ambiente');
  });

  await caso('ausente + interativo: pergunta UMA vez, grava, preserva o resto e exclui o .env do git', async () => {
    const d = pasta({ git: true, env: '# meu env\nOUTRA=a#b\n\nQUE=ro=sene\n' }); const t = terminal({ resposta: ESTRANHA });
    const r = await rodar(d, t);
    assert.deepStrictEqual([r.ok, r.origem, r.salvou, t.perguntas.length], [true, '.env', true, 1]);
    assert.match(t.perguntas[0], /\.env/, 'informa o destino');
    assert.ok(lerArq(d).startsWith('# meu env\nOUTRA=a#b\n\nQUE=ro=sene\n'), 'conteudo anterior intacto');
    const { valores } = parseEnv(lerArq(d));
    assert.strictEqual(valores.TYPESAFE_API_KEY, ESTRANHA, 'ida e volta com #, =, aspas, barra e $()');
    assert.ok(ignorado(d), '.env ignorado pelo git');
    assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' }).stdout.trim(), '', 'git add -A nao pega o .env');
    assert.ok(!fs.existsSync(path.join(d, '.gitignore')), 'nao mexeu no .gitignore do projeto');
    assert.strictEqual((await rodar(d, terminal())).origem, '.env', 'segunda vez reaproveita');
  });

  await caso('linha TYPESAFE_API_KEY em branco e preenchida no lugar; CRLF preservado', async () => {
    const d = pasta({ env: 'A=1\r\nTYPESAFE_API_KEY=\r\nB=2\r\n' });
    await rodar(d, terminal());
    assert.strictEqual(lerArq(d), `A=1\r\nTYPESAFE_API_KEY="${DUMMY}"\r\nB=2\r\n`);
  });

  await caso('vazio/cancelado: erro e nenhum arquivo criado ou alterado', async () => {
    const d = pasta(); const r = await rodar(d, terminal({ resposta: '' }));
    assert.strictEqual(r.ok, false); assert.match(r.erro, /nada foi gravado/);
    assert.ok(!fs.existsSync(path.join(d, '.env')));
    const e = pasta({ env: 'A=1\nTYPESAFE_API_KEY=\n' }); await rodar(e, terminal({ resposta: '' }));
    assert.strictEqual(lerArq(e), 'A=1\nTYPESAFE_API_KEY=\n');
  });

  await caso('sem terminal: recusa com orientacao; ON_FAIL explicito segue; nada gravado', async () => {
    const d = pasta(); const t = terminal({ tty: false });
    const r = await rodar(d, t);
    assert.strictEqual(r.ok, false); assert.match(r.erro, /TYPESAFE_API_KEY/); assert.match(r.erro, /\.env/);
    const f = await rodar(d, t, { RALPH_ROUTER_ON_FAIL: 'low' });
    assert.deepStrictEqual([f.ok, f.origem], [true, 'fallback-explicito']);
    assert.deepStrictEqual([t.perguntas.length, fs.existsSync(path.join(d, '.env'))], [0, false]);
  });

  await caso('.env ilegivel: recusa sem perguntar nem sobrescrever', async () => {
    const d = pasta(); fs.mkdirSync(path.join(d, '.env')); const t = terminal();
    const r = await rodar(d, t);
    assert.strictEqual(r.ok, false); assert.match(r.erro, /nao pode ser lido/);
    assert.deepStrictEqual([t.perguntas.length, fs.statSync(path.join(d, '.env')).isDirectory()], [0, true]);
  });

  await caso('falha ao gravar: aborta claramente e nao deixa a chave no erro', async () => {
    const d = pasta(); fs.mkdirSync(path.join(d, `.env.${process.pid}.tmp`)); // o temporario nao pode ser criado
    const r = await rodar(d, terminal());
    assert.strictEqual(r.ok, false); assert.match(r.erro, /Nao foi possivel gravar/); assert.ok(!r.erro.includes(DUMMY));
    assert.ok(!fs.existsSync(path.join(d, '.env')));
  });

  await caso('.env rastreado: com chave reusa; sem chave recusa e nao grava nem pergunta', async () => {
    const d = pasta({ git: true, env: 'A=1\nTYPESAFE_API_KEY=\n' });
    spawnSync('git', ['add', '.env'], { cwd: d });
    const t = terminal(); const r = await rodar(d, t);
    assert.strictEqual(r.ok, false); assert.match(r.erro, /git rm --cached \.env/);
    assert.deepStrictEqual([t.perguntas.length, lerArq(d)], [0, 'A=1\nTYPESAFE_API_KEY=\n']);
    const e = pasta({ git: true, env: `TYPESAFE_API_KEY=${DUMMY}\n` }); spawnSync('git', ['add', '.env'], { cwd: e });
    assert.strictEqual((await rodar(e, terminal())).origem, '.env');
  });

  await caso('offline e decisor proprio: nunca leem o .env nem perguntam', async () => {
    const d = pasta(); fs.mkdirSync(path.join(d, '.env')); const t = terminal();
    assert.strictEqual((await rodar(d, t, { RALPH_ROUTER_OFFLINE: '1' })).origem, 'offline');
    assert.strictEqual((await rodar(d, t, { RALPH_DECISOR_MODULE: 'x.js' })).origem, 'decisor-proprio');
    assert.strictEqual(t.perguntas.length, 0);
  });

  await caso('CLI: ensure grava via terminal falso; chave nunca aparece em stdout/stderr/argv do status', () => {
    const d = pasta({ git: true });
    const mod = path.join(tmp, 'term.js'); fs.writeFileSync(mod, `exports.interativo = () => true; exports.pedir = async () => ${JSON.stringify(DUMMY)};\n`);
    const env = { ...process.env, RALPH_JEV_CREDENTIAL_MODULE: mod }; delete env.TYPESAFE_API_KEY;
    const r = spawnSync(process.execPath, [SCRIPT, 'ensure'], { cwd: d, env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr); assert.ok(!(r.stdout + r.stderr).includes(DUMMY));
    assert.match(r.stderr, /Chave salva no \.env/);
    const s = spawnSync(process.execPath, [SCRIPT, 'status'], { cwd: d, env, encoding: 'utf8' });
    assert.strictEqual(s.stdout.trim(), '.env'); assert.ok(!(s.stdout + s.stderr).includes(DUMMY));
    assert.strictEqual(lerEnv(d).chave, DUMMY);
  });

  await caso('CLI sem terminal: exit 1 com orientacao, sem travar', () => {
    const d = pasta(); const mod = path.join(tmp, 'notty.js'); fs.writeFileSync(mod, 'exports.interativo = () => false; exports.pedir = async () => { throw new Error("nao pergunta"); };\n');
    const env = { ...process.env, RALPH_JEV_CREDENTIAL_MODULE: mod }; delete env.TYPESAFE_API_KEY; delete env.RALPH_ROUTER_ON_FAIL;
    const r = spawnSync(process.execPath, [SCRIPT, 'ensure'], { cwd: d, env, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 1); assert.match(r.stderr, /TYPESAFE_API_KEY/);
  });

  console.log(falhas === 0 ? `\nTODOS VERDES: ${verdes} casos do auxiliar de chave` : `\nFALHAS: ${falhas} / verdes: ${verdes}`);
  process.exit(falhas === 0 ? 0 : 1);
})();
