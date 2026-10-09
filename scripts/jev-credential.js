#!/usr/bin/env node
'use strict';

// jev-credential.js — garante a chave do JEV (TYPESAFE_API_KEY) antes do ralph.sh gastar uma sessao.
// Ordem: 1. ambiente; 2. .env na pasta de execucao (raiz do projeto); 3. ausente + terminal
// interativo => pergunta UMA vez (entrada oculta) e grava no .env em texto puro (decisao do dono),
// depois de por o .env em .git/info/exclude. Parser proprio, sem source/eval; nunca imprime a chave.
// Uso: node jev-credential.js ensure|status  (status: ambiente|.env|ausente|ilegivel, sem valor).
// O roteador chama carregarChave() para trazer a chave do .env ao PROPRIO process.env.
// RALPH_ROUTER_OFFLINE=1 e RALPH_DECISOR_MODULE nao perguntam; RALPH_ROUTER_ON_FAIL=<faixa> mantem o
// fallback sem terminal; RALPH_JEV_CREDENTIAL_MODULE={interativo(),pedir()} troca o terminal (testes).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Writable } = require('stream');
const { spawnSync } = require('child_process');
const CHAVE = 'TYPESAFE_API_KEY';
const TIERS = ['low', 'balanced', 'high'];
const RE_LINHA = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function valorDe(bruto) {
  const q = bruto[0];
  if (q === '"' || q === "'") {
    let out = '';
    for (let i = 1; i < bruto.length; i++) {
      const c = bruto[i];
      if (c === q) return out;
      if (q === '"' && c === '\\' && (bruto[i + 1] === '\\' || bruto[i + 1] === '"')) { out += bruto[++i]; continue; }
      out += c;
    }
    return out;
  }
  return bruto.replace(/\s+#.*$/, '').trim();
}
// -> { valores, linha } ; linha = indice da ultima linha de TYPESAFE_API_KEY (-1 se nao ha)
function parseEnv(texto) {
  const valores = {}; let linha = -1;
  String(texto).replace(/^﻿/, '').split(/\r?\n/).forEach((l, i) => {
    if (/^\s*(#|$)/.test(l)) return;
    const m = RE_LINHA.exec(l);
    if (!m) return;
    valores[m[1]] = valorDe(m[2].trim());
    if (m[1] === CHAVE) linha = i;
  });
  return { valores, linha };
}
// -> { estado: 'ok'|'ausente'|'vazia'|'ilegivel', chave?, texto, linha }
function lerEnv(cwd) {
  let texto;
  try { texto = fs.readFileSync(path.join(cwd, '.env'), 'utf8'); } catch (e) {
    return { estado: e.code === 'ENOENT' ? 'ausente' : 'ilegivel', texto: '', linha: -1 };
  }
  const { valores, linha } = parseEnv(texto);
  const chave = (valores[CHAVE] || '').trim();
  return { estado: chave ? 'ok' : 'vazia', chave, texto, linha };
}
// Traz a chave do .env para o process.env de quem chama (o roteador). Ambiente vence.
function carregarChave({ env = process.env, cwd = process.cwd() } = {}) {
  if ((env[CHAVE] || '').trim()) return 'ambiente';
  const r = lerEnv(cwd);
  if (r.estado !== 'ok') return null;
  env[CHAVE] = r.chave;
  return '.env';
}
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true });

// .env fora do git ANTES de gravar: 'rastreado' | 'ok' | 'falhou'
function protegerEnv(cwd) {
  if (git(cwd, 'ls-files', '--error-unmatch', '.env').status === 0) return 'rastreado';
  const gd = git(cwd, 'rev-parse', '--git-dir');
  if (gd.status !== 0) return 'ok'; // fora de repo: nada a proteger
  if (git(cwd, 'check-ignore', '-q', '.env').status === 0) return 'ok';
  try {
    const exc = path.resolve(cwd, gd.stdout.trim(), 'info', 'exclude');
    fs.mkdirSync(path.dirname(exc), { recursive: true });
    fs.appendFileSync(exc, (fs.existsSync(exc) && !/\n$/.test(fs.readFileSync(exc, 'utf8')) ? '\n' : '') + '/.env\n');
  } catch { return 'falhou'; }
  return git(cwd, 'check-ignore', '-q', '.env').status === 0 ? 'ok' : 'falhou';
}
// Preenche a linha vazia de TYPESAFE_API_KEY ou acrescenta; o resto do arquivo fica intacto.
function gravarChave(cwd, r, chave) {
  const eol = r.texto.includes('\r\n') ? '\r\n' : '\n';
  const nova = `${CHAVE}="${chave.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const linhas = r.texto.split(/\r?\n/);
  if (r.linha >= 0) linhas[r.linha] = nova;
  else { if (linhas[linhas.length - 1] === '') linhas.pop(); linhas.push(nova, ''); }
  const alvo = path.join(cwd, '.env'); const tmp = `${alvo}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, linhas.join(eol), { mode: 0o600 }); fs.renameSync(tmp, alvo); return true; } catch {
    try { fs.unlinkSync(tmp); } catch { /* sem tmp */ }
    return false;
  }
}
function pedirOculto(msg) {
  return new Promise((resolve) => {
    const mudo = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output: mudo, terminal: true });
    let lido = false; process.stderr.write(msg);
    rl.question('', (r) => { lido = true; rl.close(); process.stderr.write('\n'); resolve(r.trim()); });
    rl.on('close', () => { if (!lido) { process.stderr.write('\n'); resolve(''); } }); // EOF = cancelar
  });
}
const terminalPadrao = {
  interativo: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
  pedir: pedirOculto
};

