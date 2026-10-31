# Atlas Investigations v1

This is a transitional, fail-closed installer for the native Local AI System Atlas integration currently present in the operator worktree.

## Product contract

- **Atlas determines facts. Ollama interprets facts. Goose investigates facts.**
- Atlas Intelligence owns investigation execution and the `.atlas/investigations` artifact store.
- Local AI proxies only explicit Atlas investigation APIs; it does not mount the Local AI repository into Workbench.
- Architecture owns the investigation viewer and history.
- Project Knowledge is an explicit promotion target, never an automatic sink for generated analysis.
- Legacy prompt-only `atlas-investigation-*.md` files remain readable and are labeled `Legacy prompt`.

## Investigation states

- `running` — Goose is executing a read-only investigation.
- `completed` — Goose returned successfully and the Markdown artifact contains its actual output.
- `failed` — Goose failed or timed out; the artifact keeps diagnostics and evidence.
- `prepared` — Goose was unavailable; Atlas saved the investigation prompt but did not claim it ran.
- `legacy` — artifact predates this contract and has no structured metadata.

## Runtime boundaries

The Windows Ollama server may continue binding with `OLLAMA_HOST=0.0.0.0:11434` for Docker reachability. Atlas overrides only the Goose child-process client environment to `ATLAS_GOOSE_OLLAMA_HOST`, defaulting to `http://127.0.0.1:11434`. This avoids treating a server bind address as a client destination.

Goose execution defaults to a 420-second timeout (`ATLAS_GOOSE_TIMEOUT_SECONDS`, clamped to 30–900 seconds). The Local AI Atlas facade allows 450 seconds for the Goose request while retaining shorter timeouts for ordinary read APIs.

## UI

Architecture adds a secondary **Investigations** action beside **Goose brief**. The viewer uses a native `<dialog>` with:

- newest-first investigation history;
- explicit status and timing;
- safe text-only Markdown rendering (no untrusted HTML injection);
- progressive disclosure for evidence/prompt detail;
- copy and Markdown download;
- explicit **Add to project knowledge**;
- keyboard focus, native Escape close, responsive layouts, and reduced-motion handling.

No `MutationObserver` is used.

## Installer

`Install-Atlas-Investigations.ps1`:

1. verifies the current native Atlas integration exists;
2. backs up every file it will touch;
3. applies surgical/idempotent Python patches;
4. runs Atlas self-test, Node syntax checks, focused tests, and scoped `git diff --check`;
5. only after validation, promotes the relevant Local AI app files;
6. restarts the appliance and Atlas Intelligence;
7. verifies Atlas health, Local AI health, investigation-history proxying, HTTPS asset delivery, and the service-worker generation.

Use `-NoPromote` to patch and validate source without changing the live appliance.

The installer intentionally does **not** run a Goose smoke investigation automatically; that would create a persistent artifact. The first operator-triggered Goose investigation is the runtime acceptance of the model execution path.
