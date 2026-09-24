#!/usr/bin/env python3
"""
Swarm Orchestrator — Vendor-Agnostic Autonomous Multi-Agent Swarm
=================================================================
Polls GitHub Issues and PRs via `gh` CLI, parses role metadata tags,
creates isolated git worktrees, and dispatches AI agents as subprocesses.

Usage:
    mao swarm [--repo-root /path/to/repo] [--interval 30] [--dry-run]
    mao swarm --repo-root /path/to/repo --status

The MAO CLI sets MAO_SWARM_REPO_ROOT before launching this bundled asset.
Requires: Python 3, authenticated gh CLI, git, and at least one AI CLI installed.
"""

import argparse
import json
import logging
import logging.handlers
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# The bundled MAO CLI always supplies MAO_SWARM_REPO_ROOT. Resolving from this
# source file is only a convenience for direct source-tree execution.
_SOURCE_REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = Path(
    os.environ.get("MAO_SWARM_REPO_ROOT", _SOURCE_REPO_ROOT)
).expanduser().resolve()
WORKTREE_DIR = REPO_ROOT / ".worktrees"
LOG_DIR = REPO_ROOT / ".agents" / "logs"
POLL_INTERVAL_SECONDS = 30
PROCESS_REGISTRY_FILE = REPO_ROOT / ".agents" / ".process_registry.json"
OPEN_ITEMS_LIMIT = 1000

# The orchestrator can run unattended for days; console scrollback alone loses
# the top of a long run. Mirror everything to a rotating file so history
# survives even when nobody is watching the terminal.
ORCHESTRATOR_LOG_FILE = LOG_DIR / "orchestrator.log"
ORCHESTRATOR_LOG_MAX_BYTES = 20 * 1024 * 1024
ORCHESTRATOR_LOG_BACKUP_COUNT = 5

# Per-task log files (one per dispatched AI process) are never rewritten, only
# added to, so on a long-lived swarm they grow without bound. Sweep files
# older than this on every startup.
TASK_LOG_RETENTION_DAYS = 14

# `gh` calls run on the polling thread; a hung network call would silently
# freeze the entire swarm (no dispatch, no status, no worktree cleanup) with
# no diagnostic. Bound every invocation so a stall surfaces as a normal error.
GH_TIMEOUT_SECONDS = 60

# How often (in polling cycles) to reconcile the local `main` checkout against
# `origin/main`. Every cycle would add a network round-trip to the hot path;
# this keeps main fresh without dominating the poll interval.
MAIN_SYNC_EVERY_CYCLES = 5

# A lifecycle event runs at most once successfully, but a crashed process is
# retried so a transient AI CLI failure cannot deadlock the swarm forever.
MAX_DISPATCH_ATTEMPTS = 3

# Process-tree shutdown is bounded across one supervision pass, not once per
# child. A finished leader may leave descendants behind, but harvesting several
# such leaders must not stall the polling thread for N * timeout seconds. One
# shared post-SIGKILL grace prevents an exhausted graceful budget from turning
# healthy groups into false residuals without adding per-child delay.
PROCESS_GROUP_STOP_TIMEOUT_SECONDS = 5
PROCESS_GROUP_KILL_GRACE_SECONDS = 0.25

# Provider quota/tool/timeout failures are availability pauses, not crashed
# task attempts. Keep them out of the bounded crash budget and retry after the
# provider's advertised reset, or after a conservative fallback cooldown.
PROVIDER_COOLDOWN_SECONDS = 60 * 60
PROVIDER_COOLDOWN_BUFFER_SECONDS = 60
PROVIDER_LIMIT_PATTERNS = (
    "individual quota reached",
    "monthly spend limit",
    "rate limit exceeded",
    "resource_exhausted",
    "too many requests",
)
EVENT_DEFER_PATTERNS = (
    "timeout waiting for response",
    "no_tool_withdrawn",
)

# `agy --print-timeout` defaults to 5m, which is shorter than a real Worker
# task (exploration + npm install + implementation). Without an explicit
# override, agy exits 1 with "Error: timeout waiting for response" well
# before finishing, burning all MAX_DISPATCH_ATTEMPTS on tasks that never
# had a chance to complete.
ANTIGRAVITY_PRINT_TIMEOUT = "45m"

# Stable reasons returned by ProcessTracker.should_dispatch().
DISPATCH_RUNNING = "already running"
DISPATCH_RESIDUAL = "residual process tree requires operator cleanup"
DISPATCH_COMPLETED = "already completed"
DISPATCH_UNCONFIRMED = "completed without confirmed lifecycle transition"
DISPATCH_PROVIDER_COOLDOWN = "provider cooldown"

# Upper bound on persisted history so the registry cannot grow without limit.
MAX_HISTORY_RECORDS = 500

# Metadata tag patterns
WORKER_PATTERN = re.compile(
    r"\[Worker:\s*(?P<ai>\w+)\s*\|\s*Model:\s*(?P<model>[^|]+?)\s*\|\s*Reasoning:\s*(?P<reasoning>[^\]]+?)\]",
    re.IGNORECASE,
)
REVIEWER_PATTERN = re.compile(
    r"\[Reviewer:\s*(?P<ai>\w+)\s*\|\s*Model:\s*(?P<model>[^|]+?)\s*\|\s*Reasoning:\s*(?P<reasoning>[^\]]+?)\]",
    re.IGNORECASE,
)
MAINTAINER_PATTERN = re.compile(
    r"\[Maintainer:\s*(?P<ai>\w+)\s*\|\s*Model:\s*(?P<model>[^|]+?)\s*\|\s*Reasoning:\s*(?P<reasoning>[^\]]+?)\]",
    re.IGNORECASE,
)
MAINTAINER_BLOCKED_PATTERN = re.compile(r"\[Maintainer Blocked\]", re.IGNORECASE)

# Default reviewer/maintainer rotation
DEFAULT_ROTATION = {
    "codex":       {"reviewer": "antigravity", "maintainer": "claude"},
    "antigravity": {"reviewer": "claude",      "maintainer": "codex"},
    "claude":      {"reviewer": "codex",       "maintainer": "antigravity"},
}

# Prompt temp file directory (cleaned on shutdown)
PROMPT_DIR = REPO_ROOT / ".agents" / ".prompts"