// -> { ok, origem, aviso?, erro?, salvou? }
async function garantirChave({ env = process.env, cwd = process.cwd(), terminal = terminalPadrao } = {}) {
  if (env.RALPH_ROUTER_OFFLINE === '1') return { ok: true, origem: 'offline' };
  if (env.RALPH_DECISOR_MODULE) return { ok: true, origem: 'decisor-proprio' };
  if ((env[CHAVE] || '').trim()) return { ok: true, origem: 'ambiente' };
  const r = lerEnv(cwd);
  if (r.estado === 'ilegivel') return { ok: false, erro: `O .env existe mas nao pode ser lido (${path.join(cwd, '.env')}); nada foi alterado. Corrija a permissao ou defina ${CHAVE} no ambiente.` };
  if (r.estado === 'ok') return { ok: true, origem: '.env' };
  const orientacao = `Defina ${CHAVE} no ambiente (CI) ou crie ${CHAVE}=... no .env desta pasta, ou rode o ralph.sh num terminal interativo para salvar a chave la.`;
  if (!terminal.interativo()) {
    if (TIERS.includes(env.RALPH_ROUTER_ON_FAIL || '')) return { ok: true, origem: 'fallback-explicito', aviso: `Chave do JEV (${CHAVE}) nao encontrada. Sem terminal para perguntar; segue o fallback explicito RALPH_ROUTER_ON_FAIL=${env.RALPH_ROUTER_ON_FAIL}.` };
    return { ok: false, erro: `Chave do JEV (${CHAVE}) nao encontrada. Sem terminal interativo para perguntar. ${orientacao}` };
  }
  const prot = protegerEnv(cwd);
  if (prot === 'rastreado') return { ok: false, erro: `O .env desta pasta esta rastreado pelo git; nao vou gravar a chave nele. Remova do controle (git rm --cached .env) ou defina ${CHAVE} no ambiente.` };
  if (prot !== 'ok') return { ok: false, erro: `Nao consegui deixar o .env fora do git (.git/info/exclude); nada foi gravado. Defina ${CHAVE} no ambiente.` };

  const chave = await terminal.pedir(`Chave do JEV (${CHAVE}) nao encontrada. Cole a chave; sera salva em ${path.join(cwd, '.env')} (a digitacao fica oculta): `);
  if (!chave) return { ok: false, erro: `Nenhuma chave informada; nada foi gravado. Rode de novo ou defina ${CHAVE}.` };
  if (!gravarChave(cwd, r, chave)) return { ok: false, erro: `Nao foi possivel gravar ${path.join(cwd, '.env')}. Defina ${CHAVE} no ambiente.` };
  return { ok: true, origem: '.env', salvou: true };
}
module.exports = { parseEnv, lerEnv, carregarChave, garantirChave, protegerEnv, gravarChave };

if (require.main === module) {
  (async () => {
    const cmd = process.argv[2];
    const mod = process.env.RALPH_JEV_CREDENTIAL_MODULE; const terminal = mod ? require(path.resolve(mod)) : terminalPadrao;
    if (cmd === 'status') {
      console.log((process.env[CHAVE] || '').trim() ? 'ambiente' : { ok: '.env', ilegivel: 'ilegivel' }[lerEnv(process.cwd()).estado] || 'ausente');
    } else if (cmd === 'ensure') {
      const r = await garantirChave({ terminal });
      if (r.aviso) console.error('AVISO: ' + r.aviso);
      if (!r.ok) { console.error('ERRO: ' + r.erro); process.exit(1); }
      if (r.salvou) console.error('Chave salva no .env desta pasta (fora do git); as proximas execucoes reutilizam.');
    } else {
      console.error('uso: jev-credential.js ensure|status');
      process.exit(2);
    }
  })().catch((e) => { console.error('ERRO: jev-credential: ' + (e && e.message || e)); process.exit(1); });
}
