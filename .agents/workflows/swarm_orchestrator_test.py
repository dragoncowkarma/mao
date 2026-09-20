import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import ANY, MagicMock, patch


SCRIPT_PATH = Path(__file__).with_name("swarm_orchestrator.py")


def gh_api_response(body: dict, status: int = 200, headers: dict | None = None) -> str:
    reason = "OK" if status == 200 else "Error"
    # gh 2.92 emits a LF status line followed by CRLF headers and terminator.
    header_lines = "".join(
        f"{name}: {value}\r\n" for name, value in (headers or {}).items()
    )
    return f"HTTP/2.0 {status} {reason}\n{header_lines}\r\n{json.dumps(body)}"


class WorktreeSafetyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory(prefix="mao-swarm-test-")
        cls.repo = Path(cls.temp_dir.name)
        subprocess.run(["git", "init", "-b", "main", str(cls.repo)], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", str(cls.repo), "config", "user.email", "test@example.com"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(cls.repo), "config", "user.name", "MAO Test"],
            check=True,
        )
        subprocess.run(
            [
                "git", "-C", str(cls.repo), "remote", "add", "origin",
                "https://github.com/acme/widgets.git",
            ],
            check=True,
        )
        (cls.repo / "README.md").write_text("test\n")
        subprocess.run(["git", "-C", str(cls.repo), "add", "README.md"], check=True)
        subprocess.run(["git", "-C", str(cls.repo), "commit", "-m", "initial"], check=True, capture_output=True)
        head = subprocess.run(
            ["git", "-C", str(cls.repo), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["git", "-C", str(cls.repo), "update-ref", "refs/remotes/origin/main", head],
            check=True,
        )

        exclude_path = cls.repo / ".git" / "info" / "exclude"
        exclude_before = exclude_path.read_text()
        os.environ["MAO_SWARM_REPO_ROOT"] = str(cls.repo)
        spec = importlib.util.spec_from_file_location("mao_swarm_test_module", SCRIPT_PATH)
        cls.swarm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.swarm)
        cls.import_wrote_runtime_files = (cls.repo / ".agents").exists()
        cls.import_changed_excludes = exclude_path.read_text() != exclude_before
        cls.swarm.enable_runtime_writes()

    def _bind_test_target(self):
        target = self.swarm.GitHubRepoTarget(
            "github.com",
            "acme",
            "widgets",
            http_endpoint=self.swarm.HttpEndpoint("https", "github.com", 443),
        )
        self.swarm._ACTIVE_GH_REPO_CONTEXT = target.gh_context
        self.swarm._ACTIVE_REPO_TARGET = target
        return target

    @classmethod
    def tearDownClass(cls):
        cls.temp_dir.cleanup()

    def tearDown(self):
        self.swarm._ACTIVE_GH_REPO_CONTEXT = None
        self.swarm._ACTIVE_REPO_TARGET = None
        for entry in self.swarm.list_git_worktrees():
            path = Path(entry["worktree"])
            if path != self.repo:
                subprocess.run(
                    ["git", "-C", str(self.repo), "worktree", "remove", "--force", str(path)],
                    check=False,
                    capture_output=True,
                )
        for branch in ("worker/1-test", "worker/2-test", "worker/3-test", "worker/4-test"):
            subprocess.run(
                ["git", "-C", str(self.repo), "branch", "-D", branch],
                check=False,
                capture_output=True,
            )

    def test_reuses_only_the_expected_registered_worktree(self):
        self._bind_test_target()
        with patch.object(
            self.swarm,
            "_assert_worktree_push_target",
            wraps=self.swarm._assert_worktree_push_target,
        ) as assert_push_target:
            created = self.swarm.create_worktree(1, "worker/1-test")
            self.assertEqual(created, self.swarm.create_worktree(1, "worker/1-test"))

        self.assertEqual(assert_push_target.call_count, 2)

    def test_runtime_artifacts_are_locally_excluded(self):
        status = subprocess.run(
            ["git", "-C", str(self.repo), "status", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        self.assertEqual(status, "")

    def test_module_import_is_read_only_for_status_mode(self):
        self.assertFalse(self.import_wrote_runtime_files)
        self.assertFalse(self.import_changed_excludes)

    def test_dry_run_does_not_write_prompt_files(self):
        shutil.rmtree(self.swarm.PROMPT_DIR, ignore_errors=True)
        issue = self.swarm.TaskIssue(
            number=99,
            title="[Task] dry run",
            body="No writes",
            worker=self.swarm.RoleAssignment("codex", "5.6", "high"),
        )

        with patch.object(
            self.swarm,
            "build_ai_argv",
            return_value=([], False),
        ) as build_ai_argv:
            self.swarm.dispatch_worker(issue, dry_run=True)

        self.assertFalse(self.swarm.PROMPT_DIR.exists())
        prompt = build_ai_argv.call_args.kwargs["prompt_text"]
        self.assertIn("git push --set-upstream origin worker/99-codex-task-dry-run", prompt)
        self.assertIn("never use a remote-less `git push`", prompt)

    def test_worker_revision_prompt_pins_origin_push(self):
        issue = self.swarm.TaskIssue(
            number=99,
            title="[Task] dry run",
            body="No writes",
            worker=self.swarm.RoleAssignment("codex", "5.6", "high"),
        )
        pr = self.swarm.TaskPR(
            number=101,
            title="[PR] dry run",
            body="No writes",
            head_branch="worker/99-codex-dry-run",
        )
        with patch.object(
            self.swarm,
            "build_ai_argv",
            return_value=([], False),
        ) as build_ai_argv:
            self.swarm.dispatch_worker_revision(
                pr,
                issue,
                "Please revise",
                dry_run=True,
            )

        prompt = build_ai_argv.call_args.kwargs["prompt_text"]
        self.assertIn("git push --set-upstream origin worker/99-codex-dry-run", prompt)
        self.assertIn("never use a remote-less `git push`", prompt)

    def test_worker_revision_shell_quotes_arbitrary_valid_head_branch(self):
        sentinel = "touch-pwned"
        issue = self.swarm.TaskIssue(
            number=99,
            title="[Task] unsafe branch",
            body="No writes",
            worker=self.swarm.RoleAssignment("codex", "5.6", "high"),
        )
        pr = self.swarm.TaskPR(
            number=101,
            title="[PR] unsafe branch",
            body="No writes",
            head_branch=f"codex/fix;$({sentinel})",
        )
        with patch.object(
            self.swarm,
            "build_ai_argv",
            return_value=([], False),
        ) as build_ai_argv:
            self.swarm.dispatch_worker_revision(
                pr,
                issue,
                "Please revise",
                dry_run=True,
            )

        prompt = build_ai_argv.call_args.kwargs["prompt_text"]
        quoted_branch = f"'codex/fix;$({sentinel})'"
        self.assertIn(f"git push --set-upstream origin {quoted_branch}", prompt)
        self.assertIn(f"rebase {quoted_branch} onto", prompt)

    def test_worker_normalizes_unicode_provider_for_generated_branch(self):
        issue = self.swarm.TaskIssue(
            number=99,
            title="한글 작업",
            body="No writes",
            worker=self.swarm.RoleAssignment("코덱스", "5.6", "high"),
        )
        with patch.object(
            self.swarm,
            "build_ai_argv",
            return_value=([], False),
        ) as build_ai_argv:
            self.swarm.dispatch_worker(issue, dry_run=True)

        prompt = build_ai_argv.call_args.kwargs["prompt_text"]
        self.assertIn(
            "git push --set-upstream origin worker/99-worker-task-99",
            prompt,
        )

    def test_dry_run_skips_git_sync(self):
        with patch.object(self.swarm.subprocess, "run") as run:
            self.swarm.sync_main_branch(dry_run=True)
        run.assert_not_called()

    def test_default_loop_waits_for_another_poll_when_idle(self):
        with (
            patch.object(self.swarm.signal, "signal"),
            patch.object(self.swarm, "sync_main_branch"),
            patch.object(self.swarm, "process_polling_cycle") as poll,
            patch.object(self.swarm.time, "sleep", side_effect=KeyboardInterrupt),
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.swarm.run_loop(interval=30, dry_run=True)
        poll.assert_called_once_with(True, initial=True)

    def test_real_loop_rechecks_preflight_before_each_later_cycle(self):
        with (
            patch.object(self.swarm.signal, "signal"),
            patch.object(self.swarm, "assert_repo_workflow_writable") as preflight,
            patch.object(self.swarm.tracker, "poll_all"),
            patch.object(self.swarm, "sync_main_branch"),
            patch.object(
                self.swarm,
                "process_polling_cycle",
                side_effect=[None, KeyboardInterrupt],
            ),
            patch.object(self.swarm.time, "sleep"),
        ):
            self.swarm.run_loop(
                interval=30,
                dry_run=False,
                preflight_completed=True,
            )

        preflight.assert_called_once_with()

    def test_real_loop_polls_children_before_transient_preflight_failure(self):
        events = []

        def poll_children():
            events.append("poll")

        def fail_preflight():
            events.append("preflight")
            raise self.swarm.SwarmPreflightTransientError("try later")

        with (
            patch.object(self.swarm.signal, "signal"),
            patch.object(self.swarm.tracker, "poll_all", side_effect=poll_children),
            patch.object(
                self.swarm,
                "assert_repo_workflow_writable",
                side_effect=fail_preflight,
            ),
            patch.object(self.swarm, "sync_main_branch") as sync_main,
            patch.object(self.swarm, "process_polling_cycle") as poll_remote,
            patch.object(self.swarm.time, "sleep", side_effect=KeyboardInterrupt),
            patch.object(self.swarm.log, "error"),
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.swarm.run_loop(interval=30, dry_run=False)

        self.assertEqual(events, ["poll", "preflight"])
        sync_main.assert_not_called()
        poll_remote.assert_not_called()

    def test_once_subprocess_failure_returns_nonzero_without_traceback(self):
        with (
            patch.object(self.swarm, "sync_main_branch"),
            patch.object(
                self.swarm,
                "process_polling_cycle",
                side_effect=subprocess.CalledProcessError(1, ["gh", "issue", "list"]),
            ),
            patch.object(self.swarm.log, "error") as log_error,
        ):
            result = self.swarm.run_once(dry_run=True)

        self.assertEqual(result, 1)
        log_error.assert_called_once_with(
            "Single polling cycle failed: %s",
            ANY,
        )

    def test_once_unexpected_failure_keeps_debug_traceback(self):
        with (
            patch.object(self.swarm, "sync_main_branch"),
            patch.object(
                self.swarm,
                "process_polling_cycle",
                side_effect=RuntimeError("unexpected bug"),
            ),
            patch.object(self.swarm.log, "error") as log_error,
        ):
            result = self.swarm.run_once(dry_run=True)

        self.assertEqual(result, 1)
        log_error.assert_called_once_with(
            "Single polling cycle failed: %s",
            ANY,
            exc_info=True,
        )

    def test_once_interrupt_returns_sigint_status(self):
        with (
            patch.object(self.swarm, "sync_main_branch", side_effect=KeyboardInterrupt),
            patch.object(self.swarm.tracker, "kill_all") as kill_all,
        ):
            result = self.swarm.run_once(dry_run=True)

        self.assertEqual(result, 130)
        kill_all.assert_not_called()

    def test_once_interrupt_kills_children_for_real_run(self):
        with (
            patch.object(self.swarm, "sync_main_branch", side_effect=KeyboardInterrupt),
            patch.object(self.swarm.tracker, "kill_all") as kill_all,
        ):
            result = self.swarm.run_once(dry_run=False)

        self.assertEqual(result, 130)
        kill_all.assert_called_once_with()

    def test_status_logs_the_resolved_repository_root(self):
        with (
            patch.object(self.swarm.sys, "argv", ["swarm_orchestrator.py", "--status"]),
            patch.object(self.swarm.log, "info") as log_info,
            patch.object(self.swarm, "assert_repo_workflow_writable") as preflight,
            patch.object(self.swarm, "enable_runtime_writes") as enable_runtime_writes,
            patch("builtins.print"),
        ):
            result = self.swarm.main()

        self.assertEqual(result, 0)
        log_info.assert_called_once_with("Repo root: %s", self.swarm.REPO_ROOT)
        preflight.assert_not_called()
        enable_runtime_writes.assert_not_called()

    def test_dry_run_skips_write_preflight_and_runtime_writes(self):
        with (
            patch.object(
                self.swarm.sys,
                "argv",
                ["swarm_orchestrator.py", "--dry-run", "--once"],
            ),
            patch.object(
                self.swarm,
                "_resolve_origin_repository",
                return_value=self.swarm.GitHubRepoTarget("github.com", "acme", "widgets"),
            ) as resolve_origin,
            patch.object(self.swarm, "assert_repo_workflow_writable") as preflight,
            patch.object(self.swarm, "enable_runtime_writes") as enable_runtime_writes,
            patch.object(self.swarm, "run_once", return_value=0) as run_once,
        ):
            result = self.swarm.main()

        self.assertEqual(result, 0)
        preflight.assert_not_called()
        enable_runtime_writes.assert_not_called()
        run_once.assert_called_once_with(True)
        resolve_origin.assert_called_once_with(verify_transport=False)
        self.assertEqual(
            self.swarm._ACTIVE_GH_REPO_CONTEXT,
            "github.com/acme/widgets",
        )

    def test_dry_run_allows_custom_ssh_transport_while_binding_origin(self):
        ssh_config = subprocess.CompletedProcess(
            ["ssh", "-G", "--", "github.com"],
            0,
            "user git\nhostname github.com\nport 22\n",
            "",
        )
        with (
            patch.dict(os.environ, {"GIT_SSH_COMMAND": "ssh -i deploy-key"}, clear=False),
            patch.object(
                self.swarm.sys,
                "argv",
                ["swarm_orchestrator.py", "--dry-run", "--once"],
            ),
            patch.object(
                self.swarm,
                "_read_origin_urls",
                side_effect=[
                    ["git@github.com:acme/widgets.git"],
                    ["git@github.com:acme/widgets.git"],
                ],
            ),
            patch.object(self.swarm.subprocess, "run", return_value=ssh_config),
            patch.object(self.swarm, "run_once", return_value=0) as run_once,
        ):
            result = self.swarm.main()

        self.assertEqual(result, 0)
        run_once.assert_called_once_with(True)
        self.assertEqual(
            self.swarm._ACTIVE_GH_REPO_CONTEXT,
            "github.com/acme/widgets",
        )

    def test_dry_run_reports_transient_origin_resolution_failure(self):
        with (
            patch.object(
                self.swarm.sys,
                "argv",
                ["swarm_orchestrator.py", "--dry-run", "--once"],
            ),
            patch.object(
                self.swarm,
                "_bind_origin_repository",
                side_effect=self.swarm.SwarmPreflightTransientError("try later"),
            ),
            patch.object(self.swarm, "run_once") as run_once,
            patch.object(self.swarm.log, "error") as log_error,
        ):
            result = self.swarm.main()

        self.assertEqual(result, 1)
        run_once.assert_not_called()
        self.assertIn("transient", repr(log_error.mock_calls).lower())

    def test_real_dry_run_cycle_performs_reads_without_mutating(self):
        calls = []

        def fake_gh(args, check=True):
            calls.append((args, check))
            if args[:4] == ["issue", "list", "--state", "open"]:
                return "[]"
            if args[:4] == ["pr", "list", "--state", "open"]:
                return "[]"
            if args[:4] == ["pr", "list", "--state", "merged"]:
                return json.dumps([{
                    "number": 7,
                    "title": "[PR] 1 - merged task",
                    "headRefName": "worker/1-task",
                }])
            if args[:3] == ["issue", "view", "1"]:
                return json.dumps({"state": "OPEN"})
            raise AssertionError(f"Unexpected gh call: {args}")

        with (
            patch.object(self.swarm, "gh", side_effect=fake_gh),
            patch.object(self.swarm, "create_worktree") as create_worktree,
            patch.object(self.swarm, "cleanup_worktree") as cleanup_worktree,
            patch.object(self.swarm.subprocess, "Popen") as popen,
        ):
            result = self.swarm.run_once(dry_run=True)

        self.assertEqual(result, 0)
        self.assertTrue(calls)
        self.assertFalse(any(args[:2] == ["issue", "close"] for args, _ in calls))
        create_worktree.assert_not_called()
        cleanup_worktree.assert_not_called()
        popen.assert_not_called()

    def test_real_once_stops_before_any_runtime_write_when_preflight_denies(self):
        response = gh_api_response(
            {
                "full_name": "acme/widgets",
                "archived": False,
                "disabled": False,
                "has_issues": True,
                "private": False,
                "permissions": {"push": False},
            },
            headers={"X-OAuth-Scopes": "repo"},
        )
        probe = subprocess.CompletedProcess(["gh", "api"], 0, response, "")
        with (
            patch.object(self.swarm.sys, "argv", ["swarm_orchestrator.py", "--once"]),
            patch.object(
                self.swarm,
                "_resolve_origin_repository",
                return_value=self.swarm.GitHubRepoTarget("github.com", "acme", "widgets"),
            ),
            patch.object(self.swarm, "_run_gh", return_value=probe) as run_gh,
            patch.object(self.swarm, "enable_runtime_writes") as enable_runtime_writes,
            patch.object(self.swarm, "reset_process_history") as reset_process_history,
            patch.object(self.swarm, "run_once") as run_once,
            patch.object(self.swarm, "run_loop") as run_loop,
            patch.object(self.swarm, "create_worktree") as create_worktree,
            patch.object(self.swarm, "close_issue_if_open") as close_issue,
            patch.object(self.swarm, "cleanup_worktree") as cleanup_worktree,
            patch.object(self.swarm.subprocess, "Popen") as popen,
            patch.object(self.swarm.log, "error") as log_error,
        ):
            result = self.swarm.main()

        self.assertEqual(result, 1)
        run_gh.assert_called_once()
        for blocked in (
            enable_runtime_writes,
            reset_process_history,
            run_once,
            run_loop,
            create_worktree,
            close_issue,
            cleanup_worktree,
            popen,
        ):
            blocked.assert_not_called()
        rendered = repr(log_error.mock_calls)
        self.assertIn("acme/widgets", rendered)
        self.assertIn("permissions.push", rendered)
        self.assertIn("Issues, Contents and Pull requests write access", rendered)

    def test_real_once_enters_runtime_after_successful_preflight(self):
        response = gh_api_response(
            {
                "full_name": "acme/widgets",
                "archived": False,
                "disabled": False,
                "has_issues": True,
                "private": False,
                "permissions": {"push": True},
            },
            headers={"X-OAuth-Scopes": "repo"},
        )
        probe = subprocess.CompletedProcess(["gh", "api"], 0, response, "")

        def run_once_after_binding(dry_run):
            self.assertFalse(dry_run)
            self.assertEqual(
                self.swarm._ACTIVE_GH_REPO_CONTEXT,
                "github.com/acme/widgets",
            )
            self.assertIsNotNone(self.swarm._ACTIVE_REPO_TARGET)
            return 0

        with (
            patch.object(self.swarm.sys, "argv", ["swarm_orchestrator.py", "--once"]),
            patch.object(
                self.swarm,
                "_resolve_origin_repository",
                return_value=self.swarm.GitHubRepoTarget(
                    "github.com",
                    "acme",
                    "widgets",
                    http_endpoint=self.swarm.HttpEndpoint("https", "github.com", 443),
                ),
            ),
            patch.object(self.swarm, "_run_gh", return_value=probe) as run_gh,
            patch.object(self.swarm, "enable_runtime_writes") as enable_runtime_writes,
            patch.object(self.swarm, "cleanup_old_task_logs") as cleanup_old_task_logs,
            patch.object(
                self.swarm,
                "run_once",
                side_effect=run_once_after_binding,
            ) as run_once,
        ):
            result = self.swarm.main()

        self.assertEqual(result, 0)
        run_gh.assert_called_once()
        enable_runtime_writes.assert_called_once_with()
        cleanup_old_task_logs.assert_called_once_with()
        run_once.assert_called_once_with(False)

    def test_explicit_reset_runs_before_a_failed_preflight(self):
        capability = self.swarm.RepoWorkflowCapability(
            "acme/widgets",
            False,
            ("no-push-permission",),
            (),
        )
        with (
            patch.object(
                self.swarm.sys,
                "argv",
                ["swarm_orchestrator.py", "--once", "--reset"],
            ),
            patch.object(self.swarm, "reset_process_history") as reset_process_history,
            patch.object(
                self.swarm,
                "assert_repo_workflow_writable",
                side_effect=self.swarm.SwarmCapabilityError(capability),
            ),
            patch.object(self.swarm, "enable_runtime_writes") as enable_runtime_writes,
            patch.object(self.swarm, "run_once") as run_once,
            patch.object(self.swarm.log, "error"),
        ):
            result = self.swarm.main()

        self.assertEqual(result, 1)
        reset_process_history.assert_called_once_with()
        enable_runtime_writes.assert_not_called()
        run_once.assert_not_called()

    def test_preflight_uses_one_read_only_gh_api_probe(self):
        response = gh_api_response(
            {
                "full_name": "acme/widgets",
                "archived": False,
                "disabled": False,
                "has_issues": True,
                "private": False,
                "permissions": {"push": False},
            },
            headers={"X-OAuth-Scopes": "repo"},
        )
        result = subprocess.CompletedProcess(["gh", "api"], 0, response, "")
        with patch.object(self.swarm, "_run_gh", return_value=result) as run_gh:
            capability = self.swarm.check_repo_workflow_capability()

        run_gh.assert_called_once()
        args = run_gh.call_args.args[0]
        self.assertEqual(run_gh.call_args.kwargs["repo_context"], "github.com/acme/widgets")
        self.assertEqual(args.count("--method"), 1)
        self.assertEqual(args[args.index("--method") + 1], "GET")
        self.assertIn("repos/{owner}/{repo}", args)
        self.assertNotIn("-f", args)
        self.assertNotIn("-F", args)
        self.assertEqual(capability.repository, "acme/widgets")
        self.assertEqual(capability.gaps, ("no-push-permission",))
        self.assertEqual(capability.unverified, ())
        self.assertIsNone(self.swarm._ACTIVE_GH_REPO_CONTEXT)

    def test_preflight_pins_repo_context_to_origin(self):
        response = gh_api_response(
            {
                "full_name": "acme/widgets",
                "archived": False,
                "disabled": False,
                "has_issues": True,
                "private": False,
                "permissions": {"push": True},
            },
            headers={"X-OAuth-Scopes": "repo"},
        )
        result = subprocess.CompletedProcess(["gh", "api"], 0, response, "")
        with (
            patch.dict(os.environ, {"GH_REPO": "other/writable"}),
            patch.object(self.swarm, "_run_gh", return_value=result) as run_gh,
        ):
            capability = self.swarm.check_repo_workflow_capability()

        self.assertTrue(capability.ok)
        self.assertEqual(
            run_gh.call_args.kwargs["repo_context"],
            "github.com/acme/widgets",
        )
        self.assertEqual(
            self.swarm._ACTIVE_GH_REPO_CONTEXT,
            "github.com/acme/widgets",
        )

    def test_origin_resolution_accepts_trailing_slash_after_dot_git(self):
        target = self.swarm._parse_github_remote(
            "https://github.com/acme/widgets.git/",
        )

        self.assertEqual(target, self.swarm.GitHubRepoTarget("github.com", "acme", "widgets"))
        self.assertEqual(
            target.http_endpoint,
            self.swarm.HttpEndpoint("https", "github.com", 443),
        )

    def test_origin_resolution_accepts_explicit_default_https_port(self):
        target = self.swarm._parse_github_remote(
            "https://github.com:443/acme/widgets.git",
        )

        self.assertEqual(target.host, "github.com")
        self.assertEqual(
            target.http_endpoint,
            self.swarm.HttpEndpoint("https", "github.com", 443),
        )

    def test_origin_resolution_rejects_unbound_http_authority(self):
        sentinel = "credential-bearing-query"
        authorities = (
            ("http://github.example/acme/widgets.git", "HTTP origin"),
            ("https://github.example:8443/acme/widgets.git", "non-default HTTPS"),
        )
        for remote, expected_reason in authorities:
            with self.subTest(remote=remote):
                with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                    self.swarm._parse_github_remote(remote)
                self.assertIn(expected_reason, str(raised.exception))
                self.assertNotIn(sentinel, str(raised.exception))

        with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
            self.swarm._parse_github_remote(
                f"https://github.example/acme/widgets.git?{sentinel}",
            )
        self.assertIn("not a supported GitHub repository URL", str(raised.exception))
        self.assertNotIn(sentinel, str(raised.exception))

    def test_origin_resolution_uses_every_fetch_and_push_url(self):
        fetch = subprocess.CompletedProcess(
            ["git", "remote", "get-url", "--all", "origin"],
            0,
            "https://github.com/acme/widgets.git\n",
            "",
        )
        push = subprocess.CompletedProcess(
            ["git", "remote", "get-url", "--all", "--push", "origin"],
            0,
            "git@github.com:acme/widgets.git\n",
            "",
        )
        core_config_absent = subprocess.CompletedProcess(
            ["git", "config", "--get", "core.sshCommand"],
            1,
            "",
            "",
        )
        ssh_config = subprocess.CompletedProcess(
            ["ssh", "-G", "--", "github.com"],
            0,
            "user git\nhostname github.com\nport 22\n",
            "",
        )
        with patch.object(
            self.swarm.subprocess,
            "run",
            side_effect=[fetch, push, core_config_absent, ssh_config],
        ) as run:
            target = self.swarm._resolve_origin_repository()

        self.assertEqual(target, self.swarm.GitHubRepoTarget("github.com", "acme", "widgets"))
        self.assertEqual(
            target.http_endpoint,
            self.swarm.HttpEndpoint("https", "github.com", 443),
        )
        self.assertEqual(
            target.ssh_endpoint,
            self.swarm.SshEndpoint("github.com", "git", 22),
        )
        self.assertEqual(
            run.call_args_list[0].args[0],
            ["git", "remote", "get-url", "--all", "origin"],
        )
        self.assertEqual(
            run.call_args_list[1].args[0],
            ["git", "remote", "get-url", "--all", "--push", "origin"],
        )

    def test_origin_resolution_resolves_ssh_alias_and_github_ssh_host(self):
        alias_result = subprocess.CompletedProcess(
            ["ssh", "-G", "--", "github.com-work"],
            0,
            "user git\nhostname github.com\nport 22\n",
            "",
        )
        ssh_github_result = subprocess.CompletedProcess(
            ["ssh", "-G", "--", "ssh.github.com"],
            0,
            "user git\nhostname ssh.github.com\nport 443\n",
            "",
        )
        with (
            patch.object(self.swarm, "_assert_standard_git_ssh_context"),
            patch.object(
                self.swarm.subprocess,
                "run",
                side_effect=[alias_result, ssh_github_result],
            ) as run,
        ):
            alias = self.swarm._parse_github_remote(
                "git@github.com-work:acme/widgets.git",
            )
            ssh_over_443 = self.swarm._parse_github_remote(
                "ssh://git@ssh.github.com:443/acme/widgets.git",
            )

        expected = self.swarm.GitHubRepoTarget("github.com", "acme", "widgets")
        self.assertEqual(alias, expected)
        self.assertEqual(ssh_over_443, expected)
        self.assertEqual(
            alias.ssh_endpoint,
            self.swarm.SshEndpoint("github.com", "git", 22),
        )
        self.assertEqual(alias.ssh_endpoint, ssh_over_443.ssh_endpoint)
        self.assertEqual(
            run.call_args_list[0].args[0],
            ["ssh", "-G", "-l", "git", "--", "github.com-work"],
        )
        self.assertEqual(
            run.call_args_list[1].args[0],
            ["ssh", "-G", "-l", "git", "-p", "443", "--", "ssh.github.com"],
        )

    def test_ssh_alias_cache_distinguishes_user_and_port(self):
        git_result = subprocess.CompletedProcess(
            ["ssh", "-G"],
            0,
            "user git\nhostname github.com\nport 22\n",
            "",
        )
        deploy_result = subprocess.CompletedProcess(
            ["ssh", "-G"],
            0,
            "user deploy\nhostname github.com\nport 443\n",
            "",
        )
        cache = {}
        with (
            patch.object(self.swarm, "_assert_standard_git_ssh_context"),
            patch.object(
                self.swarm.subprocess,
                "run",
                side_effect=[git_result, deploy_result],
            ) as run,
        ):
            self.swarm._parse_github_remote(
                "ssh://git@github.com-work:22/acme/widgets.git",
                cache,
            )
            self.swarm._parse_github_remote(
                "ssh://deploy@github.com-work:443/acme/widgets.git",
                cache,
            )

        self.assertEqual(run.call_count, 2)
        self.assertEqual(len(cache), 2)

    def test_origin_resolution_rejects_different_effective_ssh_ports(self):
        fetch_endpoint = subprocess.CompletedProcess(
            ["ssh", "-G"],
            0,
            "user git\nhostname github.example\nport 22\n",
            "",
        )
        push_endpoint = subprocess.CompletedProcess(
            ["ssh", "-G"],
            0,
            "user git\nhostname github.example\nport 2222\n",
            "",
        )
        with (
            patch.object(
                self.swarm,
                "_read_origin_urls",
                side_effect=[
                    ["ssh://git@github.example:22/acme/widgets.git"],
                    ["ssh://git@github.example:2222/acme/widgets.git"],
                ],
            ),
            patch.object(self.swarm, "_assert_standard_git_ssh_context"),
            patch.object(
                self.swarm.subprocess,
                "run",
                side_effect=[fetch_endpoint, push_endpoint],
            ),
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._resolve_origin_repository()

        self.assertIn("host, user, and port", str(raised.exception))

    def test_origin_resolution_rejects_custom_git_ssh_environment(self):
        sentinel = "credential-bearing-config"
        with patch.dict(
            os.environ,
            {"GIT_SSH_COMMAND": f"ssh -F {sentinel}"},
            clear=False,
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._parse_github_remote(
                    "git@github.com-work:acme/widgets.git",
                )

        self.assertIn("GIT_SSH_COMMAND or GIT_SSH", str(raised.exception))
        self.assertNotIn(sentinel, str(raised.exception))

    def test_origin_resolution_rejects_core_ssh_command(self):
        sentinel = "credential-bearing-config"
        configured = subprocess.CompletedProcess(
            ["git", "config", "--get", "core.sshCommand"],
            0,
            f"ssh -F {sentinel}\n",
            "",
        )
        with patch.object(self.swarm.subprocess, "run", return_value=configured):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._parse_github_remote(
                    "git@github.com-work:acme/widgets.git",
                )

        self.assertIn("core.sshCommand", str(raised.exception))
        self.assertNotIn(sentinel, str(raised.exception))

    def test_ssh_resolution_timeout_is_transient(self):
        with (
            patch.object(self.swarm, "_assert_standard_git_ssh_context"),
            patch.object(
                self.swarm.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(
                    ["ssh", "-G"],
                    self.swarm.GH_TIMEOUT_SECONDS,
                ),
            ),
        ):
            with self.assertRaises(self.swarm.SwarmPreflightTransientError):
                self.swarm._resolve_ssh_endpoint("github.com")

    def test_worktree_push_target_rejects_non_origin_default_without_leak(self):
        self._bind_test_target()
        sentinel = "credential-bearing-remote"
        with (
            patch.object(
                self.swarm,
                "_resolve_origin_repository",
                return_value=self.swarm.GitHubRepoTarget(
                    "github.com",
                    "acme",
                    "widgets",
                    http_endpoint=self.swarm.HttpEndpoint("https", "github.com", 443),
                ),
            ),
            patch.object(
                self.swarm,
                "_read_git_config_values",
                side_effect=[(sentinel,), (), ("origin",)],
            ),
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._assert_worktree_push_target(
                    self.repo,
                    "worker/1-test",
                )

        self.assertIn("other than origin", str(raised.exception))
        self.assertNotIn(sentinel, str(raised.exception))

    def test_worktree_push_target_rejects_branch_scoped_origin_drift(self):
        self._bind_test_target()
        with (
            patch.object(
                self.swarm,
                "_resolve_origin_repository",
                return_value=self.swarm.GitHubRepoTarget(
                    "github.com",
                    "other",
                    "writable",
                ),
            ),
            patch.object(self.swarm, "_read_git_config_values") as read_config,
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._assert_worktree_push_target(
                    self.repo,
                    "worker/1-test",
                )

        self.assertIn("differs", str(raised.exception))
        self.assertNotIn("other/writable", str(raised.exception))
        read_config.assert_not_called()

    def test_worktree_push_target_rejects_ssh_endpoint_drift(self):
        self.swarm._ACTIVE_REPO_TARGET = self.swarm.GitHubRepoTarget(
            "github.example",
            "acme",
            "widgets",
            ssh_endpoint=self.swarm.SshEndpoint("github.example", "git", 22),
        )
        worktree_target = self.swarm.GitHubRepoTarget(
            "github.example",
            "acme",
            "widgets",
            ssh_endpoint=self.swarm.SshEndpoint("github.example", "git", 2222),
        )
        with (
            patch.object(
                self.swarm,
                "_resolve_origin_repository",
                return_value=worktree_target,
            ),
            patch.object(self.swarm, "_read_git_config_values") as read_config,
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._assert_worktree_push_target(
                    self.repo,
                    "worker/1-test",
                )

        self.assertIn("transport endpoint", str(raised.exception))
        read_config.assert_not_called()

    def test_origin_resolution_rejects_divergent_push_repository(self):
        with patch.object(
            self.swarm,
            "_read_origin_urls",
            side_effect=[
                ["https://github.com/acme/widgets.git"],
                ["https://github.com/other/writable.git"],
            ],
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._resolve_origin_repository()

        self.assertIn("fetch and push URLs", str(raised.exception))
        self.assertNotIn("other/writable", str(raised.exception))

    def test_origin_resolution_reports_missing_git_as_configuration_error(self):
        with patch.object(
            self.swarm.subprocess,
            "run",
            side_effect=FileNotFoundError,
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._resolve_origin_repository()

        self.assertIn("git is required", str(raised.exception))

    def test_origin_resolution_hides_local_process_failure_details(self):
        sentinel = "credential-bearing-origin-url"
        with patch.object(
            self.swarm.subprocess,
            "run",
            side_effect=OSError(5, sentinel),
        ):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._resolve_origin_repository()

        self.assertNotIn(sentinel, str(raised.exception))
        self.assertIn("Git installation", str(raised.exception))

    def test_origin_resolution_hides_malformed_remote_details(self):
        sentinel = "credential-bearing-origin-url"
        result = subprocess.CompletedProcess(
            ["git", "remote", "get-url", "origin"],
            0,
            f"https://user:{sentinel}@exam℀ple.com/acme/widgets.git\n",
            "",
        )
        with patch.object(self.swarm.subprocess, "run", return_value=result):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm._resolve_origin_repository()

        self.assertNotIn(sentinel, str(raised.exception))
        self.assertIn("not a supported GitHub repository URL", str(raised.exception))

    def test_main_hides_malformed_origin_details(self):
        sentinel = "credential-bearing-origin-url"
        result = subprocess.CompletedProcess(
            ["git", "remote", "get-url", "origin"],
            0,
            f"https://user:{sentinel}@exam℀ple.com/acme/widgets.git\n",
            "",
        )
        with (
            patch.object(self.swarm.sys, "argv", ["swarm_orchestrator.py", "--once"]),
            patch.object(self.swarm.subprocess, "run", return_value=result),
            patch.object(self.swarm.log, "error") as log_error,
        ):
            exit_code = self.swarm.main()

        self.assertEqual(exit_code, 1)
        rendered = repr(log_error.mock_calls)
        self.assertNotIn(sentinel, rendered)
        self.assertIn("not a supported GitHub repository URL", rendered)

    def test_preflight_rejects_repo_context_identity_mismatch(self):
        response = gh_api_response(
            {
                "full_name": "other/writable",
                "archived": False,
                "disabled": False,
                "has_issues": True,
                "private": False,
                "permissions": {"push": True},
            },
            headers={"X-OAuth-Scopes": "repo"},
        )
        result = subprocess.CompletedProcess(["gh", "api"], 0, response, "")
        with patch.object(self.swarm, "_run_gh", return_value=result):
            with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
                self.swarm.check_repo_workflow_capability()

        self.assertIn("acme/widgets", str(raised.exception))
        self.assertIn("other/writable", str(raised.exception))

    def test_run_gh_applies_timeout_and_overrides_inherited_repo_context(self):
        result = subprocess.CompletedProcess(["gh", "api"], 0, "{}", "")
        with (
            patch.dict(
                os.environ,
                {"GH_HOST": "other.example", "GH_REPO": "other/writable"},
            ),
            patch.object(self.swarm.subprocess, "run", return_value=result) as run,
        ):
            self.swarm._run_gh(
                ["api", "user"],
                repo_context="github.com/acme/widgets",
            )

        invocation = run.call_args.kwargs
        self.assertEqual(invocation["timeout"], self.swarm.GH_TIMEOUT_SECONDS)
        self.assertEqual(invocation["env"]["GH_REPO"], "github.com/acme/widgets")
        self.assertEqual(invocation["env"]["GH_HOST"], "github.com")

    def test_gh_environment_fails_closed_before_origin_binding(self):
        self.swarm._ACTIVE_GH_REPO_CONTEXT = None

        with self.assertRaises(self.swarm.SwarmPreflightConfigError) as raised:
            self.swarm._bound_gh_environment()

        self.assertIn("not bound", str(raised.exception))

    def test_gh_check_false_soft_fails_before_origin_binding(self):
        self.swarm._ACTIVE_GH_REPO_CONTEXT = None

        self.assertEqual(self.swarm.gh(["pr", "view", "1"], check=False), "")
        with self.assertRaises(self.swarm.SwarmPreflightConfigError):
            self.swarm.gh(["pr", "view", "1"])

    def test_dispatched_agent_inherits_preflight_repo_context(self):
        issue = self.swarm.TaskIssue(
            number=99,
            title="[Task] bound context",
            body="No writes in this unit test",
            worker=self.swarm.RoleAssignment("codex", "5.6", "high"),
        )
        stdout_file = MagicMock()
        stderr_file = MagicMock()
        self.swarm._ACTIVE_GH_REPO_CONTEXT = "github.com/acme/widgets"
        with (
            patch.object(self.swarm, "create_worktree", return_value=self.repo),
            patch.object(self.swarm, "write_prompt_file", return_value=self.repo / "prompt.md"),
            patch.object(
                self.swarm,
                "build_ai_argv",
                return_value=(["codex", "exec"], False),
            ),
            patch.object(
                self.swarm,
                "create_log_files",
                return_value=(self.repo / "worker.log", stdout_file, stderr_file),
            ),
            patch.object(self.swarm.subprocess, "Popen", return_value=MagicMock()) as popen,
            patch.object(self.swarm.tracker, "register"),
        ):
            self.swarm.dispatch_worker(issue, dry_run=False)

        self.assertEqual(
            popen.call_args.kwargs["env"]["GH_REPO"],
            "github.com/acme/widgets",
        )
        self.assertEqual(popen.call_args.kwargs["env"]["GH_HOST"], "github.com")

    def test_capability_accumulates_repository_and_scope_gaps(self):
        capability = self.swarm._evaluate_repo_workflow_capability(
            "acme/widgets",
            {
                "archived": True,
                "disabled": True,
                "has_issues": False,
                "private": True,
                "permissions": {},
            },
            "read:org, gist",
        )

        self.assertEqual(
            capability.gaps,
            (
                "archived",
                "disabled",
                "issues-disabled",
                "permissions-unknown",
                "oauth-scope-missing",
            ),
        )
        self.assertEqual(capability.unverified, ())

    def test_every_capability_gap_has_an_explicit_reason_and_remedy(self):
        reason_gaps = set(self.swarm._CAPABILITY_GAP_REASONS)
        remedy_gaps = set(self.swarm._CAPABILITY_GAP_REMEDIES)
        remedy_kinds = set(self.swarm._CAPABILITY_GAP_REMEDIES.values())

        self.assertEqual(reason_gaps, remedy_gaps)
        self.assertEqual(remedy_kinds, set(self.swarm._CAPABILITY_REMEDY_RANK))
        self.assertEqual(
            set(self.swarm._CAPABILITY_REMEDY_RANK),
            set(self.swarm._CAPABILITY_REMEDY_TEXT),
        )

    def test_gh_include_parser_handles_mixed_line_endings(self):
        raw = gh_api_response(
            {"full_name": "acme/widgets"},
            headers={"X-OAuth-Scopes": "repo"},
        )

        status, headers, body = self.swarm._parse_gh_api_response(raw)

        self.assertIn("\nX-OAuth-Scopes: repo\r\n\r\n", raw)
        self.assertEqual(status, 200)
        self.assertEqual(headers["x-oauth-scopes"], "repo")
        self.assertEqual(body["full_name"], "acme/widgets")

    def test_preflight_reports_unauthenticated_gh_with_actionable_remedy(self):
        result = subprocess.CompletedProcess(
            ["gh", "api"],
            4,
            "",
            "authentication required; run gh auth login",
        )
        with patch.object(self.swarm, "_run_gh", return_value=result):
            capability = self.swarm.check_repo_workflow_capability()

        self.assertEqual(capability.gaps, ("gh-not-authenticated",))
        message = self.swarm.describe_repo_workflow_capability(capability)
        self.assertIn("acme/widgets", message)
        self.assertIn("gh auth login", message)

    def test_preflight_recognizes_bad_credentials_from_gh_stderr(self):
        result = subprocess.CompletedProcess(
            ["gh", "api"],
            1,
            "",
            "gh: Bad credentials (HTTP 401)",
        )
        with patch.object(self.swarm, "_run_gh", return_value=result):
            capability = self.swarm.check_repo_workflow_capability()

        self.assertEqual(capability.gaps, ("bad-credentials",))
        self.assertIn(
            "gh auth login",
            self.swarm.describe_repo_workflow_capability(capability),
        )

    def test_preflight_classifies_timeout_as_transient(self):
        with patch.object(
            self.swarm,
            "_run_gh",
            side_effect=subprocess.TimeoutExpired(["gh api"], self.swarm.GH_TIMEOUT_SECONDS),
        ):
            with self.assertRaises(self.swarm.SwarmPreflightTransientError) as raised:
                self.swarm.check_repo_workflow_capability()

        self.assertIn("acme/widgets", str(raised.exception))
        self.assertIn("timed out", str(raised.exception))
        self.assertNotIn("missing permission", str(raised.exception))

    def test_preflight_failure_path_never_logs_raw_diagnostics(self):
        sentinel = "TOP-SECRET-PREFLIGHT"
        credential_url = "https://x-access-token:credential-secret@github.com/acme/widgets.git"
        response = gh_api_response(
            {"message": f"Forbidden {sentinel} {credential_url}"},
            status=403,
        )
        result = subprocess.CompletedProcess(
            ["gh", "api"],
            1,
            response,
            f"diagnostic {sentinel} {credential_url}",
        )
        with (
            patch.object(self.swarm.sys, "argv", ["swarm_orchestrator.py", "--once"]),
            patch.object(self.swarm, "_run_gh", return_value=result),
            patch.object(self.swarm, "enable_runtime_writes") as enable_runtime_writes,
            patch.object(self.swarm, "run_once") as run_once,
            patch.object(self.swarm.log, "error") as log_error,
        ):
            exit_code = self.swarm.main()

        self.assertEqual(exit_code, 1)
        enable_runtime_writes.assert_not_called()
        run_once.assert_not_called()
        observed = repr(log_error.mock_calls)
        self.assertNotIn(sentinel, observed)
        self.assertNotIn("credential-secret", observed)

    def test_git_sync_failure_never_logs_remote_diagnostics(self):
        sentinel = "TOP-SECRET-GIT-DIAGNOSTIC"
        result = subprocess.CompletedProcess(
            ["git", "fetch"],
            1,
            "",
            f"failed {sentinel} https://token@host.example/path",
        )
        with (
            patch.object(self.swarm.subprocess, "run", return_value=result),
            patch.object(self.swarm, "log_blocker") as log_blocker,
        ):
            self.swarm.sync_main_branch(dry_run=False)

        observed = repr(log_blocker.mock_calls)
        self.assertNotIn(sentinel, observed)
        self.assertNotIn("token@", observed)

    def test_preflight_classifies_rate_limit_before_permission(self):
        response = gh_api_response(
            {"message": "API rate limit exceeded"},
            status=403,
            headers={"X-RateLimit-Remaining": "0"},
        )
        result = subprocess.CompletedProcess(["gh", "api"], 1, response, "")
        with patch.object(self.swarm, "_run_gh", return_value=result):
            with self.assertRaises(self.swarm.SwarmPreflightTransientError) as raised:
                self.swarm.check_repo_workflow_capability()

        self.assertIn("rate limit", str(raised.exception))
        self.assertNotIn("missing permission", str(raised.exception))

    def test_preflight_prefers_sso_status_over_generic_auth_hint(self):
        response = gh_api_response(
            {"message": "authentication required; run gh auth login"},
            status=403,
            headers={"X-GitHub-SSO": "required"},
        )
        result = subprocess.CompletedProcess(["gh", "api"], 1, response, "")
        with patch.object(self.swarm, "_run_gh", return_value=result):
            capability = self.swarm.check_repo_workflow_capability()

        self.assertEqual(capability.gaps, ("sso-authorization-required",))
        self.assertNotIn("gh auth login", self.swarm.describe_repo_workflow_capability(capability))

    def test_preflight_keeps_unknown_forbidden_auth_hint_transient(self):
        response = gh_api_response(
            {"message": "authentication required; run gh auth login"},
            status=403,
        )
        result = subprocess.CompletedProcess(["gh", "api"], 1, response, "")
        with patch.object(self.swarm, "_run_gh", return_value=result):
            with self.assertRaises(self.swarm.SwarmPreflightTransientError) as raised:
                self.swarm.check_repo_workflow_capability()

        self.assertIn("inconclusive", str(raised.exception))

    def test_preflight_leaves_unknown_forbidden_response_transient(self):
        response = gh_api_response(
            {"message": "Forbidden for an indeterminate reason"},
            status=403,
        )
        result = subprocess.CompletedProcess(["gh", "api"], 1, response, "")
        with patch.object(self.swarm, "_run_gh", return_value=result):
            with self.assertRaises(self.swarm.SwarmPreflightTransientError) as raised:
                self.swarm.check_repo_workflow_capability()

        self.assertIn("inconclusive", str(raised.exception))
        self.assertNotIn("missing permission", str(raised.exception))

    def test_unknown_credential_grants_are_warned_not_claimed(self):
        response = gh_api_response({
            "full_name": "acme/widgets",
            "archived": False,
            "disabled": False,
            "has_issues": True,
            "private": False,
            "permissions": {"push": True},
        })
        result = subprocess.CompletedProcess(["gh", "api"], 0, response, "")
        with (
            patch.object(self.swarm, "_run_gh", return_value=result),
            patch.object(self.swarm.log, "warning") as warning,
        ):
            capability = self.swarm.assert_repo_workflow_writable()

        self.assertEqual(capability.unverified, self.swarm._PIPELINE_GRANTS)
        rendered = repr(warning.mock_calls)
        self.assertIn("Issues: write", rendered)
        self.assertIn("unverified", rendered)

    def test_gh_failure_does_not_expose_raw_command_or_output(self):
        sentinel = "TOP-SECRET-SENTINEL"
        credential_url = "https://x-access-token:credential-secret@github.com/acme/widgets.git"
        self.swarm._ACTIVE_GH_REPO_CONTEXT = "github.com/acme/widgets"
        raw_result = subprocess.CompletedProcess(
            ["gh", "api", sentinel],
            1,
            sentinel,
            f"failed to read {credential_url}",
        )
        with (
            patch.object(self.swarm.subprocess, "run", return_value=raw_result),
            patch.object(self.swarm.log, "debug") as log_debug,
            patch.object(self.swarm.log, "error") as log_error,
        ):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                self.swarm.gh(["api", sentinel])

        observed = "\n".join([
            repr(log_debug.mock_calls),
            repr(log_error.mock_calls),
            str(raised.exception),
            repr(raised.exception.cmd),
            repr(raised.exception.output),
            repr(raised.exception.stderr),
        ])
        self.assertNotIn(sentinel, observed)
        self.assertNotIn("credential-secret", observed)
        self.assertNotIn("x-access-token", observed)

    def test_gh_failure_logs_only_fixed_actionable_hint(self):
        sentinel = "TOP-SECRET-GH-DIAGNOSTIC"
        self.swarm._ACTIVE_GH_REPO_CONTEXT = "github.com/acme/widgets"
        raw_result = subprocess.CompletedProcess(
            ["gh", "pr", "list"],
            1,
            "",
            f"Resource not accessible by integration: {sentinel}",
        )
        with (
            patch.object(self.swarm.subprocess, "run", return_value=raw_result),
            patch.object(self.swarm.log, "error") as log_error,
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                self.swarm.gh(["pr", "list"])

        observed = repr(log_error.mock_calls)
        self.assertIn("verify the active credential", observed)
        self.assertNotIn(sentinel, observed)

    def test_blocks_a_branch_checked_out_at_another_path(self):
        self._bind_test_target()
        other = self.repo / "other-worktree"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", "worker/2-test", str(other)],
            check=True,
            capture_output=True,
        )
        with self.assertRaisesRegex(RuntimeError, "already checked out"):
            self.swarm.create_worktree(2, "worker/2-test")

    def test_preserves_files_in_a_damaged_worktree(self):
        self._bind_test_target()
        worktree = self.swarm.create_worktree(3, "worker/3-test")
        (worktree / ".git").unlink()
        marker = worktree / "keep-me.txt"
        marker.write_text("important\n")

        self.swarm.cleanup_worktree(3, "worker/3-test")

        self.assertTrue(marker.exists())
        self.assertTrue(self.swarm.local_branch_exists("worker/3-test"))

    def test_prunes_only_metadata_when_the_worktree_directory_is_already_gone(self):
        self._bind_test_target()
        worktree = self.swarm.create_worktree(4, "worker/4-test")
        shutil.rmtree(worktree)

        self.swarm.cleanup_worktree(4, "worker/4-test")

        self.assertFalse(self.swarm.local_branch_exists("worker/4-test"))


if __name__ == "__main__":
    unittest.main()
