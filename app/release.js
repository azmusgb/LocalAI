'use strict';
const fs = require('node:fs');
const path = require('node:path');

// release.json is written by the deploy (deploy/Deployment-LocalAI.ps1, New-LocalAI-ReleaseInfo): the commit is
// required; version, deployedAt and notes ([{title, pr?}], merged PRs since the previous release) are optional.
function readRelease(appRoot) {
  const file = path.join(appRoot, 'release.json');
  if (!fs.existsSync(file)) return null;
  let release;
  try { release = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { throw new Error('Invalid deployment release.json; refusing to report a healthy release.', { cause }); }
  if (!release || typeof release.commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.commit)) {
    throw new Error('Deployment release.json must contain a full commit SHA');
  }
  const out = { commit: release.commit };
  if (typeof release.version === 'string' && /^\d+\.\d+\.\d+$/.test(release.version)) out.version = release.version;
  if (typeof release.deployedAt === 'string' && !Number.isNaN(Date.parse(release.deployedAt))) out.deployedAt = release.deployedAt;
  const notes = Array.isArray(release.notes) ? release.notes : release.notes && typeof release.notes === 'object' ? [release.notes] : [];
  const clean = notes.filter(n => n && typeof n.title === 'string' && n.title.trim()).slice(0, 50)
    .map(n => ({ title: n.title.trim().slice(0, 200), ...(Number.isInteger(n.pr) && n.pr > 0 ? { pr: n.pr } : {}) }));
  if (clean.length) out.notes = clean;
  return out;
}

// The version Local AI reports: the deployed release's; in a checkout, package.json's; else APP_VERSION.
function appVersion(appRoot, release, env = process.env) {
  if (release?.version) return release.version;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, '..', 'package.json'), 'utf8'));
    if (/^\d+\.\d+\.\d+$/.test(pkg.version) && pkg.version !== '0.0.0') return pkg.version;
  } catch {}
  return env.APP_VERSION || '1.18';
}
// Assistant status › Last deployment check. A release only goes live after the deploy's candidate checks pass (and rolls back
// otherwise), so the running release is the latest passed check. The optional certification report (REPORT_PATH)
// is shown only when it is newer than that, e.g. a manual run that found a problem. Nothing writes it on each deploy.
function deployCheck(report, release) {
  const at = release?.deployedAt && Date.parse(release.deployedAt);
  if (!at) return report;
  const reportAt = report?.available && Date.parse(report.modifiedAt || '');
  if (reportAt && reportAt > at) return report;
  return { available: true, result: 'PASS', summary: `${release.version || 'This release'} passed its deploy checks`, modifiedAt: release.deployedAt, source: 'release' };
}
module.exports = { readRelease, appVersion, deployCheck };
