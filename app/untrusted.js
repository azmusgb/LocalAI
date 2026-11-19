'use strict';

// Text that is quoted to a model or to a Claude session between <<<UNTRUSTED_… / UNTRUSTED_…>>> markers: board
// requests (app/improve.js), journal entries (app/journal-ask.js), project Memory notes (app/project-memory.js).
// It is data, never instructions (docs/SECURITY.md, "Board text is untrusted"; platform amendment A28 D5), so it
// must not be able to close its block or open another one: any <<< or >>> inside it is defused.
const defuse = text => String(text ?? '').replace(/<<<|>>>/g, m => (m === '<<<' ? '‹‹‹' : '›››'));

module.exports = { defuse };
