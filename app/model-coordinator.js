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
  [/(^|[\s"'`(=:[,])\/(?:Users|home|root|data|app|var|etc|opt|srv|mnt|tmp|private|Volumes|workspace|run|proc)\b[^\s"'`)<>\],]*/g, '$1[path]'],
  [/\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|169\.254|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g, '[address]'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
];

function secretish(text) { return SECRETISH.test(String(text || '')); }
function cloudSafePath(rel) { return !SECRET_FILE.test(String(rel || '').replace(/\\/g, '/')); }
function redact(text, env = process.env) {
  let t = String(text ?? '');
  for (const [k, v] of Object.entries(env || {})) {
    const value = String(v ?? '').trim();
    if (SECRET_ENV.test(k) && value.length >= 6) t = t.split(value).join('[secret]');
  }
  for (const [re, to] of REDACTIONS) t = t.replace(re, to);
  return t;
}

function createCoordinator({ modelRouter, cloudModels, routingSetting, recordActivity = () => {}, env = process.env, localModel = '' }) {
  function route(req = {}) {
    return modelRouter.route({
      ...req, cloud: routingSetting().cloud === true, keys: cloudModels.keys(), parked: cloudModels.parked(), env,
      localModel: req.localModel || localModel,
    });
  }
  const local = (r, model) => ({ provider: 'ollama', model: model || r.order.at(-1)?.model || localModel, class: r.class, why: r.why });
  // The cloud candidates in order; the first answer wins. null: go on to this PC.
  async function run(r, messages, { kind = 'plan', maxTokens } = {}) {
    const candidates = (r?.order || []).filter(c => c.provider !== 'ollama');
    if (!candidates.length || r.class !== 'shareable' || routingSetting().cloud !== true) return null;
    const out = (Array.isArray(messages) ? messages : []).map(m => ({ role: m.role, content: redact(m.content, env) }));
    const chars = out.reduce((n, m) => n + m.content.length, 0);
    for (const c of candidates) {
      try {
        const answer = await cloudModels.chat({ provider: c.provider, model: c.model, messages: out, ...(maxTokens ? { maxTokens } : {}) });
        recordActivity('model', 'Sent to a cloud model', `${modelRouter.label(c).replace(/^Answered by /, '')} · ${kind} · ${chars.toLocaleString('en-US')} characters`, { provider: c.provider, model: c.model, kind, chars });
        if (answer?.content) return { content: answer.content, used: { provider: c.provider, model: c.model, class: r.class, why: r.why } };
      } catch (e) {
        recordActivity('model', 'Cloud model unavailable', redact(String(e?.message || e), env).slice(0, 180), { provider: c.provider, model: c.model, kind });
      }
    }
    return null;
  }
  return { route, run, local, redact: t => redact(t, env) };
}

module.exports = { createCoordinator, redact, secretish, cloudSafePath };
