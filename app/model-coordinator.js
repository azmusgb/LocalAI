'use strict';

// Runs one piece of work through the model coordinator (docs/superpowers/specs/2026-10-26-model-coordinator-design.md).
// route() decides (app/model-router.js, plus the owner's switch, the keys and any rested provider); run() tries the cloud
// models in that order and returns null when none answered or none were allowed, so the caller goes on to this PC's
// model: a request never fails only because the cloud did. With cloud switched off, or for private work, run() makes no
// request at all. What goes out is redacted first (redact): keys and secret values, bearer tokens, absolute paths,
// private and tailnet addresses, email addresses. The Activity log gets one line per cloud call, never the text.

// The names childEnv treats as secrets (app/server/workbench.js): their values never go out.
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
// Asking about Local AI's own keys, tokens, passwords or setup: that work stays here whatever its kind.
const SECRETISH = /\b(api[ _-]?keys?|approval[ _-]?key|private[ _-]?key|secret[ _-]?key|keys? file|tokens?|secrets?|passwords?|passwd|credentials?|stack\.env|env file|environment variables?|certificates?|certs?|ssh|config(uration)? files?)\b|\.env\b/i;
// Files whose name says they hold a secret never go out, whatever is in them.
const SECRET_FILE = /(^|\/)(\.env[^/]*|[^/]*\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|crt|cer|pfx|p12|jks|keystore)|[^/]*(secret|token|password|passwd|credential|approval-key|api[-_]?key|private)[^/]*)$/i;

