# Research Findings and Outcomes (step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Pre-requisite:** Phase 1 (Research Intake, PR #586) and Amendment A31 (pi-hub PR #289/#290) are merged and active.

**Goal:** Turn newly fetched research documents into atomic, evidence-backed findings using an isolated zero-tool reader model, manage them in a capped triage inbox (≤ 10 items/day), enable one-click promotion into the Improve backlog, and close the loop with post-release outcome tracking.

**Architecture:**
- Reader engine: `app/research/reader.js` (no tools, untrusted sandbox, verbatim quote validator).
- Schema additions: `research_findings` and `research_outcomes` in `app/research/store.js` (`CREATE TABLE IF NOT EXISTS`, no schema version bump).
- API routes: `app/server/research.js` extended with `/api/research/findings`, `/api/research/findings/decide`, `/api/research/findings/promote`, and `/api/improve/outcome`.
- UI Integration: An on-demand module under Improve (`Research › Findings`), respecting container queries and the 119 KB `ui.js` gzip budget.

**Tech Stack:** Node ≥ 22.13 built-ins only, `node:sqlite`, vanilla ES modules for UI, `node:test` + `node:assert/strict`.

**Spec Reference:** `docs/superpowers/specs/2026-11-19-knowledge-loop-design.md` (§3.3–3.6, §4.1–4.3, §8.1 phase 2).

---

## Global Constraints

- **Zero Runtime Dependencies:** Built-in Node modules only.
- **Strict Prompt Sandboxing:** Input documents are wrapped in `<<<UNTRUSTED_DOCUMENT>>>` markers via `app/untrusted.js`.
- **Zero Tool Access:** The reader run configuration explicitly passes `tools: []`. It cannot call web search, workspace read, or system commands.
- **Verbatim Evidence Gate:** Any extracted finding whose `verbatim_quote` cannot be found as an exact substring in the stored document is discarded immediately.
- **Daily Attention Budget:** The inbox route (`GET /api/research/findings`) serves at most 10 un-triaged findings per calendar day; additional findings remain queued.
- **Additive Database Migrations:** Tables created `IF NOT EXISTS`. Never alter existing tables or bump `SCHEMA_VERSION`.
- **Safe Gzip Budget:** All UI additions for the Findings view must reside in lazy-loaded modules (no additions to `ui.js`).

---

## Task List

### Task 1: Store Additions (`research_findings` & `research_outcomes`)
- [ ] Create `research_findings` table:
  - Columns: `id`, `document_id`, `source_id`, `claim`, `quote`, `target_project`, `relevance`, `status` (`extracted`, `kept`, `dismissed`, `promoted`), `created_at`, `decided_at`.
- [ ] Create `research_outcomes` table:
  - Columns: `id`, `finding_id`, `change_id`, `metric_name`, `before_val`, `after_val`, `verdict` (`validated`, `refuted`, `inconclusive`), `notes`, `created_at`.
- [ ] Add query methods to `app/research/store.js`: `insertFinding`, `listFindings`, `updateFindingStatus`, `recordOutcome`.
- [ ] Add unit test coverage in `tests/unit/research-store-step2.test.cjs`.

### Task 2: Zero-Tool Reader & Verbatim Validator
- [ ] Implement `app/research/reader.js`:
  - Formats prompt with document title and text wrapped in `app/untrusted.js`.
  - Invokes local model via `runAgentLoop` (or fast fallback coordinator) with `tools: []` and temperature 0.1.
  - Parses JSON output conforming to `{ claim, verbatim_quote, target_project, relevance }`.
  - Validates that `document.text.includes(verbatim_quote)`.
- [ ] Add unit tests verifying:
  - Valid JSON extraction with exact matching quote passes.
  - Fabricated or hallucinatory quotes are rejected.
  - Documents containing prompt injection attempts ("Ignore previous instructions...") do not escape the schema.

### Task 3: Inbox API with Attention Cap & Promotion
- [ ] Add routes to `app/server/research.js`:
  - `GET /api/research/findings`: Returns active findings, capped at 10 items for the current day.
  - `POST /api/research/findings/decide`: Sets status to `kept` or `dismissed`.
  - `POST /api/research/findings/promote`: Converts finding into an Improve backlog item (`app/server/changes.js`), attaching finding ID and immutable quote as evidence.
  - `POST /api/improve/outcome`: Records measured outcome and transitions finding to `validated` or `refuted`.
- [ ] Ensure all routes are guarded in `app/signin.js`.

### Task 4: UI Faceplate for Improve › Research Findings
- [ ] Implement lazy-loaded view `app/public/modules/research-findings.js`.
- [ ] Follow `DESIGN.md`:
  - Split list/aside faceplate on desktop; stacked on mobile (< 720px).
  - Clearly distinguish: Quote (Observed), Reading (Inference), and Actions (`[Promote]`, `Keep`, `Dismiss`).
  - Daily cap counter: "New today 4 of 10 · 6 waiting".

### Task 5: End-to-End Verification & Integration Test
- [ ] Integration test simulating:
  1. Intake job fetching a mocked release feed document.
  2. Reader processing the document and storing an extracted finding.
  3. API listing finding within daily cap.
  4. Promote creating an Improve backlog item with evidence.
  5. Recording an outcome closing the loop.
- [ ] Run full test suite (`npm test`) and size budget checks.
