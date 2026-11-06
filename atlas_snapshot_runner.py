"""System Atlas "Snapshot now" (plan PR 4): one snapshot at a time, from a fetch-only bare mirror per repository.

A request names an allowed repository and a ref. The runner fetches that repository's mirror
(<ATLAS_MIRRORS>/<repo>.git, cloned on first use through the PC's read-only deploy-key host alias), resolves the ref
to a commit, then runs quick_arch.py --repo <repo> --git-dir <mirror> --commit <sha>, which exports that commit with
git archive and writes the snapshot. Nothing here touches a working tree, and nothing pushes.
"""

from __future__ import annotations

import collections
import os
import re
import shutil
import subprocess
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# The Local AI checkout Atlas maps and keeps .atlas/ in. Atlas runs from its own copy of the release (#450), where the
# deploy writes repo-root.txt naming the checkout; ATLAS_ROOT overrides it. Without either it is this file's folder.
HERE = Path(__file__).resolve().parent
_ROOT_FILE = HERE / "repo-root.txt"
ROOT = Path(os.environ.get("ATLAS_ROOT") or (_ROOT_FILE.read_text(encoding="utf-8").strip() if _ROOT_FILE.is_file() else "") or HERE).resolve()
# Beside the deploy checkout (C:\LocalAI\repo -> C:\LocalAI\atlas-repos), never inside it.
MIRRORS = Path(os.environ.get("ATLAS_MIRRORS") or (ROOT.parent / "atlas-repos"))

# Each repository through its own read-only deploy key (the PC's SSH config maps each alias to its key).
DEFAULT_REMOTES = {
    "localai": "git@github-localai:azmusgb/LocalAI.git",
    "pi-hub": "git@github-atlas-pihub:azmusgb/pi-hub.git",
    "print-lab": "git@github-atlas-printlab:azmusgb/print-lab.git",
}

REPO_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
REMOTE = re.compile(r"^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+\.git$")
# A branch, tag or commit: no leading dash (an option to git), no "..", no spaces or shell characters.
REF = re.compile(r"^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$")

FETCH_TIMEOUT = 300
SNAPSHOT_TIMEOUT = 900
MAX_QUEUED = 5
KEEP_RECENT = 10


class SnapshotRequestError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def remotes_from_env(value: str | None = None) -> dict[str, str]:
    """ATLAS_REPO_REMOTES ("name=git@alias:owner/repo.git,...") adds or replaces repositories; bad entries are skipped."""
    remotes = dict(DEFAULT_REMOTES)
    raw = os.environ.get("ATLAS_REPO_REMOTES", "") if value is None else value
    for item in raw.split(","):
        name, _, url = item.strip().partition("=")
        name, url = name.strip().lower(), url.strip()
        if REPO_NAME.match(name) and REMOTE.match(url):
            remotes[name] = url
    return remotes


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class SnapshotRunner:
    def __init__(
        self,
        remotes: dict[str, str] | None = None,
        mirrors: Path = MIRRORS,
        script: Path = HERE / "quick_arch.py",
        run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
    ) -> None:
        self.remotes = dict(remotes if remotes is not None else remotes_from_env())
        self.mirrors = Path(mirrors)
        self.script = Path(script)
        self.run = run
        self._lock = threading.Lock()
        self._queue: collections.deque[dict[str, Any]] = collections.deque()
        self._running: dict[str, Any] | None = None
        self._recent: collections.deque[dict[str, Any]] = collections.deque(maxlen=KEEP_RECENT)
        self._worker: threading.Thread | None = None
        self._seq = 0

    def request(self, repo: Any, ref: Any = "main") -> dict[str, Any]:
        """Queue a snapshot. The same repository and ref already waiting is that job; one already running queues again."""
        repo = str(repo or "").strip().lower()
        ref = str(ref or "main").strip()
        if repo not in self.remotes:
            raise SnapshotRequestError("atlas_repo_unknown", f"No snapshots are kept for {repo or 'that repository'}.", 404)
        if not REF.match(ref):
            raise SnapshotRequestError("atlas_ref_invalid", "A ref is a branch, tag or commit name.")
        with self._lock:
            for job in self._queue:
                if job["repo"] == repo and job["ref"] == ref:
                    return dict(job)
            if len(self._queue) >= MAX_QUEUED:
                raise SnapshotRequestError("atlas_snapshot_busy", "Too many snapshots are waiting; try again shortly.", 429)
            self._seq += 1
            job = {"id": self._seq, "repo": repo, "ref": ref, "state": "queued", "queuedAt": now()}
            self._queue.append(job)
            if self._worker is None:
                self._worker = threading.Thread(target=self._work, name="atlas-snapshots", daemon=True)
                self._worker.start()
            return dict(job)

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "repos": sorted(self.remotes),
                "running": dict(self._running) if self._running else None,
                "queued": [dict(j) for j in self._queue],
                "recent": [dict(j) for j in self._recent],
            }

    def wait(self, timeout: float | None = None) -> None:
        """Until the queue is empty (tests)."""
        worker = self._worker
        if worker is not None:
            worker.join(timeout)

    def _work(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    self._running = None
                    self._worker = None
                    return
                job = self._queue.popleft()
                job.update(state="running", startedAt=now())
                self._running = job
            try:
                job["commit"] = self._snapshot(job["repo"], job["ref"])
                job["state"] = "done"
            except Exception as error:  # a failed run is reported on its job, never kills the worker
                job["state"] = "failed"
                job["error"] = str(error).strip()[:300] or error.__class__.__name__
            job["finishedAt"] = now()
            with self._lock:
                self._recent.appendleft(job)
                self._running = None

    def _git(self, args: list[str], timeout: int = FETCH_TIMEOUT) -> str:
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
        result = self.run(["git", *args], capture_output=True, text=True, timeout=timeout, env=env)
        if result.returncode != 0:
            raise RuntimeError(f"git {args[0] if args[0] != '--git-dir' else args[2]} failed: {(result.stderr or result.stdout).strip()[:240]}")
        return result.stdout

    def _snapshot(self, repo: str, ref: str) -> str:
        mirror = self.mirrors / f"{repo}.git"
        if (mirror / "HEAD").is_file():
            self._git(["--git-dir", str(mirror), "fetch", "--prune", "--quiet", "origin"])
        else:
            # Clone beside the final name and rename, so a failed first clone never looks like a mirror.
            self.mirrors.mkdir(parents=True, exist_ok=True)
            partial = self.mirrors / f"{repo}.git.partial"
            shutil.rmtree(partial, ignore_errors=True)
            try:
                self._git(["clone", "--mirror", "--quiet", "--", self.remotes[repo], str(partial)])
                partial.rename(mirror)
            finally:
                shutil.rmtree(partial, ignore_errors=True)
        commit = self._git(["--git-dir", str(mirror), "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}"]).strip()
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise RuntimeError(f"{ref} did not resolve to a commit.")
        result = self.run(
            [sys.executable, "-I", str(self.script), "--repo", repo, "--git-dir", str(mirror), "--commit", commit],
            capture_output=True, text=True, timeout=SNAPSHOT_TIMEOUT, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        if result.returncode != 0:
            raise RuntimeError(f"The scan failed: {(result.stderr or result.stdout).strip()[-240:]}")
        return commit
