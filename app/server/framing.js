'use strict';
// Pi Hub amendment A4, requirement 2: only Pi Hub may frame Local AI (its /assistant page), never another site.
// app/public/framed.js keeps the same list for the page side; tests/framing.test.cjs checks the two agree.
const HUB_FRAME_ORIGINS = Object.freeze(['https://hub.rahe-home.duckdns.org', 'https://home.home.arpa']);
const FRAME_POLICY = `frame-ancestors 'self' ${HUB_FRAME_ORIGINS.join(' ')}`;

// Every response carries it, error pages included, so no address of Local AI can be framed by another origin.
function setFramePolicy(res) {
  res.setHeader('Content-Security-Policy', FRAME_POLICY);
}

module.exports = { HUB_FRAME_ORIGINS, FRAME_POLICY, setFramePolicy };