def ensure_runtime_git_excludes():
    """Hide local Swarm artifacts without changing the repository's shared .gitignore."""
    result = subprocess.run(
        ["git", "rev-parse", "--git-path", "info/exclude"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"Not a Git checkout: {REPO_ROOT}")

    exclude_path = Path(result.stdout.strip())
    if not exclude_path.is_absolute():
        exclude_path = REPO_ROOT / exclude_path
    exclude_path.parent.mkdir(parents=True, exist_ok=True)
    current = exclude_path.read_text() if exclude_path.exists() else ""
    patterns = (
        "/.worktrees/",
        "/.agents/logs/",
        "/.agents/.prompts/",
        "/.agents/.process_registry.json",
    )
    missing = [pattern for pattern in patterns if pattern not in current.splitlines()]
    if not missing:
        return
    separator = "" if not current or current.endswith("\n") else "\n"
    with exclude_path.open("a", encoding="utf-8") as stream:
        stream.write(separator + "\n".join(missing) + "\n")


_log_formatter = logging.Formatter(
    fmt="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_log_formatter)
logging.basicConfig(level=logging.INFO, handlers=[_console_handler])
log = logging.getLogger("swarm")
_file_handler: Optional[logging.Handler] = None


def enable_runtime_writes():
    """Configure local artifacts only for a real, non-dry-run swarm execution."""
    global _file_handler
    ensure_runtime_git_excludes()
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    if _file_handler is not None:
        return
    _file_handler = logging.handlers.RotatingFileHandler(
        ORCHESTRATOR_LOG_FILE,
        maxBytes=ORCHESTRATOR_LOG_MAX_BYTES,
        backupCount=ORCHESTRATOR_LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    _file_handler.setFormatter(_log_formatter)
    logging.getLogger().addHandler(_file_handler)

# Blocker states already reported, so a stuck PR cannot flood the log on every
# polling cycle. Keys include the head SHA or comment ID, so a new lifecycle
# signal is always reported again.
_REPORTED_BLOCKERS: set[str] = set()

# A POSIX signal can arrive after Popen has created a child but before that child
# is adopted in memory. The shared shutdown handler defers its KeyboardInterrupt
# while this narrow ownership-transfer section is active, then the dispatcher
# raises it as soon as the process is supervised and can be cleaned up safely.
_DISPATCH_REGISTRATION_DEPTH = 0
_SHUTDOWN_SIGNAL_PENDING = False


def _raise_if_shutdown_pending() -> None:
    """Surface a deferred shutdown once the ownership-transfer window closes."""
    if _SHUTDOWN_SIGNAL_PENDING and _DISPATCH_REGISTRATION_DEPTH == 0:
        raise KeyboardInterrupt


@contextmanager
def _defer_shutdown_during_process_registration():
    """Defer the shutdown exception until a new child is supervised."""
    global _DISPATCH_REGISTRATION_DEPTH
    _DISPATCH_REGISTRATION_DEPTH += 1
    try:
        yield
    finally:
        _DISPATCH_REGISTRATION_DEPTH -= 1
        # Keep this check inside finally: if spawn/adoption itself raises after
        # a signal was deferred, shutdown must supersede that failure instead
        # of leaving the pending flag set and swallowing every later signal.
        _raise_if_shutdown_pending()


@contextmanager
def _shutdown_signal_controller():
    """Route SIGINT/SIGTERM through one cleanup path for loop and one-shot runs."""
    global _SHUTDOWN_SIGNAL_PENDING
    _SHUTDOWN_SIGNAL_PENDING = False
    previous_handlers = {}

    def handle_signal(signum, _frame):
        global _SHUTDOWN_SIGNAL_PENDING
        if _SHUTDOWN_SIGNAL_PENDING:
            return
        _SHUTDOWN_SIGNAL_PENDING = True
        log.info("Received signal %d, shutting down...", signum)
        if _DISPATCH_REGISTRATION_DEPTH == 0:
            raise KeyboardInterrupt

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, handle_signal)
        yield
    finally:
        for signum, previous_handler in previous_handlers.items():
            signal.signal(signum, previous_handler)
        _SHUTDOWN_SIGNAL_PENDING = False


def log_blocker(key: str, message: str, *args, level: int = logging.ERROR):
    """Report a lifecycle blocker once at `level`, then at DEBUG while it persists."""
    if key in _REPORTED_BLOCKERS:
        log.debug(message, *args)
        return
    if len(_REPORTED_BLOCKERS) > MAX_HISTORY_RECORDS:
        _REPORTED_BLOCKERS.clear()
    _REPORTED_BLOCKERS.add(key)
    log.log(level, message, *args)


def log_dispatch_blocker(key: str, subject: str, reason: str):
    """Report terminal or deferred dispatch state without poll-cycle spam."""
    if (
        reason.startswith("exhausted")
        or reason in {DISPATCH_UNCONFIRMED, DISPATCH_RESIDUAL}
    ):
        log_blocker(key, "%s dispatch blocked: %s.", subject, reason)
    elif reason.startswith(DISPATCH_PROVIDER_COOLDOWN):
        log_blocker(
            key,
            "%s dispatch deferred: %s.",
            subject,
            reason,
            level=logging.WARNING,
        )


def _item_preflight_blocker_prefix(
    item_kind: str,
    item_number: object,
    lifecycle_version: str,
) -> str:
    """Return the bounded, message-independent namespace for one item lifecycle."""
    return f"item-preflight:{item_kind}:{item_number}:{lifecycle_version}:"


def clear_item_preflight_blockers(
    item_kind: str,
    item_number: object,
    lifecycle_version: str,
) -> None:
    """Let a repaired item report the same preflight class if it later recurs."""
    prefix = _item_preflight_blocker_prefix(
        item_kind,
        item_number,
        lifecycle_version,
    )
    _REPORTED_BLOCKERS.difference_update(
        key for key in tuple(_REPORTED_BLOCKERS) if key.startswith(prefix)
    )


def log_item_preflight_blocker(
    item_kind: str,
    item_number: object,
    lifecycle_version: str,
    error: "SwarmPreflightError",
) -> None:
    """Report one typed preflight blocker per uninterrupted blocked lifecycle."""
    log_blocker(
        _item_preflight_blocker_prefix(
            item_kind,
            item_number,
            lifecycle_version,
        )
        + type(error).__name__,
        "%s #%s dispatch blocked by a retryable preflight condition; automatic retry "
        "remains enabled: %s",
        item_kind,
        item_number,
        error,
    )


# ---------------------------------------------------------------------------
# Data Classes
# ---------------------------------------------------------------------------

class ProcessStatus(str, Enum):
    RUNNING = "running"
    STUCK = "stuck"
    COMPLETED = "completed"
    FAILED = "failed"
    DEFERRED = "deferred"
    UNKNOWN = "unknown"


@dataclass
class RoleAssignment:
    ai: str
    model: str
    reasoning: str


@dataclass
class TaskIssue:
    number: int
    title: str
    body: str
    worker: Optional[RoleAssignment] = None


@dataclass
class TaskPR:
    number: int
    title: str
    body: str
    head_branch: str
    head_sha: str = ""
    is_cross_repository: bool = False
    issue_number: Optional[int] = None
    reviewer: Optional[RoleAssignment] = None


@dataclass(frozen=True)
class RepoWorkflowCapability:
    """Read-only verdict for the active gh CLI credential in this repository."""
    repository: str
    ok: bool
    gaps: tuple[str, ...]
    unverified: tuple[str, ...]


@dataclass(frozen=True)
class SshEndpoint:
    """The effective SSH authority Git will contact after local config resolution."""
    host: str
    user: str
    port: int


@dataclass(frozen=True)
class HttpEndpoint:
    """The HTTPS authority used by Git and bound to the gh API probe."""
    scheme: str
    host: str
    port: int


@dataclass(frozen=True)
class GitHubRepoTarget:
    """The GitHub repository selected by this checkout's origin remote."""
    host: str
    owner: str
    repo: str
    ssh_endpoint: Optional[SshEndpoint] = field(default=None, compare=False, repr=False)
    http_endpoint: Optional[HttpEndpoint] = field(default=None, compare=False, repr=False)

    @property
    def name(self) -> str:
        return f"{self.owner}/{self.repo}"

    @property
    def gh_context(self) -> str:
        return f"{self.host}/{self.name}"


class SwarmPreflightError(RuntimeError):
    """Base class for safe, operator-facing write-preflight failures."""


class SwarmCapabilityError(SwarmPreflightError):
    """A permanent repository or credential blocker."""

    def __init__(self, capability: RepoWorkflowCapability):
        self.capability = capability
        super().__init__(describe_repo_workflow_capability(capability))


class SwarmPreflightTransientError(SwarmPreflightError):
    """A transient or indeterminate lookup failure, never a permission verdict."""


class SwarmPreflightConfigError(SwarmPreflightError):
    """A local prerequisite failure, such as a missing gh executable."""


@dataclass
class TrackedProcess:
    """A dispatched AI subprocess with full lifecycle metadata."""
    pid: Optional[int]
    role: str           # "worker", "reviewer", "maintainer"
    ai_name: str
    model: str
    reasoning: str
    task_ref: str        # e.g. "issue#3" or "pr#5"
    branch: str
    command: str
    cwd: str
    log_file: str
    started_at: str      # ISO 8601
    ended_at: Optional[str] = None
    exit_code: Optional[int] = None
    status: str = ProcessStatus.RUNNING
    failure_reason: Optional[str] = None
    retry_after: Optional[str] = None
    defer_scope: Optional[str] = None


def _process_group_exists(process_group_id: int) -> bool:
    """Return whether a POSIX process group still has at least one member."""
    try:
        os.killpg(process_group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _wait_for_process_groups_exit(
    processes: dict[int, subprocess.Popen],
    deadline: float,
) -> dict[int, subprocess.Popen]:
    """Return groups still alive after one shared, bounded observation window."""
    remaining = dict(processes)
    while True:
        alive = {}
        for process_group_id, proc in remaining.items():
            # Reap a finished direct child before testing its process group. A
            # zombie leader otherwise keeps its PID/PGID visible and can be
            # misclassified as a residual tree.
            proc.poll()
            if _process_group_exists(process_group_id):
                alive[process_group_id] = proc
        remaining = alive
        now = time.monotonic()
        if not remaining or now >= deadline:
            return remaining
        time.sleep(min(0.05, deadline - now))


def _assert_dispatch_platform() -> None:
    """Fail before mutation when descendant-safe process ownership is unavailable."""
    if os.name != "posix":
        raise SwarmPreflightConfigError(
            "Autonomous Swarm dispatch requires POSIX process-group isolation on this platform.",
        )


def terminate_process_groups(
    processes: list[subprocess.Popen],
    timeout: float = PROCESS_GROUP_STOP_TIMEOUT_SECONDS,
) -> dict[int, bool]:
    """Terminate agent trees in parallel within one shared supervision budget."""
    process_map = {proc.pid: proc for proc in processes}
    if not process_map:
        return {}
    if os.name != "posix":
        log.error("Process-tree termination is unsupported on this platform.")
        return {process_group_id: False for process_group_id in process_map}

    started_at = time.monotonic()
    timeout = max(0, timeout)
    term_deadline = started_at + timeout / 2
    configured_deadline = started_at + timeout
    term_candidates = {}

    # Signal every group before waiting for any one group, so a stubborn tree
    # cannot consume the observation window of a healthy peer.
    for process_group_id, proc in process_map.items():
        proc.poll()
        if not _process_group_exists(process_group_id):
            continue
        term_candidates[process_group_id] = proc
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            term_candidates.pop(process_group_id, None)
            proc.poll()
        except PermissionError:
            # Keep observing. The group may still disappear on its own, and the
            # final existence check is more accurate than the signal race.
            log.debug("Process group for PID %d could not be signalled.", process_group_id)

    kill_candidates = _wait_for_process_groups_exit(term_candidates, term_deadline)
    for process_group_id, proc in list(kill_candidates.items()):
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            kill_candidates.pop(process_group_id, None)
            proc.poll()
        except PermissionError:
            # A concurrent owner may still remove the group. Report an error
            # only if the final shared observation finds a survivor.
            log.debug("Process group for PID %d could not be killed.", process_group_id)

    final_deadline = max(
        configured_deadline,
        time.monotonic() + PROCESS_GROUP_KILL_GRACE_SECONDS,
    )
    survivors = _wait_for_process_groups_exit(kill_candidates, final_deadline)
    results = {}
    for process_group_id, proc in process_map.items():
        stopped = process_group_id not in survivors
        results[process_group_id] = stopped
        if stopped:
            proc.poll()
        else:
            log.error("Process group for PID %d did not exit after SIGKILL.", process_group_id)
    return results


def terminate_process_group(proc: subprocess.Popen, timeout: float = 5) -> bool:
    """Terminate one dispatched agent tree through the shared batch primitive."""
    return terminate_process_groups([proc], timeout=timeout)[proc.pid]


# ---------------------------------------------------------------------------
# Process Tracker — PID registry with poll()-based status checks
# ---------------------------------------------------------------------------

class ProcessTracker:
    """Tracks all dispatched AI subprocesses and their lifecycle."""

    def __init__(self):
        self._active: dict[int, tuple[subprocess.Popen, TrackedProcess]] = {}
        self._history: list[TrackedProcess] = []
        self._load_registry()

    # --- Persistence ---

    def _load_registry(self):
        """Load previous process history from disk (for --status across runs)."""
        if PROCESS_REGISTRY_FILE.exists():
            try:
                with open(PROCESS_REGISTRY_FILE) as f:
                    data = json.load(f)
                for entry in data.get("history", []):
                    self._history.append(TrackedProcess(**entry))
            except (json.JSONDecodeError, TypeError):
                log.warning("Corrupted process registry, starting fresh.")
        self._reconcile_orphans()
        self._reclassify_deferred_failures()

    def _reclassify_deferred_failures(self):
        """Upgrade historical transient failures so a restart can recover them."""
        for record in self._history:
            if record.status != ProcessStatus.FAILED:
                continue
            output_tail = self._read_log_tail(record.log_file, 2000)
            retry_after = self._provider_retry_after(output_tail, record.ended_at)
            if not retry_after:
                continue
            record.status = ProcessStatus.DEFERRED
            record.failure_reason = self._failure_summary(output_tail)
            record.retry_after = retry_after
            record.defer_scope = self._defer_scope(output_tail)

    def _reconcile_orphans(self):
        """Demote records left RUNNING by a crashed orchestrator.

        A previous run that died without `kill_all()` leaves records claiming to
        be running. Treating those as live would block their lifecycle event
        forever, so any record whose PID is gone becomes UNKNOWN and therefore
        retryable.
        """
        for record in self._history:
            if record.status not in (ProcessStatus.RUNNING, ProcessStatus.STUCK):
                continue
            leader_alive = bool(
                record.pid is not None
                and self.check_pid_alive(record.pid, record.command)
            )
            group_alive = bool(
                record.pid is not None
                and os.name == "posix"
                and _process_group_exists(record.pid)
            )
            if leader_alive:
                continue
            if group_alive:
                record.status = ProcessStatus.STUCK
                record.failure_reason = DISPATCH_RESIDUAL
                log.warning(
                    "Residual process group %d for %s still exists; terminate it outside MAO "
                    "and restart Swarm before retrying this event.",
                    record.pid,
                    record.task_ref,
                )
                continue
            record.status = ProcessStatus.UNKNOWN
            record.ended_at = record.ended_at or datetime.now(timezone.utc).isoformat()
            log.warning(
                "Orphaned %s record for %s [PID %d] marked UNKNOWN; event is retryable.",
                record.role, record.task_ref, record.pid,
            )

    def _save_registry(self):
        """Persist process registry to disk."""
        PROCESS_REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
        if len(self._history) > MAX_HISTORY_RECORDS:
            self._history = self._history[-MAX_HISTORY_RECORDS:]
        all_records = self._history + [tp for _, tp in self._active.values()]
        payload = {
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "history": [vars(r) for r in all_records],
        }
        temporary_path: Optional[Path] = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=PROCESS_REGISTRY_FILE.parent,
                prefix=f".{PROCESS_REGISTRY_FILE.name}.",
                delete=False,
            ) as stream:
                temporary_path = Path(stream.name)
                json.dump(payload, stream, indent=2, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, PROCESS_REGISTRY_FILE)
        except BaseException:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            raise

    def record_failed_attempt(
        self,
        role: str,
        ai_name: str,
        model: str,
        reasoning: str,
        task_ref: str,
        branch: str,
        command: str,
        cwd: str,
        log_file: str,
        failure_reason: str,
    ) -> TrackedProcess:
        """Persist a failed dispatch that occurred before a child PID existed."""
        timestamp = datetime.now(timezone.utc).isoformat()
        tracked = TrackedProcess(
            pid=None,
            role=role,
            ai_name=ai_name,
            model=model,
            reasoning=reasoning,
            task_ref=task_ref,
            branch=branch,
            command=command,
            cwd=cwd,
            log_file=log_file,
            started_at=timestamp,
            ended_at=timestamp,
            status=ProcessStatus.FAILED,
            failure_reason=failure_reason,
        )
        self._history.append(tracked)
        self._save_registry()
        return tracked

    # --- Registration ---

    def adopt(self, proc: subprocess.Popen, role: str, ai_name: str,
              model: str, reasoning: str, task_ref: str, branch: str,
              command: str, cwd: str, log_file: str) -> TrackedProcess:
        """Take in-memory ownership of a child without blocking on registry I/O."""
        tracked = TrackedProcess(
            pid=proc.pid,
            role=role,
            ai_name=ai_name,
            model=model,
            reasoning=reasoning,
            task_ref=task_ref,
            branch=branch,
            command=command,
            cwd=cwd,
            log_file=log_file,
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        self._active[proc.pid] = (proc, tracked)
        log.info(
            "📌 Registered %s [PID %d] — %s (%s, %s)",
            role, proc.pid, task_ref, ai_name, model,
        )
        return tracked

    def persist_registration(self) -> None:
        """Persist an already-adopted child outside the signal-deferral window."""
        self._save_registry()

    def register(self, proc: subprocess.Popen, role: str, ai_name: str,
                 model: str, reasoning: str, task_ref: str, branch: str,
                 command: str, cwd: str, log_file: str) -> TrackedProcess:
        """Adopt and persist a newly launched subprocess."""
        tracked = self.adopt(
            proc=proc,
            role=role,
            ai_name=ai_name,
            model=model,
            reasoning=reasoning,
            task_ref=task_ref,
            branch=branch,
            command=command,
            cwd=cwd,
            log_file=log_file,
        )
        self.persist_registration()
        return tracked

    # --- Polling ---

    def poll_all(self):
        """Poll children and clean finished process groups in one bounded batch."""
        finished_pids = []
        registry_changed = False
        poll_results = {
            pid: proc.poll()
            for pid, (proc, _) in self._active.items()
        }
        cleanup_processes = [
            proc
            for pid, (proc, tracked) in self._active.items()
            if poll_results[pid] is not None
            and tracked.status != ProcessStatus.STUCK
        ]
        cleanup_results = (
            terminate_process_groups(
                cleanup_processes,
                timeout=PROCESS_GROUP_STOP_TIMEOUT_SECONDS,
            )
            if cleanup_processes
            else {}
        )

        for pid, (proc, tracked) in self._active.items():
            retcode = poll_results[pid]

            if retcode is None:
                # Still running — log a heartbeat
                elapsed = self._elapsed_str(tracked.started_at)
                log.info(
                    "⏳ [PID %d] %s %s — running for %s",
                    pid, tracked.role.upper(), tracked.task_ref, elapsed,
                )
            else:
                # Process finished
                if tracked.status == ProcessStatus.STUCK:
                    # The original process group was already signalled once. Never keep sending
                    # signals to a numeric PGID after a failed teardown because it may later be
                    # reused by an unrelated process group. An operator can terminate the residual
                    # tree; the next poll then observes its absence and completes the record.
                    if _process_group_exists(pid):
                        log_blocker(
                            f"residual-process-group:{pid}",
                            "Residual process group %d for %s still exists; terminate it outside "
                            "MAO, then let Swarm poll again.",
                            pid,
                            tracked.task_ref,
                        )
                        continue
                else:
                    if not cleanup_results[pid]:
                        tracked.status = ProcessStatus.STUCK
                        tracked.exit_code = retcode
                        tracked.failure_reason = DISPATCH_RESIDUAL
                        registry_changed = True
                        log_blocker(
                            f"residual-process-group:{pid}",
                            "Residual process group %d for %s could not be stopped; terminate it "
                            "outside MAO, then let Swarm poll again.",
                            pid,
                            tracked.task_ref,
                        )
                        continue
                tracked.exit_code = retcode
                tracked.ended_at = datetime.now(timezone.utc).isoformat()
                elapsed = self._elapsed_str(tracked.started_at)
                output_tail = self._read_log_tail(tracked.log_file, 2000)
                tracked.retry_after = self._provider_retry_after(
                    output_tail,
                    tracked.ended_at,
                )

                if tracked.retry_after:
                    tracked.status = ProcessStatus.DEFERRED
                    tracked.failure_reason = self._failure_summary(output_tail)
                    tracked.defer_scope = self._defer_scope(output_tail)
                    log.warning(
                        "⏸️ [PID %d] %s %s — provider unavailable "
                        "(exit %d, %s); retry after %s\n  output: %s",
                        pid, tracked.role.upper(), tracked.task_ref,
                        retcode, elapsed, tracked.retry_after,
                        tracked.failure_reason,
                    )
                elif retcode == 0:
                    tracked.status = ProcessStatus.COMPLETED
                    log.info(
                        "✅ [PID %d] %s %s — completed successfully (%s)",
                        pid, tracked.role.upper(), tracked.task_ref, elapsed,
                    )
                else:
                    tracked.failure_reason = self._failure_summary(output_tail)
                    tracked.status = ProcessStatus.FAILED
                    log.error(
                        "❌ [PID %d] %s %s — failed (exit %d, %s)\n"
                        "  output: %s",
                        pid, tracked.role.upper(), tracked.task_ref,
                        retcode, elapsed,
                        tracked.failure_reason or "(empty)",
                    )

                finished_pids.append(pid)
                registry_changed = True

        # Move finished processes to history
        for pid in finished_pids:
            _, tracked = self._active.pop(pid)
            self._history.append(tracked)

        if registry_changed:
            self._save_registry()

    def check_pid_alive(self, pid: int, command: Optional[str] = None) -> bool:
        """Check if a PID is still alive via OS signal 0 and matches command if provided."""
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True  # Alive, just can't signal it

        if command:
            try:
                # ps -p <pid> -o command=
                result = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "command="],
                    capture_output=True, text=True, check=False
                )
                if result.returncode == 0:
                    ps_command = result.stdout.strip().lower()
                    # Extract binary name from command
                    exe_name = command.split()[0].split("/")[-1].lower()
                    return exe_name in ps_command
            except Exception:
                # Fallback to True if ps fails
                return True
            return False
        return True

    # --- Queries ---

    def is_active(self, task_ref: str, role: str) -> bool:
        """Check if there is an active process for the given task and role."""
        for tp in self.active_processes:
            if tp.task_ref == task_ref and tp.role == role:
                return True
        return False

    def should_dispatch(
        self,
        task_ref: str,
        role: str,
        completion_confirmed: bool = True,
        ai_name: Optional[str] = None,
    ) -> tuple[bool, str]:
        """Decide whether a lifecycle event still needs a process, with a reason.

        Task references identify lifecycle events rather than only an Issue or
        PR, so dispatch stays idempotent across polling cycles and orchestrator
        restarts while the Worker/Reviewer loop can still advance when a new
        review comment or commit creates a new event.

        A running or completed attempt always blocks another dispatch for the
        same lifecycle event. In particular, a successful process without its
        required GitHub signal is surfaced as an unconfirmed-completion blocker
        instead of being run again, preserving the one-successful-dispatch
        invariant.

        Provider-wide quota failures pause until their cooldown expires and do
        not consume the bounded crash retry budget. Event-local timeouts and
        tool withdrawals do consume it after their cooldown, so one broken
        lifecycle event cannot be relaunched forever.
        """
        attempts = [
            record for record in self.all_records
            if record.task_ref == task_ref and record.role == role
        ]
        if any(record.status == ProcessStatus.RUNNING for record in attempts):
            return False, DISPATCH_RUNNING
        if any(record.status == ProcessStatus.STUCK for record in attempts):
            return False, DISPATCH_RESIDUAL
        provider_cooldowns = []
        if ai_name:
            for record in self.all_records:
                if (
                    record.status != ProcessStatus.DEFERRED
                    or record.ai_name != ai_name
                    or record.defer_scope != "provider"
                    or not record.retry_after
                ):
                    continue
                retry_at = datetime.fromisoformat(record.retry_after)
                if datetime.now(timezone.utc) < retry_at:
                    provider_cooldowns.append(retry_at)
        if provider_cooldowns:
            retry_at = max(provider_cooldowns).isoformat()
            return False, f"{DISPATCH_PROVIDER_COOLDOWN} until {retry_at}"
        if not attempts:
            return True, "new event"

        bounded_failures = [
            record for record in attempts
            if record.status in (ProcessStatus.FAILED, ProcessStatus.UNKNOWN)
            or (
                record.status == ProcessStatus.DEFERRED
                and record.defer_scope == "event"
            )
        ]
        completed_attempts = [
            record for record in attempts
            if record.status == ProcessStatus.COMPLETED
        ]
        if completed_attempts:
            if completion_confirmed:
                return False, DISPATCH_COMPLETED
            return False, DISPATCH_UNCONFIRMED
        if len(bounded_failures) >= MAX_DISPATCH_ATTEMPTS:
            return False, f"exhausted {len(bounded_failures)} failed attempts"
        deferred = [
            record for record in attempts
            if record.status == ProcessStatus.DEFERRED
        ]
        if deferred:
            latest = deferred[-1]
            if latest.retry_after:
                retry_at = datetime.fromisoformat(latest.retry_after)
                if datetime.now(timezone.utc) < retry_at:
                    return (
                        False,
                        f"{DISPATCH_PROVIDER_COOLDOWN} until {latest.retry_after}",
                    )
        if deferred:
            return True, "retry after provider cooldown"
        return (
            True,
            f"retry {len(bounded_failures) + 1}/{MAX_DISPATCH_ATTEMPTS} after failure",
        )

    @property
    def active_count(self) -> int:
        return len(self._active)

    @property
    def active_processes(self) -> list[TrackedProcess]:
        return [tp for _, tp in self._active.values()]

    @property
    def all_records(self) -> list[TrackedProcess]:
        return self._history + [tp for _, tp in self._active.values()]

    def get_summary(self) -> str:
        """Generate a human-readable status summary."""
        lines = []
        lines.append("=" * 72)
        lines.append("🤖 SWARM PROCESS STATUS")
        lines.append("=" * 72)

        # Active processes
        active = self.active_processes
        lines.append(f"\n🟢 Active ({len(active)}):")
        if active:
            for tp in active:
                elapsed = self._elapsed_str(tp.started_at)
                status = tp.status.value if isinstance(tp.status, ProcessStatus) else tp.status
                lines.append(
                    f"  PID {tp.pid:>7}  │ {tp.role:<12} │ {tp.ai_name:<14} │ "
                    f"{tp.task_ref:<12} │ {status:<8} │ ⏱ {elapsed}"
                )
        else:
            lines.append("  (none)")

        # Recent history (last 10)
        recent = self._history[-10:]
        lines.append(f"\n📜 Recent History (last {len(recent)}):")
        if recent:
            for tp in recent:
                if tp.status == ProcessStatus.COMPLETED:
                    icon = "✅"
                elif tp.status == ProcessStatus.DEFERRED:
                    icon = "⏸️"
                else:
                    icon = "❌"
                duration = self._duration_str(tp.started_at, tp.ended_at)
                pid_label = str(tp.pid) if tp.pid is not None else "-"
                lines.append(
                    f"  {icon} PID {pid_label:>7}  │ {tp.role:<12} │ {tp.ai_name:<14} │ "
                    f"{tp.task_ref:<12} │ exit={tp.exit_code} │ ⏱ {duration}"
                )
        else:
            lines.append("  (none)")

        # Stats
        total = len(self._history)
        succeeded = sum(1 for tp in self._history if tp.status == ProcessStatus.COMPLETED)
        failed = sum(1 for tp in self._history if tp.status == ProcessStatus.FAILED)
        deferred = sum(
            1 for tp in self._history if tp.status == ProcessStatus.DEFERRED
        )
        lines.append(
            f"\n📊 Totals: {total} finished "
            f"({succeeded} ✅, {failed} ❌, {deferred} ⏸️), "
            f"{len(active)} running"
        )
        lines.append("=" * 72)
        return "\n".join(lines)

    # --- Cleanup ---

    def kill_all(self) -> bool:
        """Terminate every process group and report whether shutdown is safe."""
        survivors = {}
        cleanup_processes = [
            proc
            for proc, tracked in self._active.values()
            if tracked.status != ProcessStatus.STUCK
        ]
        cleanup_results = (
            terminate_process_groups(
                cleanup_processes,
                timeout=PROCESS_GROUP_STOP_TIMEOUT_SECONDS,
            )
            if cleanup_processes
            else {}
        )
        for pid, (proc, tracked) in list(self._active.items()):
            log.warning("🛑 Killing [PID %d] %s %s", pid, tracked.role, tracked.task_ref)
            if tracked.status == ProcessStatus.STUCK:
                if _process_group_exists(pid):
                    survivors[pid] = (proc, tracked)
                    continue
                if tracked.exit_code is None:
                    tracked.exit_code = proc.returncode
                tracked.ended_at = datetime.now(timezone.utc).isoformat()
                tracked.status = ProcessStatus.FAILED
                self._history.append(tracked)
                continue
            if not cleanup_results[pid]:
                tracked.status = ProcessStatus.STUCK
                tracked.failure_reason = DISPATCH_RESIDUAL
                survivors[pid] = (proc, tracked)
                continue
            tracked.exit_code = proc.returncode
            tracked.ended_at = datetime.now(timezone.utc).isoformat()
            tracked.status = ProcessStatus.FAILED
            self._history.append(tracked)
        self._active = survivors
        self._save_registry()
        return not survivors

    # --- Helpers ---

    @staticmethod
    def _elapsed_str(started_at: str) -> str:
        start = datetime.fromisoformat(started_at)
        delta = datetime.now(timezone.utc) - start
        secs = int(delta.total_seconds())
        if secs < 60:
            return f"{secs}s"
        if secs < 3600:
            return f"{secs // 60}m {secs % 60}s"
        return f"{secs // 3600}h {(secs % 3600) // 60}m"

    @staticmethod
    def _duration_str(started_at: str, ended_at: Optional[str]) -> str:
        if not ended_at:
            return "?"
        start = datetime.fromisoformat(started_at)
        end = datetime.fromisoformat(ended_at)
        secs = int((end - start).total_seconds())
        if secs < 60:
            return f"{secs}s"
        if secs < 3600:
            return f"{secs // 60}m {secs % 60}s"
        return f"{secs // 3600}h {(secs % 3600) // 60}m"

    @staticmethod
    def _read_log_tail(log_file: str, max_bytes: int = 500) -> str:
        if not log_file:
            return ""
        try:
            path = Path(log_file)
            with path.open("rb") as stream:
                stream.seek(0, os.SEEK_END)
                size = stream.tell()
                stream.seek(max(0, size - max_bytes))
                return stream.read().decode("utf-8", errors="replace")
        except OSError:
            return ""

    @staticmethod
    def _failure_summary(output: str) -> str:
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        return lines[-1][-500:] if lines else ""

    @staticmethod
    def _provider_retry_after(
        output: str,
        ended_at: Optional[str] = None,
    ) -> Optional[str]:
        lowered = output.lower()
        deferred_patterns = PROVIDER_LIMIT_PATTERNS + EVENT_DEFER_PATTERNS
        if not any(pattern in lowered for pattern in deferred_patterns):
            return None

        reset_match = re.search(
            r"resets?\s+in\s+"
            r"(?:(?P<hours>\d+)h)?"
            r"(?:(?P<minutes>\d+)m)?"
            r"(?:(?P<seconds>\d+)s)?",
            lowered,
        )
        delay = PROVIDER_COOLDOWN_SECONDS
        if reset_match and any(reset_match.groupdict().values()):
            delay = (
                int(reset_match.group("hours") or 0) * 3600
                + int(reset_match.group("minutes") or 0) * 60
                + int(reset_match.group("seconds") or 0)
                + PROVIDER_COOLDOWN_BUFFER_SECONDS
            )

        base = (
            datetime.fromisoformat(ended_at)
            if ended_at
            else datetime.now(timezone.utc)
        )
        return (base + timedelta(seconds=delay)).isoformat()

    @staticmethod
    def _defer_scope(output: str) -> Optional[str]:
        lowered = output.lower()
        if any(pattern in lowered for pattern in PROVIDER_LIMIT_PATTERNS):
            return "provider"
        if any(pattern in lowered for pattern in EVENT_DEFER_PATTERNS):
            return "event"
        return None


# Global tracker instance
tracker = ProcessTracker()


def reset_process_history():
    """Start a fresh run with no persisted dispatch failures or active state."""
    tracker._active.clear()
    tracker._history.clear()
    if PROCESS_REGISTRY_FILE.exists():
        PROCESS_REGISTRY_FILE.unlink()


# ---------------------------------------------------------------------------
# GitHub CLI Helpers
# ---------------------------------------------------------------------------


_CAPABILITY_GAP_REASONS = {
    "gh-not-authenticated": "the gh CLI is not authenticated",
    "repo-not-found": (
        "the repository does not exist, or the active gh credential cannot see it "
        "(GitHub reports both as 404)"
    ),
    "bad-credentials": "GitHub rejected the active gh CLI credential",
    "sso-authorization-required": (
        "the organization enforces SAML SSO and the active gh credential is not authorized for it"
    ),
    "installation-suspended": "the GitHub App installation for this repository is suspended",
    "resource-not-accessible": (
        "GitHub reports that the active gh credential was not granted access to this repository"
    ),
    "legally-unavailable": "the repository is unavailable for legal reasons",
    "archived": "the repository is archived, so GitHub rejects every write",
    "disabled": "the repository is disabled",
    "issues-disabled": "the Issues feature is disabled, so swarm cannot manage task issues",
    "permissions-unknown": (
        "GitHub returned no permissions.push value, so Contents: write cannot be established"
    ),
    "no-push-permission": (
        "the active gh credential has read-only repository access "
        "(permissions.push is false; Contents: write is missing)"
    ),
    "oauth-scope-missing": (
        "the classic gh token has neither repo nor applicable public_repo write scope"
    ),
}
_CAPABILITY_GAP_REMEDIES = {
    "gh-not-authenticated": "configure-gh",
    "repo-not-found": "repository-state",
    "bad-credentials": "replace-gh-credential",
    "sso-authorization-required": "authorize-sso",
    "installation-suspended": "unsuspend-installation",
    "resource-not-accessible": "grant-write",
    "legally-unavailable": "repository-state",
    "archived": "repository-state",
    "disabled": "repository-state",
    "issues-disabled": "repository-state",
    "permissions-unknown": "grant-write",
    "no-push-permission": "grant-write",
    "oauth-scope-missing": "grant-write",
}
_CAPABILITY_REMEDY_RANK = {
    "repository-state": 0,
    "unsuspend-installation": 1,
    "authorize-sso": 2,
    "replace-gh-credential": 3,
    "configure-gh": 4,
    "grant-write": 5,
}
_CAPABILITY_REMEDY_TEXT = {
    "repository-state": "Fix the repository state or select a different repository, then retry.",
    "configure-gh": "Run `gh auth login` with a write credential, then retry.",
    "replace-gh-credential": "Run `gh auth login` with a working write credential, then retry.",
    "authorize-sso": (
        "Authorize the active gh credential for the organization's SAML SSO, then retry."
    ),
    "unsuspend-installation": "Unsuspend the GitHub App installation, then retry.",
    "grant-write": (
        "Grant the active gh CLI credential Issues, Contents and Pull requests write access, "
        "then retry."
    ),
}
_UNVERIFIED_GRANT_LABELS = {
    "issues-write": "Issues: write",
    "contents-write": "Contents: write",
    "pull-requests-write": "Pull requests: write",
}
_PIPELINE_GRANTS = ("issues-write", "contents-write", "pull-requests-write")
_ACTIVE_GH_REPO_CONTEXT: Optional[str] = None
_ACTIVE_REPO_TARGET: Optional[GitHubRepoTarget] = None


def _bound_gh_environment(repo_context: Optional[str] = None) -> dict[str, str]:
    """Pin gh repository selection while preserving the credential-bearing environment."""
    environment = os.environ.copy()
    selected = repo_context or _ACTIVE_GH_REPO_CONTEXT
    if not selected:
        raise SwarmPreflightConfigError(
            "The GitHub repository context is not bound to this checkout's origin.",
        )
    environment["GH_REPO"] = selected
    host, separator, _ = selected.partition("/")
    if not separator:
        raise SwarmPreflightConfigError(
            "The GitHub repository context is invalid; re-run swarm from a GitHub checkout.",
        )
    environment["GH_HOST"] = host
    return environment


def _read_origin_urls(push: bool, repo_root: Path = REPO_ROOT) -> list[str]:
    """Read every effective origin URL without exposing its potentially secret-bearing value."""
    args = ["git", "remote", "get-url", "--all"]
    if push:
        args.append("--push")
    args.append("origin")
    try:
        result = subprocess.run(
            args,
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        raise SwarmPreflightConfigError(
            "git is required for mao swarm; install it and retry",
        ) from None
    except OSError:
        raise SwarmPreflightConfigError(
            "git could not inspect the selected checkout's origin; retry after fixing the local "
            "Git installation",
        ) from None
    urls = [line for line in result.stdout.splitlines() if line]
    if result.returncode != 0 or not urls:
        raise SwarmPreflightConfigError(
            "The selected checkout has no readable origin remote. Configure its GitHub origin, "
            "then retry.",
        )
    return urls


def _assert_standard_git_ssh_context(repo_root: Path = REPO_ROOT) -> None:
    """Fail closed when Git would not use the system SSH configuration we inspect."""
    if os.environ.get("GIT_SSH_COMMAND") or os.environ.get("GIT_SSH"):
        raise SwarmPreflightConfigError(
            "Swarm cannot verify an SSH origin while GIT_SSH_COMMAND or GIT_SSH overrides Git's "
            "transport. Unset the override or use an HTTPS origin, then retry.",
        )
    try:
        result = subprocess.run(
            ["git", "config", "--get", "core.sshCommand"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        raise SwarmPreflightConfigError(
            "git could not inspect the SSH transport configuration for this checkout.",
        ) from None
    if result.returncode == 0 and result.stdout.strip():
        raise SwarmPreflightConfigError(
            "Swarm cannot verify an SSH origin with core.sshCommand configured. Remove the "
            "override or use an HTTPS origin, then retry.",
        )
    if result.returncode not in {0, 1}:
        raise SwarmPreflightConfigError(
            "git could not inspect the SSH transport configuration for this checkout.",
        )


def _resolve_ssh_endpoint(
    host: str,
    user: Optional[str] = None,
    port: Optional[int] = None,
    repo_root: Path = REPO_ROOT,
    verify_transport: bool = True,
) -> SshEndpoint:
    """Resolve the exact SSH host, user, and port Git will use for this remote."""
    if verify_transport:
        _assert_standard_git_ssh_context(repo_root)
    args = ["ssh", "-G"]
    if user:
        args.extend(["-l", user])
    if port is not None:
        args.extend(["-p", str(port)])
    args.extend(["--", host])
    try:
        result = subprocess.run(
            args,
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        raise SwarmPreflightConfigError(
            "ssh is required to resolve this checkout's SSH origin; install it and retry",
        ) from None
    except subprocess.TimeoutExpired:
        raise SwarmPreflightTransientError(
            "ssh timed out while resolving the selected checkout's origin host.",
        ) from None
    except OSError:
        raise SwarmPreflightConfigError(
            "ssh could not resolve the selected checkout's origin host.",
        ) from None

    if result.returncode != 0:
        raise SwarmPreflightConfigError(
            "ssh could not resolve the selected checkout's origin host.",
        )
    resolved_values: dict[str, str] = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition(" ")
        normalized_key = key.lower()
        normalized_value = value.strip()
        if (
            separator
            and normalized_key in {"proxycommand", "proxyjump"}
            and normalized_value.lower() not in {"", "none"}
        ):
            raise SwarmPreflightConfigError(
                "Swarm cannot verify an SSH origin that uses ProxyCommand or ProxyJump. "
                "Remove the proxy override or use an HTTPS origin, then retry.",
            )
        if separator and normalized_key in {"hostname", "user", "port"} and value.strip():
            resolved_values[normalized_key] = normalized_value
    try:
        resolved_port = int(resolved_values["port"])
        if not 1 <= resolved_port <= 65535:
            raise ValueError("invalid SSH port")
        endpoint = SshEndpoint(
            resolved_values["hostname"].lower(),
            resolved_values["user"],
            resolved_port,
        )
    except (KeyError, ValueError):
        raise SwarmPreflightConfigError(
            "ssh returned an incomplete target for the selected checkout's origin.",
        ) from None

    # GitHub documents ssh.github.com:443 as the alternate endpoint for the same public
    # github.com SSH service. No other host/user/port equivalence is assumed.
    if endpoint == SshEndpoint("ssh.github.com", "git", 443):
        return SshEndpoint("github.com", "git", 22)
    return endpoint


def _parse_github_remote(
    remote: str,
    ssh_host_cache: Optional[
        dict[tuple[str, str, Optional[int]], SshEndpoint]
    ] = None,
    repo_root: Path = REPO_ROOT,
    verify_transport: bool = True,
) -> GitHubRepoTarget:
    """Parse one remote as data, resolving SSH aliases without logging the input."""

    host = ""
    path = ""
    uses_ssh = False
    ssh_user: Optional[str] = None
    ssh_port: Optional[int] = None
    http_endpoint: Optional[HttpEndpoint] = None
    try:
        if "://" in remote:
            parsed = urlsplit(remote)
            scheme = parsed.scheme.lower()
            if scheme not in {"http", "https", "ssh"}:
                raise ValueError("unsupported remote scheme")
            if parsed.query or parsed.fragment:
                raise ValueError("remote query and fragment are unsupported")
            host = parsed.hostname or ""
            path = parsed.path
            uses_ssh = scheme == "ssh"
            if uses_ssh:
                if parsed.password is not None:
                    raise ValueError("SSH remote passwords are unsupported")
                ssh_user = parsed.username
                ssh_port = parsed.port
            else:
                effective_port = parsed.port or (443 if scheme == "https" else 80)
                # gh API host binding defaults to HTTPS. A non-default web authority cannot be
                # proven equivalent without additional host configuration, so fail closed.
                if scheme != "https":
                    raise SwarmPreflightConfigError(
                        "Swarm cannot bind gh to an HTTP origin. Use an HTTPS origin on port "
                        "443 or an SSH origin, then retry.",
                    )
                if effective_port != 443:
                    raise SwarmPreflightConfigError(
                        "Swarm cannot prove that a non-default HTTPS origin authority matches "
                        "gh. Use HTTPS on port 443 or an SSH origin, then retry.",
                    )
                http_endpoint = HttpEndpoint("https", host.lower(), 443)
        else:
            match = re.match(
                r"^(?:(?P<user>[^@/:]+)@)?(?P<host>[^:/]+):(?P<path>.+)$",
                remote,
            )
            if match:
                host = match.group("host")
                path = match.group("path")
                uses_ssh = True
                ssh_user = match.group("user")
    except (UnicodeError, ValueError):
        raise SwarmPreflightConfigError(
            "The selected checkout's origin is not a supported GitHub repository URL. "
            "Configure a GitHub origin, then retry.",
        ) from None

    repository_path = path.strip("/").removesuffix(".git")
    parts = repository_path.split("/")
    if (
        not host
        or len(parts) != 2
        or not all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts)
        or (
            uses_ssh
            and ssh_user is not None
            and not re.fullmatch(r"[A-Za-z0-9_.-]+", ssh_user)
        )
    ):
        raise SwarmPreflightConfigError(
            "The selected checkout's origin is not a supported GitHub repository URL. "
            "Configure a GitHub origin, then retry.",
        )
    if uses_ssh:
        cache = ssh_host_cache if ssh_host_cache is not None else {}
        cache_key = (host.lower(), ssh_user or "", ssh_port)
        if cache_key not in cache:
            cache[cache_key] = _resolve_ssh_endpoint(
                host,
                user=ssh_user,
                port=ssh_port,
                repo_root=repo_root,
                verify_transport=verify_transport,
            )
        ssh_endpoint = cache[cache_key]
        resolved_host = ssh_endpoint.host
    else:
        ssh_endpoint = None
        resolved_host = host.lower()
    return GitHubRepoTarget(
        resolved_host,
        parts[0],
        parts[1],
        ssh_endpoint=ssh_endpoint,
        http_endpoint=http_endpoint,
    )


def _resolve_origin_repository(
    repo_root: Path = REPO_ROOT,
    verify_transport: bool = True,
) -> GitHubRepoTarget:
    """Resolve and cross-check every effective origin fetch and push URL."""
    ssh_host_cache: dict[tuple[str, str, Optional[int]], SshEndpoint] = {}
    fetch_targets = [
        _parse_github_remote(
            url,
            ssh_host_cache,
            repo_root,
            verify_transport=verify_transport,
        )
        for url in _read_origin_urls(push=False, repo_root=repo_root)
    ]
    push_targets = [
        _parse_github_remote(
            url,
            ssh_host_cache,
            repo_root,
            verify_transport=verify_transport,
        )
        for url in _read_origin_urls(push=True, repo_root=repo_root)
    ]
    targets = [*fetch_targets, *push_targets]
    target = targets[0]
    identity = (target.host.lower(), target.owner.lower(), target.repo.lower())
    for candidate in targets[1:]:
        candidate_identity = (
            candidate.host.lower(),
            candidate.owner.lower(),
            candidate.repo.lower(),
        )
        if candidate_identity != identity:
            raise SwarmPreflightConfigError(
                "The selected checkout's origin fetch and push URLs do not identify the same "
                "GitHub repository. Align every origin URL, then retry.",
            )
    ssh_endpoints = [
        candidate.ssh_endpoint
        for candidate in targets
        if candidate.ssh_endpoint is not None
    ]
    if ssh_endpoints and any(
        endpoint != ssh_endpoints[0] for endpoint in ssh_endpoints[1:]
    ):
        raise SwarmPreflightConfigError(
            "The selected checkout's origin SSH URLs do not resolve to the same host, user, and "
            "port. Align every origin URL and SSH Host rule, then retry.",
        )
    http_endpoints = [
        candidate.http_endpoint
        for candidate in targets
        if candidate.http_endpoint is not None
    ]
    if http_endpoints and any(
        endpoint != http_endpoints[0] for endpoint in http_endpoints[1:]
    ):
        raise SwarmPreflightConfigError(
            "The selected checkout's origin HTTPS URLs do not use the same authority. Align "
            "every origin URL, then retry.",
        )
    return GitHubRepoTarget(
        target.host,
        target.owner,
        target.repo,
        ssh_endpoint=ssh_endpoints[0] if ssh_endpoints else None,
        http_endpoint=http_endpoints[0] if http_endpoints else None,
    )


def _read_git_config_values(key: str, repo_root: Path) -> tuple[str, ...]:
    """Read the effective repository-owned value for one push selector."""
    try:
        result = subprocess.run(
            ["git", "config", "--show-scope", "--get", key],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        raise SwarmPreflightConfigError(
            "git could not inspect the task worktree's push target configuration.",
        ) from None
    if result.returncode == 1:
        return ()
    if result.returncode != 0:
        raise SwarmPreflightConfigError(
            "git could not inspect the task worktree's push target configuration.",
        )
    lines = result.stdout.splitlines()
    if len(lines) != 1:
        raise SwarmPreflightConfigError(
            "git could not inspect the task worktree's push target configuration.",
        )
    scope, separator, value = lines[0].partition("\t")
    if not separator:
        raise SwarmPreflightConfigError(
            "git could not inspect the task worktree's push target configuration.",
        )
    return (value,) if scope in {"local", "worktree"} else ()


def _assert_worktree_push_target(
    worktree_path: Path,
    branch_name: Optional[str],
) -> None:
    """Revalidate branch-scoped origin and bare-push selectors before agent dispatch."""
    # Deliberately re-resolve instead of caching: includeIf/onbranch and SSH config can change
    # between polling cycles, and stale endpoint data would weaken the dispatch boundary.
    target = _resolve_origin_repository(worktree_path)
    if not _ACTIVE_REPO_TARGET:
        raise SwarmPreflightConfigError(
            "The GitHub repository context is not bound to this checkout's origin.",
        )
    expected = [
        _ACTIVE_REPO_TARGET.host,
        _ACTIVE_REPO_TARGET.owner,
        _ACTIVE_REPO_TARGET.repo,
    ]
    actual = [target.host, target.owner, target.repo]
    if (
        [part.lower() for part in actual] != [part.lower() for part in expected]
        or target.ssh_endpoint != _ACTIVE_REPO_TARGET.ssh_endpoint
        or target.http_endpoint != _ACTIVE_REPO_TARGET.http_endpoint
    ):
        raise SwarmPreflightConfigError(
            "The task worktree's effective origin or transport endpoint differs from the target "
            "bound at startup. Align branch-scoped Git configuration, then retry.",
        )

    selector_keys = ["remote.pushDefault"]
    if branch_name:
        selector_keys.extend(
            [
                f"branch.{branch_name}.pushRemote",
                f"branch.{branch_name}.remote",
            ]
        )
    if any(
        value != "origin"
        for key in selector_keys
        for value in _read_git_config_values(key, worktree_path)
    ):
        raise SwarmPreflightConfigError(
            "The task worktree selects a push remote other than origin. Remove the conflicting "
            "push-remote override or point it to origin, then retry.",
        )


def _assert_checkout_push_target(checkout_path: Path) -> Optional[str]:
    """Apply the dispatch push boundary and return the checked-out branch."""
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
            cwd=checkout_path,
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        raise SwarmPreflightConfigError(
            "git could not inspect the agent checkout before dispatch.",
        ) from None
    branch_name = result.stdout.strip() or None
    if result.returncode == 1 and checkout_path.resolve() == REPO_ROOT.resolve():
        # Reviewer and Maintainer agents run in REPO_ROOT and may legitimately use a
        # detached checkout. They still get origin/transport validation plus a pinned
        # remote.pushDefault; branch-scoped selectors simply do not exist in this state.
        branch_name = None
    elif result.returncode != 0 or branch_name is None:
        raise SwarmPreflightConfigError(
            "The task worktree is detached or has no readable branch; refusing dispatch.",
        )
    _assert_worktree_push_target(checkout_path, branch_name)
    return branch_name


def _bind_origin_repository(verify_transport: bool = True) -> GitHubRepoTarget:
    """Bind local gh context without performing a network permission probe."""
    global _ACTIVE_GH_REPO_CONTEXT, _ACTIVE_REPO_TARGET
    _ACTIVE_GH_REPO_CONTEXT = None
    _ACTIVE_REPO_TARGET = None
    target = _resolve_origin_repository(verify_transport=verify_transport)
    _ACTIVE_GH_REPO_CONTEXT = target.gh_context
    _ACTIVE_REPO_TARGET = target
    return target


def _gh_operation(args: list[str]) -> str:
    """Return a fixed, non-sensitive label instead of logging arbitrary argv."""
    if not args:
        return "gh"
    if args[0] in {"issue", "pr", "repo"} and len(args) > 1:
        return f"gh {args[0]} {args[1]}"
    return f"gh {args[0]}"


_SAFE_CLI_FAILURE_HINTS = (
    (
        ("resource not accessible by integration",),
        "GitHub denied access to this repository resource; verify the active credential's "
        "repository grants",
    ),
    (
        ("bad credentials", "authentication required", "gh auth login"),
        "GitHub authentication failed; refresh the active gh credential",
    ),
    (
        ("rate limit", "secondary rate limit"),
        "GitHub rate limiting blocked the operation; retry later",
    ),
    (
        ("could not resolve host", "network is unreachable", "connection timed out"),
        "the network request failed; verify connectivity and retry",
    ),
    (
        ("repository not found",),
        "the remote repository was not found or is not visible to the active credential",
    ),
)


def _safe_cli_failure_hint(stdout: str, stderr: str) -> Optional[str]:
    """Map known diagnostics to fixed text without returning remote-controlled content."""
    diagnostic = f"{stdout}\n{stderr}".lower()
    for markers, hint in _SAFE_CLI_FAILURE_HINTS:
        if any(marker in diagnostic for marker in markers):
            return hint
    return None


def _run_gh(
    args: list[str],
    repo_context: Optional[str] = None,
) -> subprocess.CompletedProcess:
    """Run gh while keeping raw argv/stdout/stderr out of logs and raised errors."""
    cmd = ["gh"] + args
    operation = _gh_operation(args)
    log.debug("Running %s", operation)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            env=_bound_gh_environment(repo_context),
            check=False,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        log.error("%s timed out after %ds", operation, GH_TIMEOUT_SECONDS)
        raise subprocess.TimeoutExpired([operation], GH_TIMEOUT_SECONDS) from None
    except FileNotFoundError:
        log.error("gh CLI executable was not found")
        raise FileNotFoundError("gh CLI executable was not found") from None
    except OSError as error:
        log.error("%s could not be started", operation)
        raise OSError(error.errno, "gh CLI operation could not be started") from None

    if result.returncode != 0:
        hint = _safe_cli_failure_hint(result.stdout, result.stderr)
        if hint:
            log.error("%s failed with exit %d: %s", operation, result.returncode, hint)
        else:
            log.error("%s failed with exit %d", operation, result.returncode)
    return result


def gh(args: list[str], check: bool = True) -> str:
    """Run a gh CLI command and return stdout without exposing raw failure data."""
    try:
        result = _run_gh(args)
    except (subprocess.TimeoutExpired, OSError, SwarmPreflightError):
        if check:
            raise
        return ""

    if result.returncode != 0:
        if check:
            raise subprocess.CalledProcessError(
                result.returncode,
                [_gh_operation(args)],
                output="",
                stderr="",
            )
        return ""
    return result.stdout.strip()


def _parse_gh_api_response(raw: str) -> tuple[int, dict[str, str], dict]:
    """Parse `gh api --include` output without ever logging its raw headers or body."""
    normalized = raw.replace("\r\n", "\n")
    header_text, separator, body_text = normalized.partition("\n\n")
    status_match = re.match(r"HTTP/\S+\s+(\d{3})\b", header_text)
    if not separator or not status_match:
        raise ValueError("gh API response did not contain an HTTP envelope")

    headers: dict[str, str] = {}
    for line in header_text.splitlines()[1:]:
        name, colon, value = line.partition(":")
        if colon:
            headers[name.strip().lower()] = value.strip()
    body = json.loads(body_text)
    if not isinstance(body, dict):
        raise ValueError("gh API response body was not an object")
    return int(status_match.group(1)), headers, body


def _failure_capability(repository: str, gap: str) -> RepoWorkflowCapability:
    return RepoWorkflowCapability(repository, False, (gap,), ())


def _evaluate_repo_workflow_capability(
    repository: str,
    snapshot: dict,
    oauth_scopes: Optional[str],
) -> RepoWorkflowCapability:
    permissions = snapshot.get("permissions")
    push = permissions.get("push") if isinstance(permissions, dict) else None
    if not isinstance(push, bool):
        push = None

    gaps: list[str] = []
    if snapshot.get("archived") is True:
        gaps.append("archived")
    if snapshot.get("disabled") is True:
        gaps.append("disabled")
    if snapshot.get("has_issues") is False:
        gaps.append("issues-disabled")
    if push is None:
        gaps.append("permissions-unknown")
    elif not push:
        gaps.append("no-push-permission")

    scopes = {
        scope.strip()
        for scope in (oauth_scopes or "").split(",")
        if scope.strip()
    }
    credential_is_classic = bool(scopes)
    if credential_is_classic:
        can_write = "repo" in scopes or (
            snapshot.get("private") is not True and "public_repo" in scopes
        )
        if not can_write:
            gaps.append("oauth-scope-missing")

    unverified = _PIPELINE_GRANTS if not gaps and not credential_is_classic else ()
    return RepoWorkflowCapability(repository, not gaps, tuple(gaps), tuple(unverified))


def _classify_gh_api_failure(
    repository: str,
    result: subprocess.CompletedProcess,
) -> RepoWorkflowCapability:
    raw_diagnostic = f"{result.stdout}\n{result.stderr}"
    status: Optional[int] = None
    headers: dict[str, str] = {}
    try:
        status, headers, _ = _parse_gh_api_response(result.stdout)
    except (ValueError, json.JSONDecodeError):
        matches = re.findall(r"(?:HTTP/\S+\s+|HTTP\s+)(\d{3})\b", raw_diagnostic)
        if matches:
            status = int(matches[-1])

    diagnostic = raw_diagnostic.lower()
    if status == 404:
        return _failure_capability(repository, "repo-not-found")
    if status == 401:
        return _failure_capability(repository, "bad-credentials")
    if status == 451:
        return _failure_capability(repository, "legally-unavailable")
    if status in {403, 429}:
        if headers.get("x-ratelimit-remaining") == "0":
            raise SwarmPreflightTransientError(
                f"{repository}: GitHub rate limit is exhausted; retry after it resets",
            )
        if "retry-after" in headers or "rate limit" in diagnostic:
            raise SwarmPreflightTransientError(
                f"{repository}: GitHub rate-limited the preflight; retry later",
            )
        if "x-github-sso" in headers:
            return _failure_capability(repository, "sso-authorization-required")
        if "installation has been suspended" in diagnostic:
            return _failure_capability(repository, "installation-suspended")
        if "resource not accessible by" in diagnostic:
            return _failure_capability(repository, "resource-not-accessible")
    if status is None and "bad credentials" in diagnostic:
        return _failure_capability(repository, "bad-credentials")
    if status is None and (result.returncode == 4 or re.search(
        r"not logged in|authentication required|gh auth login|no oauth token",
        diagnostic,
    )):
        return _failure_capability(repository, "gh-not-authenticated")
    if status is None and "rate limit" in diagnostic:
        raise SwarmPreflightTransientError(
            f"{repository}: GitHub rate-limited the preflight; retry later",
        )

    raise SwarmPreflightTransientError(
        f"{repository}: GitHub write preflight was inconclusive (gh exit {result.returncode}); "
        "retry later. No permanent authorization verdict was inferred",
    )


def check_repo_workflow_capability() -> RepoWorkflowCapability:
    """Probe the active gh credential with one non-mutating repository GET."""
    global _ACTIVE_GH_REPO_CONTEXT, _ACTIVE_REPO_TARGET
    _ACTIVE_GH_REPO_CONTEXT = None
    _ACTIVE_REPO_TARGET = None
    target = _resolve_origin_repository()
    try:
        result = _run_gh([
            "api",
            "--include",
            "--method", "GET",
            "repos/{owner}/{repo}",
            "--jq", "{full_name,archived,disabled,has_issues,private,permissions}",
        ], repo_context=target.gh_context)
    except FileNotFoundError as error:
        raise SwarmPreflightConfigError(
            "gh CLI is required for mao swarm; install it and run `gh auth login`, then retry",
        ) from error
    except subprocess.TimeoutExpired as error:
        raise SwarmPreflightTransientError(
            f"{target.name}: GitHub write preflight timed out after "
            f"{GH_TIMEOUT_SECONDS}s; retry later",
        ) from error
    except OSError as error:
        raise SwarmPreflightTransientError(
            f"{target.name}: gh CLI could not start the GitHub write preflight; retry later",
        ) from error

    if result.returncode != 0:
        return _classify_gh_api_failure(target.name, result)

    try:
        status, headers, snapshot = _parse_gh_api_response(result.stdout)
    except (ValueError, json.JSONDecodeError) as error:
        raise SwarmPreflightTransientError(
            f"{target.name}: GitHub returned an unreadable preflight response; retry later",
        ) from error
    # `gh api` currently exits non-zero for non-2xx responses, so this is defensive against a
    # future CLI behavior change rather than an expected path today.
    if status < 200 or status >= 300:
        raise SwarmPreflightTransientError(
            f"{target.name}: GitHub returned unexpected HTTP {status}; retry later",
        )

    repository = snapshot.get("full_name")
    if not isinstance(repository, str) or not repository.strip():
        raise SwarmPreflightTransientError(
            f"{target.name}: GitHub omitted the repository name from the preflight response; "
            "retry later",
        )
    repository = repository.strip()
    if repository.lower() != target.name.lower():
        raise SwarmPreflightConfigError(
            f"The selected checkout origin is {target.name}, but gh resolved {repository}. "
            "Clear the conflicting gh repository context, then retry.",
        )
    capability = _evaluate_repo_workflow_capability(
        repository,
        snapshot,
        headers.get("x-oauth-scopes"),
    )
    if capability.ok:
        _ACTIVE_GH_REPO_CONTEXT = target.gh_context
        _ACTIVE_REPO_TARGET = target
    return capability


def describe_repo_workflow_capability(capability: RepoWorkflowCapability) -> str:
    if capability.ok:
        return f"{capability.repository} has no known blocker for mao swarm"

    reasons = "; ".join(_CAPABILITY_GAP_REASONS[gap] for gap in capability.gaps)
    remedy_kind = min(
        (_CAPABILITY_GAP_REMEDIES[gap] for gap in capability.gaps),
        key=lambda kind: _CAPABILITY_REMEDY_RANK[kind],
    )
    remedy = _CAPABILITY_REMEDY_TEXT[remedy_kind]
    return (
        f"{capability.repository} cannot run mao swarm with the active gh CLI credential: "
        f"{reasons}. {remedy}"
    )


def describe_unverified_grants(capability: RepoWorkflowCapability) -> Optional[str]:
    if not capability.unverified:
        return None
    grants = ", ".join(_UNVERIFIED_GRANT_LABELS[grant] for grant in capability.unverified)
    return (
        f"{capability.repository}: repository push permission is necessary but not sufficient, and "
        "GitHub exposes no non-mutating way to confirm this gh credential's individual "
        f"{grants} grants. They remain unverified, so a write can still fail."
    )


def assert_repo_workflow_writable() -> RepoWorkflowCapability:
    capability = check_repo_workflow_capability()
    if not capability.ok:
        raise SwarmCapabilityError(capability)

    log.info(
        "Swarm write preflight passed for %s using the active gh CLI credential.",
        capability.repository,
    )
    caveat = describe_unverified_grants(capability)
    if caveat:
        grants_key = ",".join(capability.unverified)
        log_blocker(
            f"preflight-unverified:{capability.repository.lower()}:{grants_key}",
            "%s",
            caveat,
            level=logging.WARNING,
        )
    return capability


def _log_preflight_failure(error: SwarmPreflightError):
    """Log typed preflight failures without exposing raw remote or CLI diagnostics."""
    if isinstance(error, SwarmCapabilityError):
        log.error("Swarm write preflight failed: %s", error)
    elif isinstance(error, SwarmPreflightConfigError):
        log.error("Swarm write preflight configuration error: %s", error)
    else:
        log.error("Swarm write preflight unavailable (transient): %s", error)


_CURRENT_GH_USER: Optional[str] = None


def get_gh_user() -> str:
    """Fetch and cache a successful authenticated GitHub user lookup."""
    global _CURRENT_GH_USER
    if not _CURRENT_GH_USER:
        try:
            login = gh(["api", "user", "-q", ".login"]).strip()
            if not login:
                log.error("GitHub returned no authenticated user login.")
                return ""
            _CURRENT_GH_USER = login
        except Exception as e:
            log.error("Failed to get current GitHub user login: %s", e)
            return ""
    return _CURRENT_GH_USER


def fetch_open_issues() -> list[dict]:
    """Fetch every open Issue so the startup scan cannot hide malformed tasks."""
    raw = gh([
        "issue", "list",
        "--state", "open",
        "--json", "number,title,body",
        "--limit", str(OPEN_ITEMS_LIMIT),
    ])
    if not raw:
        return []
    return json.loads(raw)


def fetch_open_prs() -> list[dict]:
    """Fetch every open PR so the startup scan cannot hide malformed work."""
    raw = gh([
        "pr", "list",
        "--state", "open",
        "--json", "number,title,body,headRefName,headRefOid,isCrossRepository",
        "--limit", str(OPEN_ITEMS_LIMIT),
    ])
    if not raw:
        return []
    return json.loads(raw)


def fetch_pr_comments(pr_number: int) -> list[dict]:
    """Fetch comments on a PR."""
    raw = gh([
        "pr", "view", str(pr_number),
        "--json", "comments",
    ], check=False)
    if not raw:
        return []
    data = json.loads(raw)
    return data.get("comments", [])


def fetch_issue(issue_number: int) -> Optional[dict]:
    """Fetch a specific issue by number."""
    raw = gh([
        "issue", "view", str(issue_number),
        "--json", "number,title,body"
    ], check=False)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def parse_role(pattern: re.Pattern, text: str) -> Optional[RoleAssignment]:
    """Parse a role metadata tag from text."""
    match = pattern.search(text or "")
    if match:
        return RoleAssignment(
            ai=match.group("ai").strip().lower(),
            model=match.group("model").strip(),
            reasoning=match.group("reasoning").strip(),
        )
    return None


def extract_issue_number_from_pr_title(title: str) -> Optional[int]:
    """Extract issue number from PR title like '[PR] 12 - ...'"""
    m = re.match(r"^\s*\[PR\]\s*(\d+)", title)
    return int(m.group(1)) if m else None


def comment_signal_id(comment: dict, index: int) -> str:
    """Build a stable identifier for a GitHub comment signal."""
    raw_id = str(comment.get("id") or comment.get("url") or f"index-{index}")
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", raw_id).strip("-")


def validate_distinct_roles(
    worker: Optional[RoleAssignment],
    reviewer: Optional[RoleAssignment],
    maintainer: Optional[RoleAssignment] = None,
) -> tuple[bool, str]:
    """Validate that every assigned lifecycle role uses a different AI."""
    assignments = {
        "Worker": worker,
        "Reviewer": reviewer,
        "Maintainer": maintainer,
    }
    seen: dict[str, str] = {}
    for role, assignment in assignments.items():
        if assignment is None:
            continue
        previous_role = seen.get(assignment.ai)
        if previous_role:
            return (
                False,
                f"{previous_role} and {role} both use AI '{assignment.ai}'",
            )
        seen[assignment.ai] = role
    return True, ""


def determine_pr_action(comments: list[dict]) -> tuple[str, Optional[dict], int]:
    """Return the next action from the newest recognized lifecycle signal.

    Recognized signals are Reviewer feedback, Worker revision completion,
    Reviewer approval containing a Maintainer assignment, and a Maintainer
    block. Informational comments do not change state.

    An approval must carry BOTH a Reviewer and a Maintainer tag. A lone
    Maintainer tag — a human quoting the rules, or another agent naming a
    candidate — is informational, because treating it as approval would freeze
    the PR on a "maintain" action that later validation always rejects.
    """
    latest_action = "review"
    latest_comment: Optional[dict] = None
    latest_index = -1

    for index, comment in enumerate(comments):
        body = comment.get("body", "")
        maintainer = parse_role(MAINTAINER_PATTERN, body)
        reviewer = parse_role(REVIEWER_PATTERN, body)

        if maintainer and MAINTAINER_BLOCKED_PATTERN.search(body):
            latest_action = "review_after_maintainer_block"
            latest_comment = comment
            latest_index = index
        elif maintainer and reviewer:
            latest_action = "maintain"
            latest_comment = comment
            latest_index = index
        elif reviewer:
            latest_action = "revise"
            latest_comment = comment
            latest_index = index
        elif "[Worker] Revision complete." in body:
            latest_action = "review"
            latest_comment = comment
            latest_index = index

    return latest_action, latest_comment, latest_index


# ---------------------------------------------------------------------------
# Git Worktree Management
# ---------------------------------------------------------------------------

def local_branch_exists(branch_name: str) -> bool:
    """Return whether a local branch of this name exists."""
    result = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}"],
        capture_output=True, text=True, cwd=REPO_ROOT, check=False,
    )
    return result.returncode == 0


def local_branch_sha(branch_name: str) -> Optional[str]:
    """Return the exact commit of one local branch, or None when it is absent."""
    result = subprocess.run(
        ["git", "rev-parse", "--verify", f"refs/heads/{branch_name}^{{commit}}"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )
    sha = result.stdout.strip().lower()
    if result.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40,64}", sha):
        return None
    return sha


def _fast_forward_local_branch(
    branch_name: str,
    expected_sha: str,
    checkout_path: Optional[Path] = None,
) -> None:
    """Advance a tracked-clean local PR branch when the verified head descends from it."""
    current_sha = local_branch_sha(branch_name)
    normalized_expected = expected_sha.lower()
    if current_sha == normalized_expected:
        return
    if current_sha is None:
        raise SwarmPreflightConfigError(
            f"Local branch '{branch_name}' could not be inspected; preserving it for inspection."
        )

    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", current_sha, normalized_expected],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if ancestor.returncode != 0:
        raise SwarmPreflightConfigError(
            f"Local branch '{branch_name}' diverges from the fetched PR head; preserving it "
            "for inspection. Reconcile or move the local branch manually, then retry."
        )

    if checkout_path is not None:
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            cwd=checkout_path,
            capture_output=True,
            text=True,
            check=False,
        )
        if status.returncode != 0:
            raise SwarmPreflightConfigError(
                f"Local branch '{branch_name}' could not be inspected; preserving it for inspection."
            )
        if status.stdout:
            raise SwarmPreflightConfigError(
                f"Local branch '{branch_name}' trails the fetched PR head but its worktree has "
                "tracked changes; preserving it for inspection. Commit, move, or otherwise "
                "reconcile those changes, then retry."
            )
        advanced = subprocess.run(
            ["git", "merge", "--no-overwrite-ignore", "--ff-only", normalized_expected],
            cwd=checkout_path,
            capture_output=True,
            text=True,
            check=False,
        )
    else:
        advanced = subprocess.run(
            [
                "git",
                "update-ref",
                f"refs/heads/{branch_name}",
                normalized_expected,
                current_sha,
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
    if advanced.returncode != 0 or local_branch_sha(branch_name) != normalized_expected:
        raise SwarmPreflightConfigError(
            f"Local branch '{branch_name}' could not be fast-forwarded to the fetched PR head "
            "without overwriting local state, or changed concurrently; preserving its current "
            "state for inspection."
        )
    log.info("Fast-forwarded local branch %s to the verified PR head.", branch_name)


def fetch_pr_head(pr_number: int, expected_sha: str) -> str:
    """Fetch and verify the immutable PR-head snapshot used for a revision."""
    normalized_expected = (expected_sha or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40,64}", normalized_expected):
        raise SwarmPreflightTransientError(
            f"PR #{pr_number} has no valid head commit; refusing revision dispatch."
        )
    try:
        fetched = subprocess.run(
            [
                "git",
                "fetch",
                "--no-tags",
                "origin",
                f"refs/pull/{pr_number}/head",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        raise SwarmPreflightTransientError(
            f"Could not fetch PR #{pr_number}'s head from origin; refusing revision dispatch."
        ) from None
    if fetched.returncode != 0:
        raise SwarmPreflightTransientError(
            f"Could not fetch PR #{pr_number}'s head from origin; refusing revision dispatch."
        )
    resolved = subprocess.run(
        ["git", "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    actual_sha = resolved.stdout.strip().lower()
    if (
        resolved.returncode != 0
        or not re.fullmatch(r"[0-9a-f]{40,64}", actual_sha)
        or actual_sha != normalized_expected
    ):
        raise SwarmPreflightTransientError(
            f"PR #{pr_number}'s head changed while preparing the revision; retry the next cycle."
        )
    return actual_sha


def list_git_worktrees() -> list[dict[str, str]]:
    """Return Git's authoritative worktree registry in porcelain form."""
    try:
        result = subprocess.run(
            ["git", "worktree", "list", "--porcelain"],
            capture_output=True, text=True, cwd=REPO_ROOT, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        raise SwarmPreflightConfigError(
            "Could not inspect Git worktrees; preserving local checkout state for inspection."
        ) from None
    entries: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if not line:
            if current:
                entries.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value
    if current:
        entries.append(current)
    return entries


def worktree_entry_for_path(
    entries: list[dict[str, str]],
    worktree_path: Path,
) -> Optional[dict[str, str]]:
    """Find the registry entry for an exact filesystem path."""
    expected = worktree_path.resolve()
    return next(
        (
            entry for entry in entries
            if entry.get("worktree")
            and Path(entry["worktree"]).resolve() == expected
        ),
        None,
    )


def worktree_entry_for_branch(
    entries: list[dict[str, str]],
    branch_name: str,
) -> Optional[dict[str, str]]:
    """Find the checkout that already owns a local branch, if any."""
    branch_ref = f"refs/heads/{branch_name}"
    return next((entry for entry in entries if entry.get("branch") == branch_ref), None)


def repair_worktree(worktree_path: Path):
    """Ask Git to repair administrative links without deleting user files."""
    result = subprocess.run(
        ["git", "worktree", "repair", str(worktree_path)],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        log.warning("Failed to repair worktree %s; preserving it.", worktree_path)


def directory_is_empty(directory: Path) -> bool:
    """Return true only for an existing directory with no entries."""
    try:
        next(directory.iterdir())
    except StopIteration:
        return True
    except OSError:
        return False
    return False


def create_worktree(
    issue_number: int,
    branch_name: str,
    start_ref: str = "origin/main",
    expected_sha: Optional[str] = None,
) -> Path:
    """Create or safely reuse the one isolated worktree owned by a task."""
    worktree_path = WORKTREE_DIR / str(issue_number)

    if worktree_path.is_symlink():
        raise SwarmPreflightConfigError(f"Refusing symlinked worktree path: {worktree_path}")

    entries = list_git_worktrees()
    path_entry = worktree_entry_for_path(entries, worktree_path)
    if not worktree_path.exists() and path_entry:
        # The directory is already gone, so only prunable administrative
        # metadata remains. Pruning it cannot remove user files.
        subprocess.run(
            ["git", "worktree", "prune"], cwd=REPO_ROOT, check=False,
        )
        entries = list_git_worktrees()
        path_entry = worktree_entry_for_path(entries, worktree_path)
    if worktree_path.exists() or path_entry:
        if not worktree_path.exists():
            # Git retains prunable metadata after a directory is removed. Prune
            # only that metadata; there are no files at the path to preserve.
            subprocess.run(
                ["git", "worktree", "prune"], cwd=REPO_ROOT, check=False,
            )
        elif not (worktree_path / ".git").exists() or not path_entry:
            repair_worktree(worktree_path)

        entries = list_git_worktrees()
        path_entry = worktree_entry_for_path(entries, worktree_path)
        expected_branch = f"refs/heads/{branch_name}"
        if (
            worktree_path.exists()
            and (worktree_path / ".git").exists()
            and path_entry
            and path_entry.get("branch") == expected_branch
        ):
            if expected_sha:
                _fast_forward_local_branch(
                    branch_name,
                    expected_sha,
                    checkout_path=worktree_path,
                )
            log.info("Reusing worktree: %s", worktree_path)
            return worktree_path

        if worktree_path.exists() and directory_is_empty(worktree_path):
            worktree_path.rmdir()
        elif worktree_path.exists():
            raise SwarmPreflightConfigError(
                f"Worktree path is not a valid checkout for '{branch_name}'; "
                f"preserving non-empty directory: {worktree_path}"
            )

    entries = list_git_worktrees()
    branch_entry = worktree_entry_for_branch(entries, branch_name)
    if branch_entry:
        raise SwarmPreflightConfigError(
            f"Branch '{branch_name}' is already checked out at "
            f"{branch_entry.get('worktree', '(unknown path)')}"
        )

    WORKTREE_DIR.mkdir(parents=True, exist_ok=True)

    branch_sha = local_branch_sha(branch_name)
    if expected_sha and branch_sha and branch_sha != expected_sha.lower():
        _fast_forward_local_branch(branch_name, expected_sha)
        branch_sha = local_branch_sha(branch_name)

    # Initial Workers branch from origin/main. Revision callers provide a
    # separately fetched and verified PR-head commit instead.
    if branch_sha is None:
        try:
            subprocess.run(
                ["git", "branch", "--", branch_name, start_ref],
                cwd=REPO_ROOT, check=True,
            )
        except (OSError, subprocess.SubprocessError):
            raise SwarmPreflightConfigError(
                f"Could not create local branch '{branch_name}'; preserving Git state."
            ) from None

    try:
        subprocess.run(
            ["git", "worktree", "add", str(worktree_path), branch_name],
            cwd=REPO_ROOT, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        raise SwarmPreflightConfigError(
            f"Could not create the worktree for '{branch_name}'; preserving Git state."
        ) from None
    log.info("Created worktree: %s on branch %s", worktree_path, branch_name)
    return worktree_path


def cleanup_worktree(issue_number: int, branch_name: str):
    """Safely remove a clean, merged task worktree and its local branch."""
    worktree_path = WORKTREE_DIR / str(issue_number)

    # Merged PRs are re-listed every polling cycle, so exit before spending any
    # subprocess or log output on work that is already done.
    if not worktree_path.exists() and not local_branch_exists(branch_name):
        return

    expected_prefix = f"worker/{issue_number}-"
    if not branch_name.startswith(expected_prefix):
        log_blocker(
            f"cleanup:{issue_number}:{branch_name}",
            "Refusing cleanup for unexpected branch '%s' (expected prefix '%s').",
            branch_name,
            expected_prefix,
        )
        return

    if worktree_path.is_symlink():
        log_blocker(
            f"symlink-worktree:{issue_number}",
            "Refusing to inspect or remove symlinked worktree path: %s",
            worktree_path,
        )
        return

    entries = list_git_worktrees()
    path_entry = worktree_entry_for_path(entries, worktree_path)
    if not worktree_path.exists() and path_entry:
        # The directory is already gone, so only prunable administrative
        # metadata remains. Pruning it cannot remove user files.
        subprocess.run(
            ["git", "worktree", "prune"], cwd=REPO_ROOT, check=False,
        )
        entries = list_git_worktrees()
        path_entry = worktree_entry_for_path(entries, worktree_path)
    if worktree_path.exists() or path_entry:
        if worktree_path.exists() and (
            not (worktree_path / ".git").exists() or not path_entry
        ):
            repair_worktree(worktree_path)
            entries = list_git_worktrees()
            path_entry = worktree_entry_for_path(entries, worktree_path)

        if worktree_path.exists() and path_entry and (worktree_path / ".git").exists():
            expected_branch = f"refs/heads/{branch_name}"
            if path_entry.get("branch") != expected_branch:
                log_blocker(
                    f"mismatched-worktree:{issue_number}",
                    "Refusing cleanup: %s is registered for a different branch.",
                    worktree_path,
                )
                return
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=worktree_path,
                capture_output=True,
                text=True,
                check=False,
            )
            if status.returncode != 0 or status.stdout.strip():
                log_blocker(
                    f"dirty-worktree:{issue_number}",
                    "Refusing to remove non-clean worktree for Issue #%d: %s",
                    issue_number,
                    worktree_path,
                    level=logging.WARNING,
                )
                return

            removed = subprocess.run(
                ["git", "worktree", "remove", str(worktree_path)],
                cwd=REPO_ROOT,
                check=False,
            )
            if removed.returncode != 0:
                log.warning("Failed to remove worktree: %s", worktree_path)
                return
            log.info("Removed worktree: %s", worktree_path)
        elif worktree_path.exists():
            if not directory_is_empty(worktree_path):
                log_blocker(
                    f"damaged-worktree:{issue_number}",
                    "Refusing to remove damaged non-empty worktree for Issue #%d: %s",
                    issue_number,
                    worktree_path,
                    level=logging.WARNING,
                )
                return
            worktree_path.rmdir()
            subprocess.run(
                ["git", "worktree", "prune"], cwd=REPO_ROOT, check=False,
            )
            log.info("Removed empty damaged worktree directory: %s", worktree_path)

    # Never delete a branch that another registered worktree still owns.
    branch_entry = worktree_entry_for_branch(list_git_worktrees(), branch_name)
    if branch_entry:
        log_blocker(
            f"checked-out-branch:{issue_number}:{branch_name}",
            "Refusing to delete branch '%s'; it is checked out at %s.",
            branch_name,
            branch_entry.get("worktree", "(unknown path)"),
        )
        return

    # Force-delete the local branch. We already confirmed the PR is merged on
    # GitHub, so the local merge check (`-d`) is unreliable when the PR was
    # squash- or rebase-merged (the original commits never appear on HEAD).
    result = subprocess.run(
        ["git", "branch", "-D", branch_name],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        log.warning(
            "Failed to delete branch '%s' (git branch exited %d).",
            branch_name,
            result.returncode,
        )


def sync_main_branch(dry_run: bool = False):
    """Fast-forward a clean local main without ever publishing local commits.

    Runs periodically so the shared checkout that worktrees branch off of
    never drifts far from origin/main after Maintainers merge PRs on GitHub.
    It never pushes or rewrites history, so an ahead or diverged local main is
    reported and left for a human instead of being published or clobbered.
    """
    if dry_run:
        log.info("[DRY RUN] Would fetch and reconcile local main with origin/main")
        return

    fetch = subprocess.run(
        ["git", "fetch", "origin", "main"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
        timeout=GH_TIMEOUT_SECONDS,
    )
    if fetch.returncode != 0:
        hint = _safe_cli_failure_hint(fetch.stdout, fetch.stderr)
        if hint:
            log_blocker(
                "main-sync:fetch",
                "Failed to fetch origin/main: %s.",
                hint,
                level=logging.WARNING,
            )
        else:
            log_blocker(
                "main-sync:fetch",
                "Failed to fetch origin/main (git fetch exited %d).",
                fetch.returncode,
                level=logging.WARNING,
            )
        return

    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    ).stdout.strip()
    if branch != "main":
        log.debug("Skipping main sync: repo root is on '%s', not 'main'.", branch)
        return

    status = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    if status.stdout.strip():
        log_blocker(
            "main-sync:dirty",
            "Skipping main sync: repo root working tree is dirty.",
            level=logging.WARNING,
        )
        return

    local_sha = subprocess.run(
        ["git", "rev-parse", "main"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    ).stdout.strip()
    remote_sha = subprocess.run(
        ["git", "rev-parse", "origin/main"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    ).stdout.strip()
    if not local_sha or not remote_sha or local_sha == remote_sha:
        return

    behind = subprocess.run(
        ["git", "merge-base", "--is-ancestor", "main", "origin/main"],
        cwd=REPO_ROOT, check=False,
    ).returncode == 0
    ahead = subprocess.run(
        ["git", "merge-base", "--is-ancestor", "origin/main", "main"],
        cwd=REPO_ROOT, check=False,
    ).returncode == 0

    if behind and not ahead:
        merge = subprocess.run(
            ["git", "merge", "--ff-only", "origin/main"],
            cwd=REPO_ROOT, capture_output=True, text=True, check=False,
        )
        if merge.returncode == 0:
            log.info("🔄 Fast-forwarded local main %s -> %s", local_sha[:8], remote_sha[:8])
        else:
            log_blocker(
                "main-sync:ff",
                "Failed to fast-forward main (git merge exited %d).",
                merge.returncode,
                level=logging.WARNING,
            )
    elif ahead and not behind:
        log_blocker(
            "main-sync:ahead",
            "Local main is ahead of origin/main; refusing to push directly "
            "(manual review required).",
            level=logging.WARNING,
        )
    else:
        log_blocker(
            "main-sync:diverged",
            "Local main and origin/main have diverged; leaving as-is "
            "(manual resolution required).",
            level=logging.WARNING,
        )


# ---------------------------------------------------------------------------
# Log File Management
# ---------------------------------------------------------------------------

def create_log_files(role: str, task_ref: str, ai_name: str) -> tuple[Path, "IO", "IO"]:
    """Create log files and return (log_path, stdout_file, stderr_file).

    The caller closes its file objects after spawning; the child retains its
    duplicated descriptors for the lifetime of the process.
    """
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_ref = re.sub(r"[^a-z0-9]+", "-", task_ref.lower())
    log_path = LOG_DIR / f"{timestamp}_{role}_{ai_name}_{safe_ref}.log"

    log_file = open(log_path, "w", encoding="utf-8")
    try:
        log_file.write(
            f"--- Swarm AI Process Log ---\n"
            f"Role:      {role}\n"
            f"AI:        {ai_name}\n"
            f"Task:      {task_ref}\n"
            f"Started:   {datetime.now(timezone.utc).isoformat()}\n"
            f"---\n\n"
        )
        log_file.flush()
    except Exception:
        log_file.close()
        raise
    return log_path, log_file, log_file


def cleanup_old_prompts(retention_days: int = TASK_LOG_RETENTION_DAYS):
    """Delete prompt temp files older than retention_days.

    Since prompts can contain full issue/PR bodies, we should delete them
    after a retention period so they don't accumulate indefinitely.
    """
    if not PROMPT_DIR.exists():
        return
    cutoff = time.time() - retention_days * 86400
    removed = 0
    for path in PROMPT_DIR.glob("*"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    if removed:
        log.info(
            "🧹 Removed %d prompt file(s) older than %d day(s).",
            removed, retention_days,
        )


def cleanup_old_task_logs(retention_days: int = TASK_LOG_RETENTION_DAYS):
    """Delete per-task AI process log files older than retention_days.

    Each dispatched Worker/Reviewer/Maintainer gets its own timestamped log
    file that is never reused or truncated, so a long-lived swarm accumulates
    them without bound. The orchestrator's own rotating log is size-capped
    separately and is skipped here.
    """
    cleanup_old_prompts(retention_days)
    if not LOG_DIR.exists():
        return
    cutoff = time.time() - retention_days * 86400
    removed = 0
    for path in LOG_DIR.glob("*.log"):
        if path.name == ORCHESTRATOR_LOG_FILE.name or path.name.startswith(
            ORCHESTRATOR_LOG_FILE.name + "."
        ):
            continue
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    if removed:
        log.info(
            "🧹 Removed %d task log file(s) older than %d day(s).",
            removed, retention_days,
        )


def write_prompt_file(prompt: str, role: str, task_ref: str) -> Path:
    """Write prompt to a temp file and return its path.

    Using a file avoids shell escaping issues and OS ARG_MAX limits
    that break when long multi-line Korean/Unicode prompts are passed
    as command-line arguments.
    """
    PROMPT_DIR.mkdir(parents=True, exist_ok=True)
    safe_ref = re.sub(r"[^a-z0-9]+", "-", task_ref.lower())
    prompt_path = PROMPT_DIR / f"{role}_{safe_ref}.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    return prompt_path


# ---------------------------------------------------------------------------
# AI Agent Dispatch — builds argv lists (NOT shell strings)
# ---------------------------------------------------------------------------

# Appended to every dispatched prompt. Observed failure modes this guards
# against: (1) a `claude -p` process ending its turn on "I'll wait for the
# test/notification and continue" — there IS no later turn in a single-shot
# batch invocation, so the process just exits with the task undone; (2) an
# agent reporting `git push` / `gh pr comment` as done from what it intended
# rather than a checked exit code or a re-fetched, confirmed GitHub state
# (e.g. a stale worktree producing a non-fast-forward push that was never
# actually accepted by origin).
EXECUTION_INTEGRITY_NOTICE = (
    "CRITICAL: You are a single, non-interactive batch process in a fully "
    "autonomous swarm. This invocation has no follow-up turn — nothing will "
    "resume you later. Do NOT defer any part of your task to a background "
    "job, a monitor, or a future notification; complete every step yourself, "
    "synchronously, before you finish responding. Do NOT use planning mode. "
    "Do NOT request human feedback, approval, or ask questions.\n\n"
    "Before reporting any step as done, verify it actually happened: after "
    "`git push`, confirm the command exited 0 — a rejected or non-fast-forward "
    "push is a push that did NOT happen, and requires a rebase/merge and a "
    "retry, not a report of success. After posting a PR/Issue comment, "
    "re-fetch it from GitHub (e.g. `gh pr view <n> --json comments`) and "
    "confirm your comment is actually present before you finish. Only report "
    "a step as complete when you have independently confirmed it on GitHub — "
    "if a step failed or you're unsure, say so explicitly instead of "
    "describing what you intended to do.\n\n"
    "Execute your task completely and exit."
)

# Maps AGENTS.md model names + reasoning level to actual agy CLI model IDs.
# agy embeds the effort level in the model name itself, e.g.:
#   "Gemini 3.6 Flash (High)", "Gemini 3.6 Flash (Medium)", "Gemini 3.6 Flash (Low)"
# There is NO separate --effort flag for agy.

_AGY_EFFORT_LABEL: dict[str, str] = {
    "high": "High", "높음": "High", "울트라": "High",
    "매우 높음": "High",
    "medium": "Medium", "중간": "Medium",
    "low": "Low", "낮음": "Low", "light": "Low",
    "thinking": "High",
    "엑스트라": "High", "최대": "High", "ultracode": "High",
}

def _resolve_agy_model(model: str, reasoning: str) -> str:
    """Build the full agy model string like 'Gemini 3.6 Flash (High)'."""
    effort = _AGY_EFFORT_LABEL.get(reasoning.lower().strip(), "High")
    # All AGENTS.md antigravity models map to Gemini 3.6 Flash
    return f"Gemini 3.6 Flash ({effort})"

_CLAUDE_MODEL_MAP: dict[str, str] = {
    "sonnet 5":     "claude-sonnet-5",
    "opus 5":       "claude-opus-5",
    "fable 5":      "claude-fable-5",
    "haiku 4.5":    "claude-haiku-4-5-20251001",
    # Already fully-qualified names pass through.
    "claude-sonnet-5":             "claude-sonnet-5",
    "claude-opus-5":               "claude-opus-5",
    "claude-fable-5":              "claude-fable-5",
    "claude-haiku-4-5-20251001":   "claude-haiku-4-5-20251001",
}

# Claude CLI effort levels: low, medium, high, xhigh, max.
_CLAUDE_EFFORT_MAP: dict[str, str] = {
    "high": "high", "높음": "high", "울트라": "high",
    "매우 높음": "high",
    "medium": "medium", "중간": "medium",
    "low": "low", "낮음": "low", "light": "low",
    "thinking": "high",
    "엑스트라": "xhigh", "최대": "max", "ultracode": "max",
}

# Map the human-friendly model names used in AGENTS.md to Codex CLI model IDs.
# The ChatGPT-authenticated Codex CLI exposes the reasoning variants, but not
# the bare `gpt-5.6` ID.  Keep the generic aliases on the configured default
# variant so a valid Issue/PR tag cannot be turned into a deterministic 400.
_CODEX_MODEL_MAP: dict[str, str] = {
    "5.6 (sol, terra, luna)": "gpt-5.6-terra",
    "5.6":                    "gpt-5.6-terra",
    "5.6 (sol)":              "gpt-5.6-sol",
    "5.6 (terra)":            "gpt-5.6-terra",
    "5.6 (luna)":             "gpt-5.6-luna",
    "5.6 sol":                "gpt-5.6-sol",
    "5.6 terra":              "gpt-5.6-terra",
    "5.6 luna":               "gpt-5.6-luna",
    "5.5":                    "gpt-5.6-terra",
    "5.4":                    "gpt-5.6-terra",
    "5.4 mini":               "gpt-5.6-terra",
}


def build_ai_argv(
    ai_name: str,
    model: str,
    reasoning: str,
    prompt_file: Path,
    cwd: str,
    allow_tool_use: bool,
    prompt_text: Optional[str] = None,
) -> tuple[list[str], bool]:
    """Build an argv list for a specific AI CLI tool.

    Returns a tuple (argv, use_stdin) indicating the command line arguments
    and whether the prompt should be fed via stdin instead of argv.
    """
    if ai_name == "codex":
        model_key = model.lower().strip()
        resolved_model = _CODEX_MODEL_MAP.get(model_key, model)
        if resolved_model != model:
            log.info(
                "Model alias: '%s' → '%s' (codex)",
                model, resolved_model,
            )
        # codex exec: -C workdir, prompt is positional or read from stdin if not provided
        argv = [
            "codex", "exec",
            "-m", resolved_model,
            "-C", cwd,
        ]
        if allow_tool_use:
            argv += [
                "-s", "workspace-write",
                "--dangerously-bypass-approvals-and-sandbox",
            ]
        else:
            argv += [
                "-s", "read-only",
                "--approve-for-me",
            ]
        return argv, True

    elif ai_name == "antigravity":
        resolved_model = _resolve_agy_model(model, reasoning)
        log.info(
            "Model alias: '%s' (reasoning=%s) → '%s' (antigravity)",
            model, reasoning, resolved_model,
        )
        # agy does NOT use a separate --effort flag; effort is part of model name.
        # agy does not support stdin prompt (demands value for -p/--print), so we pass it in argv.
        effective_prompt = (
            prompt_text
            if prompt_text is not None
            else prompt_file.read_text(encoding="utf-8")
        )
        argv = [
            "agy",
            "--model", resolved_model,
            "--print-timeout", ANTIGRAVITY_PRINT_TIMEOUT,
            "-p", effective_prompt,
        ]
        if allow_tool_use:
            argv.insert(1, "--dangerously-skip-permissions")
        else:
            argv.insert(1, "--sandbox")
            argv.insert(2, "--dangerously-skip-permissions")
        return argv, False

    elif ai_name == "claude":
        resolved_model = _CLAUDE_MODEL_MAP.get(model.lower().strip(), model)
        if resolved_model != model:
            log.info(
                "Model alias: '%s' → '%s' (claude)",
                model, resolved_model,
            )
        effort = _CLAUDE_EFFORT_MAP.get(
            reasoning.lower().strip(), "medium",
        )
        argv = [
            "claude",
            "-p",
            "--model", resolved_model,
            "--effort", effort,
        ]
        if allow_tool_use:
            argv.append("--dangerously-skip-permissions")
        else:
            argv.extend(["--allowed-tools", "Bash(gh *),Bash(git *),Read"])
        return argv, True

    else:
        log.error("Unknown AI agent: %s", ai_name)
        return [], False


def _map_reasoning_to_effort(reasoning: str) -> str:
    """Map AGENTS.md reasoning levels to agy --effort values (low/medium/high)."""
    mapping = {
        "high": "high", "높음": "high", "울트라": "high",
        "매우 높음": "high",
        "medium": "medium", "중간": "medium",
        "low": "low", "낮음": "low", "light": "low",
        "thinking": "high",
        "엑스트라": "high", "최대": "high", "ultracode": "high",
    }
    return mapping.get(reasoning.lower().strip(), "medium")


def _format_argv_for_log(argv: list[str]) -> str:
    """Format argv for human-readable logging (truncate long prompts)."""
    parts = []
    for arg in argv:
        if len(arg) > 200:
            parts.append(arg[:100] + "...[truncated]")
        else:
            parts.append(arg)
    return " ".join(parts)


def _assert_dispatch_environment() -> None:
    """Reject inherited Git command parameters before any real-run network or writes."""
    if os.environ.get("GIT_CONFIG_PARAMETERS", "").strip():
        raise SwarmPreflightConfigError(
            "Swarm cannot safely compose inherited GIT_CONFIG_PARAMETERS with its push target "
            "boundary. This commonly comes from launching through `git -c` or a Git hook; "
            "start Swarm outside that wrapper or unset the variable, then retry.",
        )


def _bound_dispatch_environment(branch_name: Optional[str]) -> dict[str, str]:
    """Bind GitHub context and pin every implicit Git push selector to origin."""
    environment = _bound_gh_environment()
    raw_count = environment.get("GIT_CONFIG_COUNT", "0")
    try:
        config_count = int(raw_count)
    except ValueError:
        raise SwarmPreflightConfigError(
            "The inherited Git command configuration is invalid; refusing agent dispatch.",
        ) from None
    if config_count < 0 or config_count > 1024:
        raise SwarmPreflightConfigError(
            "The inherited Git command configuration is invalid; refusing agent dispatch.",
        )
    overrides = [("remote.pushDefault", "origin")]
    if branch_name:
        overrides.extend(
            [
                (f"branch.{branch_name}.pushRemote", "origin"),
                (f"branch.{branch_name}.remote", "origin"),
            ]
        )
    for key, value in overrides:
        environment[f"GIT_CONFIG_KEY_{config_count}"] = key
        environment[f"GIT_CONFIG_VALUE_{config_count}"] = value
        config_count += 1
    environment["GIT_CONFIG_COUNT"] = str(config_count)
    return environment


def _spawn_ai_process(argv, cwd, stdout_file, stderr_file, stdin_source):
    """Launch every agent with the repository and host established by preflight."""
    _assert_dispatch_environment()
    branch_name = _assert_checkout_push_target(Path(cwd))
    _assert_dispatch_platform()
    return subprocess.Popen(
        argv,
        cwd=cwd,
        env=_bound_dispatch_environment(branch_name),
        stdout=stdout_file,
        stderr=stderr_file,
        stdin=stdin_source,
        start_new_session=True,
    )


def _record_failed_dispatch(
    role: str,
    assignment: RoleAssignment,
    task_ref: str,
    branch: str,
    argv: list[str],
    cwd: Path,
    log_path: Optional[Path],
) -> None:
    """Consume retry budget for a non-preflight dispatch failure before registration."""
    try:
        tracker.record_failed_attempt(
            role=role,
            ai_name=assignment.ai,
            model=assignment.model,
            reasoning=assignment.reasoning,
            task_ref=task_ref,
            branch=branch,
            command=_format_argv_for_log(argv),
            cwd=str(cwd),
            log_file=str(log_path) if log_path else "",
            failure_reason="Selected dispatch failed before successful registration",
        )
    except Exception:
        log.error("Failed to persist the dispatch failure for %s.", task_ref)


def _cleanup_failed_process(
    proc: subprocess.Popen,
    *,
    role: str,
    assignment: RoleAssignment,
    task_ref: str,
    branch: str,
    argv: list[str],
    cwd: Path,
    log_path: Optional[Path],
) -> bool:
    """Stop a launched child while keeping any residual tree under supervision."""
    active_entry = tracker._active.get(proc.pid)
    if active_entry is None:
        tracked = TrackedProcess(
            pid=proc.pid,
            role=role,
            ai_name=assignment.ai,
            model=assignment.model,
            reasoning=assignment.reasoning,
            task_ref=task_ref,
            branch=branch,
            command=_format_argv_for_log(argv),
            cwd=str(cwd),
            log_file=str(log_path) if log_path else "",
            started_at=datetime.now(timezone.utc).isoformat(),
        )
        active_entry = (proc, tracked)
        tracker._active[proc.pid] = active_entry
        # Persist temporary RUNNING ownership before the bounded termination call.
        # If this leader is killed during cleanup, the next run can still reconcile
        # the process tree. Exactly one later save records removal or STUCK state.
        try:
            tracker._save_registry()
        except Exception:
            log.error("Failed to persist process supervision for PID %d.", proc.pid)

    try:
        stopped = terminate_process_group(proc)
    except BaseException:
        _, tracked = active_entry
        tracked.status = ProcessStatus.STUCK
        tracked.failure_reason = DISPATCH_RESIDUAL
        tracked.exit_code = proc.returncode
        try:
            tracker._save_registry()
        except Exception:
            log.error("Failed to persist residual process supervision for PID %d.", proc.pid)
        raise

    if stopped:
        tracker._active.pop(proc.pid, None)
        try:
            tracker._save_registry()
        except Exception:
            log.error("Failed to persist completed process cleanup for PID %d.", proc.pid)
        return True

    _, tracked = active_entry
    tracked.status = ProcessStatus.STUCK
    tracked.failure_reason = DISPATCH_RESIDUAL
    tracked.exit_code = proc.returncode
    try:
        tracker._save_registry()
    except Exception:
        log.error("Failed to persist residual process supervision for PID %d.", proc.pid)
    log.error("Residual process tree for PID %d remains under supervision.", proc.pid)
    return False


def dispatch_worker(
    issue: TaskIssue,
    dry_run: bool = False,
    task_ref: Optional[str] = None,
):
    """Dispatch a Worker AI to implement a task."""
    worker = issue.worker
    if not worker:
        log.warning("Issue #%d has no Worker tag, skipping.", issue.number)
        return

    # Extract short description from title, handling Korean/Unicode gracefully
    title_parts = issue.title.split("-")
    raw_desc = title_parts[-1].strip() if len(title_parts) > 1 else issue.title
    short_desc = re.sub(r"[^a-z0-9]+", "-", raw_desc.lower()).strip("-")[:30]
    if not short_desc:
        short_desc = f"task-{issue.number}"
    worker_slug = re.sub(r"[^a-z0-9]+", "-", worker.ai.lower()).strip("-")[:30]
    if not worker_slug:
        worker_slug = "worker"
    branch_name = f"worker/{issue.number}-{worker_slug}-{short_desc}"
    branch_arg = shlex.quote(branch_name)
    task_ref = task_ref or f"issue#{issue.number}:initial"
    worktree_path = WORKTREE_DIR / str(issue.number)
    argv: list[str] = []
    log_path: Optional[Path] = None
    stdout_file = None
    stderr_file = None
    proc = None
    dispatch_selected = not dry_run
    try:
        if not dry_run:
            worktree_path = create_worktree(issue.number, branch_name)

        prompt = (
            f"You are the Worker for Issue #{issue.number}: {issue.title}.\n"
            f"Read AGENTS.md and .agents/rules/ for all project rules.\n"
            f"Implement the task described in the Issue body:\n\n{issue.body}\n\n"
            f"Work inside this directory. When done:\n"
            f"1. Commit your changes with conventional commit messages referencing "
            f"#{issue.number}.\n"
            f"2. Push with `git push --set-upstream origin {branch_arg}`; always name `origin` "
            f"and the branch explicitly, and never use a remote-less `git push`.\n"
            f"3. Create a PR titled '[PR] {issue.number} - <summary>' with a "
            f"[Reviewer: ...] tag in the body.\n"
            f"4. The Reviewer AI MUST be different from Worker AI '{worker.ai}'.\n"
            f"5. Document your decisions and verification evidence in the PR description.\n\n"
            f"{EXECUTION_INTEGRITY_NOTICE}"
        )
        prompt_file = (
            PROMPT_DIR / "dry-run-worker.md"
            if dry_run
            else write_prompt_file(prompt, "worker", task_ref)
        )
        argv, use_stdin = build_ai_argv(
            worker.ai,
            worker.model,
            worker.reasoning,
            prompt_file,
            str(worktree_path),
            allow_tool_use=True,
            prompt_text=prompt if dry_run else None,
        )

        if dry_run:
            log.info("[DRY RUN] Would execute: %s", _format_argv_for_log(argv))
            return
        if not argv:
            raise RuntimeError(f"Unsupported Worker AI '{worker.ai}'.")

        log_path, stdout_file, stderr_file = create_log_files(
            "worker", task_ref, worker.ai,
        )
        log.info(
            "Dispatching Worker %s for Issue #%d (log: %s)",
            worker.ai,
            issue.number,
            log_path,
        )
        log.info("  argv: %s", _format_argv_for_log(argv))

        stdin_source = subprocess.DEVNULL
        pf = None
        try:
            if use_stdin:
                pf = open(prompt_file, "r", encoding="utf-8")
                stdin_source = pf
            with _defer_shutdown_during_process_registration():
                proc = _spawn_ai_process(
                    argv,
                    str(worktree_path),
                    stdout_file,
                    stderr_file,
                    stdin_source,
                )
                tracker.adopt(
                    proc=proc,
                    role="worker",
                    ai_name=worker.ai,
                    model=worker.model,
                    reasoning=worker.reasoning,
                    task_ref=task_ref,
                    branch=branch_name,
                    command=_format_argv_for_log(argv),
                    cwd=str(worktree_path),
                    log_file=str(log_path),
                )
            tracker.persist_registration()
        finally:
            if pf:
                pf.close()
    except BaseException as error:
        process_stopped = True
        if proc is not None:
            process_stopped = _cleanup_failed_process(
                proc,
                role="worker",
                assignment=worker,
                task_ref=task_ref,
                branch=branch_name,
                argv=argv,
                cwd=worktree_path,
                log_path=log_path,
            )
        if (
            isinstance(error, Exception)
            and dispatch_selected
            and process_stopped
            and not isinstance(error, SwarmPreflightError)
        ):
            _record_failed_dispatch(
                "worker", worker, task_ref, branch_name, argv, worktree_path, log_path,
            )
        if not isinstance(error, Exception):
            raise
        if isinstance(error, SwarmPreflightError):
            raise
        if isinstance(error, FileNotFoundError) and argv:
            log.error("AI CLI '%s' not found in PATH. Is it installed?", argv[0])
        else:
            log.error("Failed to dispatch Worker: %s", error)
        raise
    finally:
        if stdout_file is not None:
            stdout_file.close()
        if stderr_file is not None and stderr_file is not stdout_file:
            stderr_file.close()


def dispatch_reviewer(
    pr: TaskPR,
    worker: RoleAssignment,
    dry_run: bool = False,
    task_ref: Optional[str] = None,
    trigger: Optional[str] = None,
):
    """Dispatch a Reviewer AI to review a PR."""
    reviewer = pr.reviewer
    if not reviewer:
        log.warning("PR #%d has no Reviewer tag, skipping.", pr.number)
        return

    trigger_context = ""
    if trigger == "maintainer_block":
        trigger_context = (
            "A Maintainer blocked the previously approved PR. Re-evaluate the "
            "block evidence and either request the required Worker changes or "
            "issue a new approval.\n\n"
        )

    prompt = (
        f"You are the Reviewer for PR #{pr.number}: {pr.title}.\n"
        f"Read AGENTS.md and .agents/rules/review_checklist.md for review rules.\n"
        f"{trigger_context}"
        f"Review the PR diff, check code quality, and leave review comments.\n\n"
        f"When your review is complete, you MUST post exactly ONE final summary comment "
        f"on the PR containing your [Reviewer: ...] metadata tag. The tag format is:\n"
        f"  [Reviewer: {reviewer.ai} | Model: {reviewer.model} | "
        f"Reasoning: {reviewer.reasoning}]\n\n"
        f"If the PR is approved and ready to merge, your final comment MUST also include:\n"
        f"  [Maintainer: <ai_name> | Model: <model> | Reasoning: <level>]\n"
        f"Choose the Maintainer using .agents/rules/role_assignment.md. It MUST differ "
        f"from Worker '{worker.ai}' and Reviewer '{reviewer.ai}'.\n\n"
        f"If changes are needed, your final comment MUST include your [Reviewer: ...] tag "
        f"AND clearly describe all required changes. Do NOT include "
        f"[Maintainer: ...] in this case.\n\n"
        f"Follow the review checklist in .agents/rules/review_checklist.md.\n\n"
        f"{EXECUTION_INTEGRITY_NOTICE}"
    )

    task_ref = task_ref or f"review#{pr.number}-{pr.head_sha or 'initial'}"
    argv: list[str] = []
    log_path: Optional[Path] = None
    stdout_file = None
    stderr_file = None
    proc = None
    dispatch_selected = not dry_run
    try:
        prompt_file = (
            PROMPT_DIR / "dry-run-reviewer.md"
            if dry_run
            else write_prompt_file(prompt, "reviewer", task_ref)
        )
        argv, use_stdin = build_ai_argv(
            reviewer.ai,
            reviewer.model,
            reviewer.reasoning,
            prompt_file,
            str(REPO_ROOT),
            allow_tool_use=False,
            prompt_text=prompt if dry_run else None,
        )
        if dry_run:
            log.info("[DRY RUN] Would execute reviewer: %s", _format_argv_for_log(argv))
            return
        if not argv:
            raise RuntimeError(f"Unsupported Reviewer AI '{reviewer.ai}'.")

        log_path, stdout_file, stderr_file = create_log_files(
            "reviewer", task_ref, reviewer.ai,
        )
        log.info(
            "Dispatching Reviewer %s for PR #%d (log: %s)",
            reviewer.ai,
            pr.number,
            log_path,
        )

        stdin_source = subprocess.DEVNULL
        pf = None
        try:
            if use_stdin:
                pf = open(prompt_file, "r", encoding="utf-8")
                stdin_source = pf
            with _defer_shutdown_during_process_registration():
                proc = _spawn_ai_process(
                    argv,
                    str(REPO_ROOT),
                    stdout_file,
                    stderr_file,
                    stdin_source,
                )
                tracker.adopt(
                    proc=proc,
                    role="reviewer",
                    ai_name=reviewer.ai,
                    model=reviewer.model,
                    reasoning=reviewer.reasoning,
                    task_ref=task_ref,
                    branch=pr.head_branch,
                    command=_format_argv_for_log(argv),
                    cwd=str(REPO_ROOT),
                    log_file=str(log_path),
                )
            tracker.persist_registration()
        finally:
            if pf:
                pf.close()
    except BaseException as error:
        process_stopped = True
        if proc is not None:
            process_stopped = _cleanup_failed_process(
                proc,
                role="reviewer",
                assignment=reviewer,
                task_ref=task_ref,
                branch=pr.head_branch,
                argv=argv,
                cwd=REPO_ROOT,
                log_path=log_path,
            )
        if (
            isinstance(error, Exception)
            and dispatch_selected
            and process_stopped
            and not isinstance(error, SwarmPreflightError)
        ):
            _record_failed_dispatch(
                "reviewer", reviewer, task_ref, pr.head_branch, argv, REPO_ROOT, log_path,
            )
        if not isinstance(error, Exception):
            raise
        if isinstance(error, SwarmPreflightError):
            raise
        if isinstance(error, FileNotFoundError) and argv:
            log.error("AI CLI '%s' not found in PATH. Is it installed?", argv[0])
        else:
            log.error("Failed to dispatch Reviewer: %s", error)
        raise
    finally:
        if stdout_file is not None:
            stdout_file.close()
        if stderr_file is not None and stderr_file is not stdout_file:
            stderr_file.close()


def dispatch_maintainer(
    pr: TaskPR,
    issue: TaskIssue,
    maintainer: RoleAssignment,
    dry_run: bool = False,
    task_ref: Optional[str] = None,
):
    """Dispatch AI3 to maintain the PR and seed the next autonomous task."""
    prompt = (
        f"You are AI3, the Maintainer and post-merge Analyst for PR #{pr.number} "
        f"(Issue #{issue.number}).\n"
        f"Read AGENTS.md and .agents/rules/ for all project rules.\n"
        f"1. Verify that the independent review is complete and CI passes.\n"
        f"2. Merge PR #{pr.number}. A successful merge closes the PR.\n"
        f"3. Close Issue #{issue.number} only after the merge succeeds.\n"
        f"4. Comment on the PR with your exact metadata:\n"
        f"   [Maintainer: {maintainer.ai} | Model: {maintainer.model} | "
        f"Reasoning: {maintainer.reasoning}]\n"
        f"   Include the merge rationale and verification evidence.\n"
        f"   If you cannot merge, do not request or perform a retry. Instead, "
        f"post the metadata above plus an exact '[Maintainer Blocked]' line, "
        f"the blocker classification, and reproducible evidence. The "
        f"orchestrator will return the PR to the assigned Reviewer; do not "
        f"close the Issue or create a follow-up Issue.\n"
        f"5. Only after a successful merge, analyze the updated project and all "
        f"open Issues.\n"
        f"6. Only after a successful merge, create exactly ONE non-duplicate "
        f"follow-up Issue titled "
        f"'[Task] <Tool Name> - <Summary>'. Include requirements, acceptance criteria, "
        f"and a valid [Worker: <ai> | Model: <model> | Reasoning: <level>] tag.\n"
        f"7. Do not implement the follow-up Issue yourself. The orchestrator will "
        f"dispatch its Worker in the next polling cycle.\n"
        f"8. The orchestrator will safely remove the merged worktree.\n\n"
        f"{EXECUTION_INTEGRITY_NOTICE}"
    )

    task_ref = task_ref or f"maintain#{pr.number}"
    argv: list[str] = []
    log_path: Optional[Path] = None
    stdout_file = None
    stderr_file = None
    proc = None
    dispatch_selected = not dry_run
    try:
        prompt_file = (
            PROMPT_DIR / "dry-run-maintainer.md"
            if dry_run
            else write_prompt_file(prompt, "maintainer", task_ref)
        )
        argv, use_stdin = build_ai_argv(
            maintainer.ai,
            maintainer.model,
            maintainer.reasoning,
            prompt_file,
            str(REPO_ROOT),
            allow_tool_use=False,
            prompt_text=prompt if dry_run else None,
        )
        if dry_run:
            log.info("[DRY RUN] Would execute maintainer: %s", _format_argv_for_log(argv))
            return
        if not argv:
            raise RuntimeError(f"Unsupported Maintainer AI '{maintainer.ai}'.")

        log_path, stdout_file, stderr_file = create_log_files(
            "maintainer", task_ref, maintainer.ai,
        )
        log.info(
            "Dispatching Maintainer %s for PR #%d (log: %s)",
            maintainer.ai,
            pr.number,
            log_path,
        )

        stdin_source = subprocess.DEVNULL
        pf = None
        try:
            if use_stdin:
                pf = open(prompt_file, "r", encoding="utf-8")
                stdin_source = pf
            with _defer_shutdown_during_process_registration():
                proc = _spawn_ai_process(
                    argv,
                    str(REPO_ROOT),
                    stdout_file,
                    stderr_file,
                    stdin_source,
                )
                tracker.adopt(
                    proc=proc,
                    role="maintainer",
                    ai_name=maintainer.ai,
                    model=maintainer.model,
                    reasoning=maintainer.reasoning,
                    task_ref=task_ref,
                    branch="",
                    command=_format_argv_for_log(argv),
                    cwd=str(REPO_ROOT),
                    log_file=str(log_path),
                )
            tracker.persist_registration()
        finally:
            if pf:
                pf.close()
    except BaseException as error:
        process_stopped = True
        if proc is not None:
            process_stopped = _cleanup_failed_process(
                proc,
                role="maintainer",
                assignment=maintainer,
                task_ref=task_ref,
                branch="",
                argv=argv,
                cwd=REPO_ROOT,
                log_path=log_path,
            )
        if (
            isinstance(error, Exception)
            and dispatch_selected
            and process_stopped
            and not isinstance(error, SwarmPreflightError)
        ):
            _record_failed_dispatch(
                "maintainer", maintainer, task_ref, "", argv, REPO_ROOT, log_path,
            )
        if not isinstance(error, Exception):
            raise
        if isinstance(error, SwarmPreflightError):
            raise
        if isinstance(error, FileNotFoundError) and argv:
            log.error("AI CLI '%s' not found in PATH. Is it installed?", argv[0])
        else:
            log.error("Failed to dispatch Maintainer: %s", error)
        raise
    finally:
        if stdout_file is not None:
            stdout_file.close()
        if stderr_file is not None and stderr_file is not stdout_file:
            stderr_file.close()


def dispatch_worker_revision(
    pr: TaskPR,
    issue: TaskIssue,
    feedback_text: str,
    dry_run: bool = False,
    task_ref: Optional[str] = None,
):
    """Dispatch the original Worker AI to fix the PR based on feedback."""
    worker = issue.worker
    if not worker:
        log.warning(
            "Issue #%d has no Worker tag, cannot dispatch revision for PR #%d.",
            issue.number,
            pr.number,
        )
        return

    # Reuse the PR's actual branch so a title-derived branch cannot diverge.
    branch_name = pr.head_branch
    if not branch_name:
        log_blocker(
            f"revision-missing-head:{pr.number}",
            "PR #%d has no head branch, cannot dispatch revision.",
            pr.number,
            level=logging.WARNING,
        )
        return
    if pr.is_cross_repository:
        log_blocker(
            f"revision-cross-repository:{pr.number}",
            "PR #%d comes from a fork; Swarm cannot safely update it through origin.",
            pr.number,
            level=logging.WARNING,
        )
        return
    # Git and subprocess calls receive this ref as an argv element. Quote only the shell command
    # examples in the agent prompt so valid external/codex/claude branch names remain usable.
    branch_arg = shlex.quote(branch_name)

    # We must run inside the same worktree or recreate it. Dry-run only reports
    # the intended path and must not mutate git worktree state.
    worktree_path = WORKTREE_DIR / str(issue.number)
    task_ref = task_ref or f"revise#{pr.number}"
    argv: list[str] = []
    log_path: Optional[Path] = None
    stdout_file = None
    stderr_file = None
    proc = None
    dispatch_selected = not dry_run
    try:
        if not dry_run:
            fetched_head = fetch_pr_head(pr.number, pr.head_sha)
            worktree_path = create_worktree(
                issue.number,
                branch_name,
                start_ref=fetched_head,
                expected_sha=fetched_head,
            )

        prompt = (
            f"You are the Worker for PR #{pr.number} "
            f"(Issue #{issue.number}: {issue.title}).\n"
            f"Read AGENTS.md and .agents/rules/ for all project rules.\n"
            f"You previously created this PR, but additional modifications were requested. "
            f"Here is the feedback/comments:\n\n{feedback_text}\n\n"
            f"Work inside this directory. This worktree may be stale — first fetch and "
            f"rebase {branch_arg} onto the latest origin/main yourself before making "
            f"any changes, so your commit isn't built on an outdated base. When done:\n"
            f"1. Fix the code according to the feedback.\n"
            f"2. Commit your changes with conventional commit messages.\n"
            f"3. Push with `git push --set-upstream origin {branch_arg}`; always name `origin` "
            f"and the branch explicitly, and never use a remote-less `git push`. If the push is "
            f"rejected (e.g. non-fast-forward), that is a FAILED push, not a completed one — "
            f"resolve it (rebase/force-push your own branch as needed) and push again before "
            f"proceeding.\n"
            f"4. Add a comment to the PR containing EXACTLY the phrase:\n"
            f"   [Worker] Revision complete.\n"
            f"   indicating it is ready for another review.\n\n"
            f"{EXECUTION_INTEGRITY_NOTICE}"
        )
        prompt_file = (
            PROMPT_DIR / "dry-run-worker-revise.md"
            if dry_run
            else write_prompt_file(prompt, "worker-revise", task_ref)
        )
        argv, use_stdin = build_ai_argv(
            worker.ai,
            worker.model,
            worker.reasoning,
            prompt_file,
            str(worktree_path),
            allow_tool_use=True,
            prompt_text=prompt if dry_run else None,
        )
        if dry_run:
            log.info(
                "[DRY RUN] Would execute worker revision: %s",
                _format_argv_for_log(argv),
            )
            return
        if not argv:
            raise RuntimeError(f"Unsupported Worker AI '{worker.ai}'.")

        log_path, stdout_file, stderr_file = create_log_files(
            "worker_revise", task_ref, worker.ai,
        )
        log.info(
            "Dispatching Worker %s for PR #%d Revision (log: %s)",
            worker.ai,
            pr.number,
            log_path,
        )
        log.info("  argv: %s", _format_argv_for_log(argv))

        stdin_source = subprocess.DEVNULL
        pf = None
        try:
            if use_stdin:
                pf = open(prompt_file, "r", encoding="utf-8")
                stdin_source = pf
            with _defer_shutdown_during_process_registration():
                proc = _spawn_ai_process(
                    argv,
                    str(worktree_path),
                    stdout_file,
                    stderr_file,
                    stdin_source,
                )
                tracker.adopt(
                    proc=proc,
                    role="worker_revise",
                    ai_name=worker.ai,
                    model=worker.model,
                    reasoning=worker.reasoning,
                    task_ref=task_ref,
                    branch=branch_name,
                    command=_format_argv_for_log(argv),
                    cwd=str(worktree_path),
                    log_file=str(log_path),
                )
            tracker.persist_registration()
        finally:
            if pf:
                pf.close()
    except BaseException as error:
        process_stopped = True
        if proc is not None:
            process_stopped = _cleanup_failed_process(
                proc,
                role="worker_revise",
                assignment=worker,
                task_ref=task_ref,
                branch=branch_name,
                argv=argv,
                cwd=worktree_path,
                log_path=log_path,
            )
        if (
            isinstance(error, Exception)
            and dispatch_selected
            and process_stopped
            and not isinstance(error, SwarmPreflightError)
        ):
            _record_failed_dispatch(
                "worker_revise",
                worker,
                task_ref,
                branch_name,
                argv,
                worktree_path,
                log_path,
            )
        if not isinstance(error, Exception):
            raise
        if isinstance(error, SwarmPreflightError):
            raise
        if isinstance(error, FileNotFoundError) and argv:
            log.error("AI CLI '%s' not found in PATH. Is it installed?", argv[0])
        else:
            log.error("Failed to dispatch Worker Revision: %s", error)
        raise
    finally:
        if stdout_file is not None:
            stdout_file.close()
        if stderr_file is not None and stderr_file is not stdout_file:
            stderr_file.close()


# ---------------------------------------------------------------------------
# Main Polling Loop
# ---------------------------------------------------------------------------

def _process_issue_batch(
    dry_run: bool = False,
    open_issues: Optional[list[dict]] = None,
    open_prs: Optional[list[dict]] = None,
    pr_issue_numbers: Optional[set[int]] = None,
):
    """Process a caller-provided Issue batch without exception isolation."""
    issues = open_issues if open_issues is not None else fetch_open_issues()
    if open_prs is None:
        open_prs = fetch_open_prs()

    if pr_issue_numbers is None:
        pr_issue_numbers = set()
        for pr in open_prs:
            pr_title = pr.get("title", "")
            issue_num = extract_issue_number_from_pr_title(pr_title)
            if issue_num:
                pr_issue_numbers.add(issue_num)

    for raw in issues:
        num = raw["number"]

        if not raw.get("title", "").startswith("[Task]"):
            log.debug(
                "Open Issue #%d is not a [Task] Issue; inspected without dispatch.",
                num,
            )
            continue

        # 1. If PR already exists, Worker is done (or PR handles the rest)
        if num in pr_issue_numbers:
            continue

        worker = parse_role(WORKER_PATTERN, raw.get("body", ""))
        if not worker:
            log.debug("Issue #%d has no Worker metadata, skipping.", num)
            continue

        # 2. A persistent event key prevents repeat dispatch after completion.
        # The still-open Issue and missing PR prove that a prior zero exit code
        # did not complete the required GitHub transition.
        task_ref = f"issue#{num}:initial"
        allowed, reason = tracker.should_dispatch(
            task_ref,
            role="worker",
            completion_confirmed=False,
            ai_name=worker.ai,
        )
        if not allowed:
            log_dispatch_blocker(
                f"dispatch-blocked:{task_ref}",
                f"Issue #{num} Worker",
                reason,
            )
            log.debug("Skipping Worker for Issue #%d: %s.", num, reason)
            continue

        # 3. Dispatch Worker
        issue = TaskIssue(
            number=num,
            title=raw["title"],
            body=raw.get("body", ""),
            worker=worker,
        )

        log.info(
            "=== Open Task Issue #%d needs Worker (%s): %s ===",
            num, reason, issue.title,
        )
        dispatch_worker(issue, dry_run, task_ref=task_ref)
        clear_item_preflight_blockers("Issue", num, "initial")


def process_issues(
    dry_run: bool = False,
    open_issues: Optional[list[dict]] = None,
    open_prs: Optional[list[dict]] = None,
) -> int:
    """Process every Issue independently and return the number that failed."""
    issues = open_issues if open_issues is not None else fetch_open_issues()
    prs = open_prs if open_prs is not None else fetch_open_prs()
    pr_issue_numbers = {
        issue_number
        for pr in prs
        if (issue_number := extract_issue_number_from_pr_title(pr.get("title", "")))
    }
    failures = 0
    for raw in issues:
        item_number = raw.get("number", "?")
        lifecycle_version = "initial"
        try:
            _process_issue_batch(
                dry_run,
                [raw],
                prs,
                pr_issue_numbers=pr_issue_numbers,
            )
        except SwarmPreflightError as error:
            failures += 1
            log_item_preflight_blocker(
                "Issue",
                item_number,
                lifecycle_version,
                error,
            )
        except Exception as error:
            failures += 1
            log.error(
                "Failed to process Issue #%s: %s",
                raw.get("number", "?"),
                error,
                exc_info=True,
            )
    return failures


def _process_pr_batch(
    dry_run: bool = False,
    open_prs: Optional[list[dict]] = None,
    current_user: Optional[str] = None,
):
    """Process a caller-provided PR batch without exception isolation."""
    prs = open_prs if open_prs is not None else fetch_open_prs()

    for raw in prs:
        pr_num = raw["number"]
        pr_title = raw.get("title", "")
        pr_body = raw.get("body", "")
        head_branch = raw.get("headRefName", "")
        head_sha = raw.get("headRefOid", "")
        issue_number = extract_issue_number_from_pr_title(pr_title)

        # Validate cheaply before spending API calls on comments and the Issue.
        if issue_number is None:
            log_blocker(
                f"pr-title:{pr_num}",
                "PR #%d has no Issue number in its title; refusing role dispatch.",
                pr_num,
            )
            continue

        reviewer = parse_role(REVIEWER_PATTERN, pr_body)
        if not reviewer:
            log_blocker(
                f"pr-reviewer:{pr_num}:{head_sha}",
                "PR #%d has no Reviewer metadata; refusing dispatch.",
                pr_num,
            )
            continue

        issue_raw = fetch_issue(issue_number)
        if not issue_raw:
            log_blocker(
                f"pr-issue:{pr_num}:{issue_number}",
                "Could not fetch Issue #%d for PR #%d.", issue_number, pr_num,
            )
            continue

        worker = parse_role(WORKER_PATTERN, issue_raw.get("body", ""))
        if not worker:
            log_blocker(
                f"pr-worker:{pr_num}:{issue_number}",
                "Issue #%d has no Worker metadata; refusing dispatch for PR #%d.",
                issue_number, pr_num,
            )
            continue

        comments = fetch_pr_comments(pr_num)
        current_user = current_user if current_user is not None else get_gh_user()
        if not current_user:
            log.warning(
                "Cannot determine current GitHub user; skipping comment-signal processing for PR #%d.",
                pr_num,
            )
            continue

        # Only trust comments from the orchestrator user or repo owners/collaborators
        trusted_comments = []
        for c in comments:
            author_login = c.get("author", {}).get("login")
            assoc = c.get("authorAssociation")
            if author_login == current_user or assoc in ("OWNER", "COLLABORATOR", "MEMBER"):
                trusted_comments.append(c)

        pr_obj = TaskPR(
            number=pr_num,
            title=pr_title,
            body=pr_body,
            head_branch=head_branch,
            head_sha=head_sha,
            is_cross_repository=raw.get("isCrossRepository") is True,
            issue_number=issue_number,
        )

        issue_obj = TaskIssue(
            number=issue_number,
            title=issue_raw["title"],
            body=issue_raw.get("body", ""),
            worker=worker,
        )
        pr_obj.reviewer = reviewer
        action, signal_comment, signal_index = determine_pr_action(trusted_comments)
        signal_id = (
            comment_signal_id(signal_comment, signal_index)
            if signal_comment is not None
            else "initial"
        )

        if action == "maintain":
            approval_reviewer = parse_role(
                REVIEWER_PATTERN,
                signal_comment.get("body", ""),
            )
            maintainer = parse_role(
                MAINTAINER_PATTERN,
                signal_comment.get("body", ""),
            )
            if not approval_reviewer or approval_reviewer.ai != reviewer.ai:
                log_blocker(
                    f"approval-reviewer:{pr_num}:{signal_id}",
                    "PR #%d approval signal does not match assigned Reviewer '%s'.",
                    pr_num,
                    reviewer.ai,
                )
                continue
            valid, why = validate_distinct_roles(worker, reviewer, maintainer)
            if not valid:
                log_blocker(
                    f"roles:{pr_num}:{signal_id}",
                    "PR #%d role assignment rejected: %s.", pr_num, why,
                )
                continue

            task_ref = f"maintain#{pr_num}-{signal_id}"
            allowed, reason = tracker.should_dispatch(
                task_ref,
                role="maintainer",
                completion_confirmed=False,
                ai_name=maintainer.ai,
            )
            if not allowed:
                log_dispatch_blocker(
                    f"dispatch-blocked:{task_ref}",
                    f"PR #{pr_num} Maintainer",
                    reason,
                )
                log.debug("Skipping Maintainer for PR #%d: %s.", pr_num, reason)
                continue
            log.info(
                "=== PR #%d approved, dispatching AI3 Maintainer (%s) ===",
                pr_num, reason,
            )
            dispatch_maintainer(
                pr_obj,
                issue_obj,
                maintainer,
                dry_run,
                task_ref=task_ref,
            )
            clear_item_preflight_blockers("PR", pr_num, head_sha or "initial")
            continue

        valid, why = validate_distinct_roles(worker, reviewer)
        if not valid:
            log_blocker(
                f"roles:{pr_num}:{head_sha}",
                "PR #%d role assignment rejected: %s.", pr_num, why,
            )
            continue

        if action in ("review", "review_after_maintainer_block"):
            review_trigger = None
            if action == "review_after_maintainer_block":
                blocked_maintainer = parse_role(
                    MAINTAINER_PATTERN,
                    signal_comment.get("body", ""),
                )
                valid, why = validate_distinct_roles(
                    worker,
                    reviewer,
                    blocked_maintainer,
                )
                if not valid:
                    log_blocker(
                        f"maintainer-block-roles:{pr_num}:{signal_id}",
                        "PR #%d Maintainer block rejected: %s.",
                        pr_num,
                        why,
                    )
                    continue
                review_version = f"maintainer-block-{signal_id}"
                review_trigger = "maintainer_block"
            else:
                review_version = head_sha or signal_id
            task_ref = f"review#{pr_num}-{review_version}"
            allowed, reason = tracker.should_dispatch(
                task_ref,
                role="reviewer",
                completion_confirmed=False,
                ai_name=reviewer.ai,
            )
            if not allowed:
                log_dispatch_blocker(
                    f"dispatch-blocked:{task_ref}",
                    f"PR #{pr_num} Reviewer",
                    reason,
                )
                # A finished review on an unchanged head SHA cannot produce a
                # new event key, so the lifecycle would stall in silence: either
                # the Worker never pushed, or the Reviewer posted no tagged
                # comment. A review still running is normal and stays quiet.
                if signal_comment is not None and reason == DISPATCH_COMPLETED:
                    log_blocker(
                        f"stale-revision:{pr_num}:{signal_id}",
                        "PR #%d already reviewed head SHA %s and has no newer signal; "
                        "the Worker may not have pushed, or the Reviewer left no tag.",
                        pr_num, review_version,
                        level=logging.WARNING,
                    )
                log.debug("Skipping Reviewer for PR #%d: %s.", pr_num, reason)
                continue
            log.info(
                "=== PR #%d needs review for %s (%s) ===",
                pr_num, review_version, reason,
            )
            dispatch_reviewer(
                pr_obj,
                worker,
                dry_run,
                task_ref=task_ref,
                trigger=review_trigger,
            )
            clear_item_preflight_blockers("PR", pr_num, head_sha or "initial")
            continue

        task_ref = f"revise#{pr_num}-{signal_id}"
        allowed, reason = tracker.should_dispatch(
            task_ref,
            role="worker_revise",
            completion_confirmed=False,
            ai_name=worker.ai,
        )
        if not allowed:
            log_dispatch_blocker(
                f"dispatch-blocked:{task_ref}",
                f"PR #{pr_num} Worker revision",
                reason,
            )
            log.debug("Skipping Worker revision for PR #%d: %s.", pr_num, reason)
            continue
        feedback_reviewer = parse_role(
            REVIEWER_PATTERN,
            signal_comment.get("body", ""),
        )
        if not feedback_reviewer or feedback_reviewer.ai != reviewer.ai:
            log_blocker(
                f"feedback-reviewer:{pr_num}:{signal_id}",
                "PR #%d feedback signal does not match assigned Reviewer '%s'.",
                pr_num,
                reviewer.ai,
            )
            continue
        log.info(
            "=== PR #%d needs Worker revision for %s (%s) ===",
            pr_num, signal_id, reason,
        )
        dispatch_worker_revision(
            pr_obj,
            issue_obj,
            signal_comment.get("body", ""),
            dry_run,
            task_ref=task_ref,
        )
        clear_item_preflight_blockers("PR", pr_num, head_sha or "initial")


def process_prs(
    dry_run: bool = False,
    open_prs: Optional[list[dict]] = None,
) -> int:
    """Process every PR independently and return the number that failed."""
    prs = open_prs if open_prs is not None else fetch_open_prs()
    if not prs:
        return 0
    current_user = get_gh_user()
    if not current_user:
        log.error(
            "Cannot determine the authenticated GitHub user; %d PR item(s) failed closed.",
            len(prs),
        )
        return len(prs)
    failures = 0
    for raw in prs:
        item_number = raw.get("number", "?")
        lifecycle_version = raw.get("headRefOid", "") or "initial"
        try:
            _process_pr_batch(dry_run, [raw], current_user=current_user)
        except SwarmPreflightError as error:
            failures += 1
            log_item_preflight_blocker(
                "PR",
                item_number,
                lifecycle_version,
                error,
            )
        except Exception as error:
            failures += 1
            log.error(
                "Failed to process PR #%s: %s",
                raw.get("number", "?"),
                error,
                exc_info=True,
            )
    return failures


def close_issue_if_open(issue_num: int, pr_num: int, dry_run: bool):
    """Close the Issue behind a merged PR if it is still open."""
    issue_raw = gh(["issue", "view", str(issue_num), "--json", "state"], check=False)
    if not issue_raw:
        return
    if json.loads(issue_raw).get("state") != "OPEN":
        return
    log.info("🧹 PR #%d is merged. Closing associated Issue #%d", pr_num, issue_num)
    if not dry_run:
        gh(["issue", "close", str(issue_num)], check=False)


def cleanup_merged_prs(dry_run: bool = False):
    """Close merged Issues and safely clean their task worktrees."""
    raw = gh([
        "pr", "list",
        "--state", "merged",
        "--limit", "20",
        "--json", "number,title,headRefName",
    ], check=False)
    if not raw:
        return
    try:
        merged_prs = json.loads(raw)
    except json.JSONDecodeError:
        return

    for pr in merged_prs:
        pr_title = pr.get("title", "")
        issue_num = extract_issue_number_from_pr_title(pr_title)
        if not issue_num:
            continue

        try:
            close_issue_if_open(issue_num, pr["number"], dry_run)
        except Exception as e:
            log.error("Failed to check/close issue #%d: %s", issue_num, e)

        # Worktree cleanup is independent of the Issue state: a failed Issue
        # lookup must not leave the merged worktree behind forever.
        branch_name = pr.get("headRefName", "")
        if branch_name and not dry_run:
            try:
                cleanup_worktree(issue_num, branch_name)
            except Exception as e:
                log.error("Failed to clean worktree for issue #%d: %s", issue_num, e)


def log_open_items(issues: list[dict], prs: list[dict]):
    """Log the complete startup snapshot before dispatch decisions are made."""
    log.info(
        "Initial GitHub scan found %d open Issue(s) and %d open PR(s).",
        len(issues),
        len(prs),
    )
    for issue in issues:
        log.info(
            "  Open Issue #%s: %s",
            issue.get("number", "?"),
            issue.get("title", "(untitled)"),
        )
    for pr in prs:
        log.info(
            "  Open PR #%s: %s",
            pr.get("number", "?"),
            pr.get("title", "(untitled)"),
        )


def process_polling_cycle(dry_run: bool = False, initial: bool = False) -> int:
    """Fetch one snapshot, advance every open item, and return isolated failures."""
    # Fetch both collections before dispatch. If either critical query fails,
    # the cycle fails closed instead of creating a duplicate Worker while its
    # existing PR was merely unavailable.
    open_issues = fetch_open_issues()
    open_prs = fetch_open_prs()

    if initial:
        log_open_items(open_issues, open_prs)

    failures = process_issues(
        dry_run,
        open_issues=open_issues,
        open_prs=open_prs,
    )
    failures += process_prs(dry_run, open_prs)
    return failures


def run_loop(
    interval: int,
    dry_run: bool = False,
    preflight_completed: bool = False,
) -> int:
    """Run the polling loop under the shared shutdown-signal controller."""
    with _shutdown_signal_controller():
        return _run_loop_impl(interval, dry_run, preflight_completed)


def _run_loop_impl(
    interval: int,
    dry_run: bool = False,
    preflight_completed: bool = False,
) -> int:
    """Main polling loop with process status monitoring."""
    log.info("=" * 60)
    log.info("Swarm Orchestrator started")
    log.info("Repo root: %s", REPO_ROOT)
    log.info("Poll interval: %ds", interval)
    log.info("Dry run: %s", dry_run)
    log.info("Log directory: %s", LOG_DIR)
    log.info("=" * 60)

    initial = True
    cycle_count = 0
    while True:
        try:
            try:
                log.info("--- Polling cycle (active: %d) ---", tracker.active_count)

                # Supervise already-running local children even when the network preflight is
                # temporarily unavailable. The write gate still runs before sync/dispatch/writes.
                if not dry_run:
                    tracker.poll_all()

                # A successful startup preflight covers only the first cycle. Every later cycle
                # rechecks before Git sync, dispatch, or direct GitHub writes so revoked access
                # stops new lifecycle work without restarting this long-lived process.
                if not dry_run:
                    if preflight_completed:
                        preflight_completed = False
                    else:
                        assert_repo_workflow_writable()

                # Keep local main current so new worktrees branch from a fresh
                # base. Cheap, but still throttled — no need to hit the network
                # every single interval.
                cycle_count += 1
                if cycle_count == 1 or cycle_count % MAIN_SYNC_EVERY_CYCLES == 0:
                    try:
                        sync_main_branch(dry_run)
                    except Exception as e:
                        log.error("Error syncing main branch: %s", e, exc_info=True)

                # Poll every open item immediately on startup and every interval
                process_polling_cycle(dry_run, initial=initial)
                cleanup_merged_prs(dry_run)
                initial = False
            except SwarmPreflightError as error:
                _log_preflight_failure(error)
            except Exception as e:
                log.error("Error in polling cycle: %s", e, exc_info=True)

            _raise_if_shutdown_pending()
            log.info("Sleeping %ds...", interval)
            time.sleep(interval)
        except KeyboardInterrupt:
            log.info("Shutting down gracefully...")
            try:
                stopped = dry_run or tracker.kill_all()
            except Exception as error:
                log.error("Shutdown cleanup failed: %s", error, exc_info=True)
                return 1
            if not stopped:
                log.error("Shutdown left supervised process trees active; exiting non-zero.")
                return 1
            return 0


def run_once(dry_run: bool = False) -> int:
    """Run one polling cycle under the shared shutdown-signal controller."""
    with _shutdown_signal_controller():
        return _run_once_impl(dry_run)


def _run_once_impl(dry_run: bool = False) -> int:
    """Run one polling cycle and return a concise process exit status."""
    log.info("Repo root: %s", REPO_ROOT)
    try:
        log.info("Running single polling cycle...")
        sync_main_branch(dry_run)
        item_failures = process_polling_cycle(dry_run, initial=True)
        _raise_if_shutdown_pending()
        try:
            if not dry_run:
                tracker.poll_all()
        finally:
            # A registry persistence error while harvesting a just-finished Maintainer must not
            # skip the one cleanup pass that can close its merged Issue in one-shot mode.
            cleanup_merged_prs(dry_run)
        _raise_if_shutdown_pending()
        if item_failures:
            log.error("Single polling cycle completed with %d item failure(s).", item_failures)
            return 1
        log.info("Done.")
        return 0
    except KeyboardInterrupt:
        log.info("Single polling cycle interrupted.")
        if not dry_run:
            try:
                stopped = tracker.kill_all()
            except Exception as error:
                log.error("Shutdown cleanup failed: %s", error, exc_info=True)
                return 1
            if not stopped:
                log.error("Shutdown left supervised process trees active; exiting non-zero.")
                return 1
        return 130
    except subprocess.SubprocessError as error:
        # gh() has already logged the actionable command failure or timeout.
        log.error("Single polling cycle failed: %s", error)
        return 1
    except Exception as error:
        log.error("Single polling cycle failed: %s", error, exc_info=True)
        return 1


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Swarm Orchestrator — Autonomous Multi-Agent Swarm for Dev Toolkit",
    )
    parser.add_argument(
        "--interval", type=int, default=POLL_INTERVAL_SECONDS,
        help=f"Polling interval in seconds (default: {POLL_INTERVAL_SECONDS})",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print commands without executing them",
    )
    parser.add_argument(
        "--once", action="store_true",
        help="Run a single polling cycle and exit",
    )
    parser.add_argument(
        "--status", action="store_true",
        help="Print status of all tracked AI processes and exit",
    )
    parser.add_argument(
        "--reset", action="store_true",
        help="Reset process history database on startup",
    )
    args = parser.parse_args()

    if args.status:
        log.info("Repo root: %s", REPO_ROOT)
        print(tracker.get_summary())
        return 0

    if args.dry_run:
        try:
            # Dry-run needs repository identity for read-only gh calls, but it never pushes, so
            # custom Git SSH transport commands are not part of its safety boundary.
            _bind_origin_repository(verify_transport=False)
        except SwarmPreflightError as error:
            _log_preflight_failure(error)
            return 1
        if args.reset:
            log.info("[DRY RUN] Would reset process history")
    else:
        # `--reset` explicitly authorizes this local history mutation and must remain useful while
        # GitHub is offline or access is being repaired. It never touches a worktree or GitHub.
        if args.reset:
            reset_process_history()
        try:
            _assert_dispatch_platform()
            _assert_dispatch_environment()
            assert_repo_workflow_writable()
        except SwarmPreflightError as error:
            _log_preflight_failure(error)
            return 1
        enable_runtime_writes()
        cleanup_old_task_logs()

    if args.once:
        return run_once(args.dry_run)
    return run_loop(
        args.interval,
        args.dry_run,
        preflight_completed=not args.dry_run,
    )


if __name__ == "__main__":
    sys.exit(main())
