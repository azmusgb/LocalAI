'use strict';

// "About this appliance": a short, factual block the chat gets only when a question is about Local AI itself (where
// things run, where image models go, how to reach it, how updates work, where pages are). Facts come from the docs
// (host/comfyui/README.md, docs/ADMIN-GUIDE.md), the live address list (/healthz `addresses`) and view-registry.js
// labels, so the model never has to guess them. Kept under ~1,500 characters.
const registry = require('./public/view-registry.js');

// A question about the appliance: it names Local AI or its parts, or asks how to reach, update or find something in it.
const ABOUT = [
  /\blocal ?ai\b/, /\b(this|the|my|your) (appliance|app|assistant|server|setup|ai)\b/,
  /\b(ollama|comfy ?ui|gridcraft|artcraft|tailscale|docker|n8n|searxng)\b/,
  /\.?safetensors\b|\bgguf\b|\bcheckpoints?\b|\blora\b|\b(diffusion_models|text_encoders)\b/,
  /\b(install|download|add|put|pull|load)\b.*\b(models?|checkpoints?)\b/, /\b(image|text) models?\b/,
  /\baway from home\b|\bhome screen\b|\b(reach|access|open|connect to)\b.*\b(from|on) (my )?(phone|iphone|outside|work|anywhere)\b/,
  /\b(update|upgrade|deploy|redeploy)s?\b.*\b(work|happen|install|get)/, /\bwhat'?s new\b/,
  /\bwhere (is|are|do i find|can i find|do i see|can i see)\b.*\b(page|tab|setting|spreadsheets?|automations?|services?|health|models|library|inbox|backlog|audit log)\b/
];
function isAboutLocalAi(text) {
  const t = String(text || '').toLowerCase();
  return ABOUT.some(re => re.test(t));
}

// "Library in Projects": a page by its section and, for a tab, its parent's tab strip; an unlisted page by its owner's.
function whereIs(id) {
  const v = registry.view(id);
  if (!v) return '';
  const domain = registry.DOMAINS.find(d => d.id === (v.domain === 'hidden' ? v.owner : v.domain));
  const name = v.parent ? (v.tab || v.label) : v.label;
  return domain && domain.label !== name ? `${name} in ${domain.label}` : name;
}
const PLACES = ['spreadsheets', 'library', 'automationStudio', 'inbox', 'integrations', 'models', 'status', 'shipped', 'activity'];

// addresses: [{ label, url }] as accessAddresses() returns them (Home Wi-Fi, Anywhere (Tailscale)).
function aboutApplianceBlock({ addresses = [] } = {}) {
  const home = addresses.find(a => /wi-?fi|home/i.test(a.label))?.url;
  const remote = addresses.find(a => /tailscale/i.test(a.label))?.url;
  return [
    'ABOUT THIS APPLIANCE (facts; say you don\'t know rather than add to them):',
    '- Local AI runs in Docker on the owner\'s Windows PC. Text models run in Ollama. Image models run in ComfyUI on that PC, never Ollama: model files go in folders under C:\\Projects\\ComfyHost\\models (SD/SDXL checkpoints in checkpoints; Z-Image Turbo by hand: z_image_turbo_bf16.safetensors in diffusion_models, qwen_3_4b.safetensors in text_encoders, ae.safetensors in vae), then restart ComfyUI. Spreadsheets are read and changed by GridCraft on the PC.',
    `- Reach it: home Wi-Fi ${home || 'address not set up'}; anywhere over Tailscale ${remote || '(Tailscale is not set up)'}.` +
      (remote ? ' For one icon that works everywhere, add Local AI to the Home Screen from the Tailscale address and keep Tailscale on.' : '') +
      ' Health › Secure connection lists the addresses.',
    '- Updates: a change merged to main deploys by itself within about 5 minutes and rolls back if unhealthy; it waits for running work (chats, images, missions, GridCraft, automations) up to 45 minutes.',
    `- Where things are: ${PLACES.map(whereIs).filter(Boolean).join('; ')}. Chat and Images open from Home.`
  ].join('\n');
}

module.exports = { isAboutLocalAi, aboutApplianceBlock };
