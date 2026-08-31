import importlib.util
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("swarm_orchestrator.py")


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

        os.environ["MAO_SWARM_REPO_ROOT"] = str(cls.repo)
        spec = importlib.util.spec_from_file_location("mao_swarm_test_module", SCRIPT_PATH)
        cls.swarm = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.swarm)

    @classmethod
    def tearDownClass(cls):
        cls.temp_dir.cleanup()

    def tearDown(self):
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
        created = self.swarm.create_worktree(1, "worker/1-test")
        self.assertEqual(created, self.swarm.create_worktree(1, "worker/1-test"))

    def test_runtime_artifacts_are_locally_excluded(self):
        status = subprocess.run(
            ["git", "-C", str(self.repo), "status", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        self.assertEqual(status, "")

    def test_blocks_a_branch_checked_out_at_another_path(self):
        other = self.repo / "other-worktree"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", "worker/2-test", str(other)],
            check=True,
            capture_output=True,
        )
        with self.assertRaisesRegex(RuntimeError, "already checked out"):
            self.swarm.create_worktree(2, "worker/2-test")

    def test_preserves_files_in_a_damaged_worktree(self):
        worktree = self.swarm.create_worktree(3, "worker/3-test")
        (worktree / ".git").unlink()
        marker = worktree / "keep-me.txt"
        marker.write_text("important\n")

        self.swarm.cleanup_worktree(3, "worker/3-test")

        self.assertTrue(marker.exists())
        self.assertTrue(self.swarm.local_branch_exists("worker/3-test"))

    def test_prunes_only_metadata_when_the_worktree_directory_is_already_gone(self):
        worktree = self.swarm.create_worktree(4, "worker/4-test")
        shutil.rmtree(worktree)

        self.swarm.cleanup_worktree(4, "worker/4-test")

        self.assertFalse(self.swarm.local_branch_exists("worker/4-test"))


if __name__ == "__main__":
    unittest.main()
