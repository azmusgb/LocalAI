'use strict';

// Amendment A30 Phase 3: Read-only tools in chat (D2, D5).
// Four readers: /api/now, /api/now/prints, /api/needs, /api/records.
// - Read-only by construction: no method, URL or header args.
// - Untrusted text is marked with <<<UNTRUSTED_REQUEST markers.
// - Failed reads report honestly (source_down or prints_available: false) rather than empty arrays.
// - Server marks turn private when any of these readers are called.

const { tool, evidenceRecord } = require('./agent-tools');
const { defuse } = require('./untrusted');

function wrapUntrusted(obj) {
  if (obj === null || obj === undefined) return '';
  const jsonStr = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  return `<<<UNTRUSTED_REQUEST\n${defuse(jsonStr)}\nUNTRUSTED_REQUEST>>>`;
}

function createChatReaders({ piHub } = {}) {
  if (!piHub) throw new Error('piHub client is required');

  return [
    tool(
      'read_hub_now',
      'Read Pi Hub /api/now status (now playing, core service status). Read-only.',
      {},
      [],
      async () => {
        const res = typeof piHub.now === 'function' ? await piHub.now() : null;
        if (!res) {
          return {
            data: { available: false, reason: 'source_down' },
            evidence: [evidenceRecord('pi-hub:now', 'Pi Hub /api/now is not answering (source_down)', { kind: 'hub_status', title: 'Pi Hub Now Status' })]
          };
        }
        const excerpt = wrapUntrusted(res);
        const evidence = [evidenceRecord('pi-hub:now', excerpt, { kind: 'hub_status', title: 'Pi Hub Now Status' })];
        return {
          data: { available: true, ...res, evidenceId: evidence[0].id },
          evidence
        };
      }
    ),

    tool(
      'read_hub_prints',
      'Read Pi Hub /api/now/prints (recent 3D print history and active jobs). Read-only.',
      {},
      [],
      async () => {
        const res = typeof piHub.prints === 'function' ? await piHub.prints() : { ok: false, source: 'pi-hub' };
        if (!res || !res.ok) {
          const reason = res?.source || 'source_down';
          return {
            data: { available: false, reason },
            evidence: [evidenceRecord('pi-hub:prints', `Pi Hub /api/now/prints is not answering (${reason})`, { kind: 'printer_log', title: 'Pi Hub Prints' })]
          };
        }
        const excerpt = wrapUntrusted(res.prints);
        const evidence = [evidenceRecord('pi-hub:prints', excerpt, { kind: 'printer_log', title: 'Pi Hub Prints' })];
        return {
          data: { available: true, prints: res.prints, evidenceId: evidence[0].id },
          evidence
        };
      }
    ),

    tool(
      'read_hub_needs',
      'Read Pi Hub /api/needs (household alerts, warnings, and pending maintenance). Read-only.',
      {},
      [],
      async () => {
        const res = typeof piHub.needs === 'function' ? await piHub.needs() : null;
        if (!res) {
          return {
            data: { available: false, reason: 'source_down' },
            evidence: [evidenceRecord('pi-hub:needs', 'Pi Hub /api/needs is not answering (source_down)', { kind: 'hub_needs', title: 'Pi Hub Needs' })]
          };
        }
        const excerpt = wrapUntrusted(res);
        const evidence = [evidenceRecord('pi-hub:needs', excerpt, { kind: 'hub_needs', title: 'Pi Hub Needs' })];
        return {
          data: { available: true, count: res.count, items: res.items, evidenceId: evidence[0].id },
          evidence
        };
      }
    ),

    tool(
      'read_hub_printer',
      'Read Pi Hub /api/records printer telemetry (temperatures, live state, nozzle/bed sensors). Read-only.',
      {},
      [],
      async () => {
        const res = typeof piHub.printer === 'function' ? await piHub.printer() : null;
        if (!res) {
          return {
            data: { available: false, reason: 'source_down' },
            evidence: [evidenceRecord('pi-hub:printer', 'Pi Hub /api/records printer is not answering (source_down)', { kind: 'printer_telemetry', title: 'Printer State' })]
          };
        }
        const excerpt = wrapUntrusted(res);
        const evidence = [evidenceRecord('pi-hub:printer', excerpt, { kind: 'printer_telemetry', title: 'Printer State' })];
        return {
          data: { available: true, ...res, evidenceId: evidence[0].id },
          evidence
        };
      }
    )
  ];
}

module.exports = {
  createChatReaders,
  wrapUntrusted
};
