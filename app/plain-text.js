'use strict';
// Text the owner reads, in sentences. The raw details (elapsed ms, abort flags, codes) go to the server log instead.

function plannerError({ aborted, timeoutMs, code, message }) {
  if (aborted) return `The planning model didn't finish within ${Math.round(timeoutMs / 60000)} minutes, so this attempt was stopped.`;
  return `Couldn't reach the planning model (${code || String(message || 'no response')}). Check that Ollama is running, then try again.`;
}

const { changeTitle } = require('./improve');

// What a change approval is called in the Inbox: what it does, never its id.
function approvalTitle(change) {
  return `Apply change: ${changeTitle(change)}`;
}

module.exports = { plannerError, approvalTitle };
