Manual host regression for Docker Desktop stopped-container storage workers:

1. Start `local-ai-appliance` and confirm `/data` is a named volume.
2. Run candidate preflight while the appliance is running; expect success.
3. Stop `local-ai-appliance`.
4. Dot-source `deploy/Storage-LocalAI.ps1` from this branch and run `Test-LocalAI-StorageCandidate` against `app`; expect success.
5. Start the appliance and wait for `/healthz`.

This supplements the simulated deployment contracts, which intentionally mock Docker boundaries.
