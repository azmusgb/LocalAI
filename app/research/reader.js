'use strict';

// Zero-tool reader engine for research documents.
// Extracts structured findings from documents with strict verbatim quote validation.
// All documents are wrapped inside untrusted blocks to prevent prompt injection escapes.

const { defuse } = require('../untrusted');

const CLAIM_MAX = 300;
const QUOTE_MAX = 2000;
const ALLOWED_PROJECTS = ['LocalAI', 'pi-hub', 'print-lab', 'appliance-ui', 'general'];

function buildReaderPrompt(doc) {
  const safeText = `<<<UNTRUSTED_DOCUMENT_TEXT\n${defuse(doc.text || '')}\nUNTRUSTED_DOCUMENT_TEXT>>>`;
  const safeTitle = `<<<UNTRUSTED_DOCUMENT_TITLE\n${defuse(doc.title || '')}\nUNTRUSTED_DOCUMENT_TITLE>>>`;

  return `You are a research analyst reading technical release notes and advisories.
Extract at most one high-value finding that is relevant to our projects (${ALLOWED_PROJECTS.join(', ')}).
If the document is purely marketing or irrelevant, answer with {"relevant": false}.

CRITICAL SECURITY & ACCURACY RULES:
1. You have ZERO tools. Do not attempt to run commands or read files.
2. The finding MUST be factual. Do not speculate or hallucinate.
3. "verbatim_quote" MUST be an exact character-for-character substring found in the document text.
4. Output ONLY valid JSON conforming to this schema:
{
  "relevant": true,
  "claim": "Summary of what changed or was discovered (max 300 chars)",
  "verbatim_quote": "Exact sentence or snippet copied verbatim from text",
  "target_project": "LocalAI | pi-hub | print-lab | appliance-ui | general",
  "relevance": "Direct Dependency | Security Advisory | Optimization"
}

${safeTitle}
${safeText}`;
}

function validateFindingOutput(doc, parsedJson) {
  if (!parsedJson || typeof parsedJson !== 'object') return null;
  if (parsedJson.relevant === false) return null;

  const claim = String(parsedJson.claim || '').trim();
  const quote = String(parsedJson.verbatim_quote || '').trim();
  const targetProject = String(parsedJson.target_project || 'general').trim();
  const relevance = String(parsedJson.relevance || 'General').trim();

  if (!claim || claim.length > CLAIM_MAX) return null;
  if (!quote || quote.length > QUOTE_MAX) return null;

  // The Verbatim Evidence Gate:
  // If the quote does not exist as an exact substring in doc.text, REJECT IT.
  const docText = String(doc.text || '');
  if (!docText.includes(quote)) {
    return null;
  }

  return {
    claim,
    quote,
    targetProject: ALLOWED_PROJECTS.includes(targetProject) ? targetProject : 'general',
    relevance
  };
}

module.exports = {
  buildReaderPrompt,
  validateFindingOutput
};