const REDACTIONS = [
  [/\b(?:gsk|csk|ghp|gho|ghs|ghu|github_pat|sk|pk|rk|xox[abpr]|hf|glpat)[-_][A-Za-z0-9_-]{8,}/g, '[secret]'],
  [/\bBearer\s+[^\s"',;]+/gi, 'Bearer [secret]'],
  [/\b[A-Za-z]:\\[^\s"'`<>|]*/g, '[path]'],
  [/\\\\[A-Za-z0-9._$-]+\\[^\s"'`<>|]*/g, '[path]'],
  [/(^|[\s"'`(=:[,])~\/[^\s"'`)<>\],]*/g, '$1[path]'],
  [/\b(?:[a-z0-9-]+\.)+(?:home\.arpa|ts\.net|local|lan)\b/gi, '[host]'],
  [/\b(?:f[cd][0-9a-f]{2}|fe80):[0-9a-f:]*[0-9a-f]\b/gi, '[address]'],
  [/(^|[\s"'`(=:[,])\/(?:Users|home|root|data|app|var|etc|opt|srv|mnt|tmp|private|Volumes|workspace|run|proc)\b[^\s"'`)<>\],]*/g, '$1[path]'],
  [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g, '[address]'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
];

// Key-shaped strings and bearer tokens count too: a finding that quotes one stays here.
const KEY_SHAPED = /\b(?:gsk|csk|ghp|gho|ghs|ghu|github_pat|sk|pk|rk|xox[abpr]|hf|glpat)[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/;
function secretish(text) { const t = String(text || ''); return SECRETISH.test(t) || KEY_SHAPED.test(t); }
function cloudSafePath(rel) { return !SECRET_FILE.test(String(rel || '').replace(/\\/g, '/')); }
function redact(text, env = process.env, extra = []) {
  let t = String(text ?? '');
  for (const v of extra || []) { const value = String(v ?? '').trim(); if (value.length >= 6) t = t.split(value).join('[secret]'); }
  for (const [k, v] of Object.entries(env || {})) {
    const value = String(v ?? '').trim();
    if (SECRET_ENV.test(k) && value.length >= 6) t = t.split(value).join('[secret]');
  }
  for (const [re, to] of REDACTIONS) t = t.replace(re, to);
  return t;
}

// What a cloud call came to, for the route a run records: answered, timeout, rate_limited or error. cloud-models.js
// marks its errors (outcome); anything else is read from its words.
const MAX_ATTEMPTS = 5;
const OUTCOME_WORDS = { timeout: 'timed out', rate_limited: 'busy', error: 'failed' };
function outcomeOf(e) {
  if (['timeout', 'rate_limited', 'error'].includes(e?.outcome)) return e.outcome;
  const m = String(e?.code || '') + ' ' + String(e?.message || e || '');
  return /timeout|timed out/i.test(m) ? 'timeout' : /rate limit|\b429\b/i.test(m) ? 'rate_limited' : 'error';
}
// attempts as a route keeps them: at most MAX_ATTEMPTS of {provider, model, outcome, ms}, nothing else.
const keepAttempts = list => (Array.isArray(list) ? list : []).slice(0, MAX_ATTEMPTS).map(a => ({
  provider: String(a?.provider || ''), model: String(a?.model || '').slice(0, 80), outcome: (a?.outcome === 'answered' || OUTCOME_WORDS[a?.outcome]) ? a.outcome : 'error', ms: Math.max(0, Math.round(Number(a?.ms) || 0)),
}));

// secrets(): extra values never to send (what the server read from its key files); read at each call.
function createCoordinator({ modelRouter, cloudModels, routingSetting, recordActivity = () => {}, env = process.env, localModel = '', secrets = () => [], now = Date.now }) {
  const log = (...a) => { try { recordActivity(...a); } catch { /* a log that fails never changes what is sent */ } };
  const extra = () => { try { return secrets() || []; } catch { return []; } };
  function route(req = {}) {
    return modelRouter.route({
      ...req, cloud: routingSetting().cloud === true, keys: cloudModels.keys(), parked: cloudModels.parked(), env,
      localModel: req.localModel || localModel,
    });
  }
  const name = p => (Object.prototype.hasOwnProperty.call(modelRouter.PROVIDER_NAMES || {}, p) ? modelRouter.PROVIDER_NAMES[p] : 'A cloud model');
  const failed = list => list.map(a => `${name(a.provider)}: ${OUTCOME_WORDS[a.outcome] || 'failed'}`).join('; ');
  // The record for an answer from this PC. attempts: what run() tried first (its `attempts` option); when the cloud was
  // tried, the why says so instead of the plan's reason, and the list goes with it. Nothing tried: as before.
  const local = (r, model, attempts) => {
    const tried = keepAttempts(attempts);
    const used = { provider: 'ollama', model: model || r.order.at(-1)?.model || localModel, class: r.class, why: r.why };
    return tried.length ? { ...used, why: `Cloud models didn't answer (${failed(tried)}), so this PC answered`, attempts: tried } : used;
  };
  // The cloud candidates in order; the first answer wins. null: go on to this PC. attempts (optional): an array this
  // fills with what was tried, so a caller that goes on to this PC can pass it to local(). signal (optional): Stop, or a
  // caller that went away; it ends the cloud call at once and run() throws its reason, trying nothing else and recording
  // no attempt for it (a Stop is not a cloud model failing).
  async function run(r, messages, { kind = 'plan', maxTokens, attempts = [], signal } = {}) {
    const candidates = (r?.order || []).filter(c => c.provider !== 'ollama');
    if (!candidates.length || r.class !== 'shareable' || routingSetting().cloud !== true) return null;
    const hidden = extra(), out = (Array.isArray(messages) ? messages : []).map(m => ({ role: m.role, content: redact(m.content, env, hidden) }));
    const chars = out.reduce((n, m) => n + m.content.length, 0);
    for (const c of candidates) {
      signal?.throwIfAborted();
      // Logged before the send, so a timeout or a server error still shows that text went out.
      log('model', 'Sent to a cloud model', `${modelRouter.label(c).replace(/^Answered by /, '')} · ${kind} · ${chars.toLocaleString('en-US')} characters`, { provider: c.provider, model: c.model, kind, chars });
      let answer = null;
      const t0 = now(), tried = outcome => { if (attempts.length < MAX_ATTEMPTS) attempts.push({ provider: c.provider, model: c.model, outcome, ms: Math.max(0, now() - t0) }); };
      try { answer = await cloudModels.chat({ provider: c.provider, model: c.model, messages: out, ...(maxTokens ? { maxTokens } : {}), ...(signal ? { signal } : {}) }); }
      catch (e) { signal?.throwIfAborted(); tried(outcomeOf(e)); log('model', 'Cloud model unavailable', redact(String(e?.message || e), env, hidden).slice(0, 180), { provider: c.provider, model: c.model, kind }); continue; }
      if (!answer?.content) { tried('error'); continue; }
      tried('answered');
      const before = attempts.slice(0, -1);
      const why = before.length ? `${before.map(a => `${name(a.provider)} ${OUTCOME_WORDS[a.outcome] || 'failed'}`).join(', ')}, so ${name(c.provider)} answered` : r.why;
      return { content: answer.content, used: { provider: c.provider, model: c.model, class: r.class, why, attempts: keepAttempts(attempts) } };
    }
    return null;
  }
  return { route, run, local, redact: t => redact(t, env, extra()) };
}

module.exports = { createCoordinator, redact, secretish, cloudSafePath };
