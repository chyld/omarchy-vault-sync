"""Tests for engine.py against real git repositories. A bare repository in a
temporary directory stands in for GitHub: a throwaway HOME's .gitconfig
rewrites https://github.com/test/vault.git to it.
Run with: /usr/bin/python3 -B -m unittest discover -s tests"""

import sys

sys.dont_write_bytecode = True   # no __pycache__ in the plugin tree

import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "..", "engine.py")
SPEC = importlib.util.spec_from_file_location("engine", ENGINE)
engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(engine)

URL = "https://github.com/test/vault"


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.home = os.path.join(self.root, "home")
        os.makedirs(self.home)
        self.remote = os.path.join(self.root, "remote.git")
        subprocess.run(["/usr/bin/git", "init", "-q", "--bare", "-b", "main", self.remote], check=True)
        with open(os.path.join(self.home, ".gitconfig"), "w") as f:
            f.write("[user]\n\tname = Test\n\temail = t@example.com\n"
                    f'[url "file://{self.remote}"]\n\tinsteadOf = https://github.com/test/vault.git\n')

    def tearDown(self):
        self.tmp.cleanup()

    def vault(self, name, files=None):
        path = os.path.join(self.root, name)
        os.makedirs(path, exist_ok=True)
        for rel, text in (files or {}).items():
            full = os.path.join(path, rel)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w") as f:
                f.write(text)
        return path

    def engine(self, op, *vaults, url=URL):
        env = {"HOME": self.home, "PATH": "/usr/bin:/bin"}
        out = subprocess.run(["/usr/bin/python3", "-I", "-S", ENGINE, op, url, "--", *vaults],
                             env=env, capture_output=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr.decode())
        events = [json.loads(line) for line in out.stdout.decode().splitlines()]
        self.assertEqual(events[-1], {"event": "end"})
        return events[:-1]

    def result(self, op, vault, url=URL):
        events = [e for e in self.engine(op, vault, url=url) if e["event"] != "step"]
        self.assertEqual(len(events), 1, events)
        return events[0]

    def remote_files(self):
        out = subprocess.run(["/usr/bin/git", "-C", self.remote, "ls-tree", "-r", "--name-only", "main"],
                             capture_output=True)
        return sorted(out.stdout.decode().splitlines()) if out.returncode == 0 else []   # nothing pushed yet

    def remote_git(self, *args):
        return subprocess.run(["/usr/bin/git", "-C", self.remote, *args],
                              check=True, capture_output=True, text=True).stdout.strip()

    def push_remote_files(self, files):
        """Publish through plain git so the engine cannot filter the fixture."""
        checkout = os.path.join(self.root, "contributor")
        env = {"HOME": self.home, "PATH": "/usr/bin:/bin"}
        subprocess.run(["/usr/bin/git", "clone", "-q", self.remote, checkout],
                       env=env, check=True, capture_output=True)
        for rel, content in files.items():
            path = os.path.join(checkout, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(content)
        for args in [("add", "."), ("commit", "-qm", "Remote changes"), ("push", "-q")]:
            subprocess.run(["/usr/bin/git", "-C", checkout, *args],
                           env=env, check=True, capture_output=True)
        for rel in files:
            self.assertIn(rel, self.remote_files())

    def read(self, vault, rel):
        with open(os.path.join(vault, rel)) as f:
            return f.read()

    # ------------------------------------------------------------ sync

    def test_two_vaults_share_one_repository(self):
        alpha = self.vault("Alpha", {"todo.md": "a", ".obsidian/app.json": "{}"})
        beta = self.vault("Beta", {"todo.md": "b", "sub/note.md": "n"})
        events = [e for e in self.engine("sync", alpha, beta) if e["event"] != "step"]
        self.assertEqual([e["event"] for e in events], ["done", "done"])
        self.assertEqual(events[0]["sent"], 1)
        self.assertEqual(events[1]["sent"], 2)
        self.assertEqual(self.remote_files(), ["Vaults/Alpha/todo.md", "Vaults/Beta/sub/note.md", "Vaults/Beta/todo.md"])

    def test_second_machine_receives_only_its_vault(self):
        self.engine("sync", self.vault("Alpha", {"a.md": "1"}), self.vault("Beta", {"b.md": "2"}))
        other = self.vault("m2/Alpha")
        done = self.result("sync", other)
        self.assertEqual(done["received"], 1)
        self.assertEqual(sorted(os.listdir(other)), [".git", "a.md"])

    def test_edits_on_both_sides_keep_both_versions(self):
        alpha = self.vault("Alpha", {"todo.md": "base\n"})
        self.result("sync", alpha)
        other = self.vault("m2/Alpha")
        self.result("sync", other)
        with open(os.path.join(other, "todo.md"), "w") as f:
            f.write("theirs\n")
        self.result("sync", other)
        with open(os.path.join(alpha, "todo.md"), "w") as f:
            f.write("mine\n")
        done = self.result("sync", alpha)
        self.assertEqual(done["conflicts"], ["todo.md"])
        copy = [n for n in os.listdir(alpha) if n.startswith("todo (conflict ")]
        self.assertEqual(len(copy), 1)
        self.assertEqual(self.read(alpha, "todo.md"), "theirs\n")
        self.assertEqual(self.read(alpha, copy[0]), "mine\n")
        self.assertIn("Vaults/Alpha/" + copy[0], self.remote_files())
        status = self.result("status", alpha)
        self.assertEqual(status["conflictCopies"], [copy[0]])

    def test_an_edit_beats_a_delete(self):
        alpha = self.vault("Alpha", {"keep.md": "v1\n"})
        self.result("sync", alpha)
        other = self.vault("m2/Alpha")
        self.result("sync", other)
        os.remove(os.path.join(other, "keep.md"))
        self.result("sync", other)
        with open(os.path.join(alpha, "keep.md"), "a") as f:
            f.write("edited\n")
        done = self.result("sync", alpha)
        self.assertEqual(done["event"], "done")
        self.assertEqual(self.read(alpha, "keep.md"), "v1\nedited\n")

    def test_a_taken_copy_name_is_never_replaced(self):
        alpha = self.vault("Alpha", {"todo.md": "base\n"})
        self.result("sync", alpha)
        other = self.vault("m2/Alpha")
        self.result("sync", other)
        with open(os.path.join(other, "todo.md"), "w") as f:
            f.write("theirs\n")
        self.result("sync", other)
        with open(os.path.join(alpha, "todo.md"), "w") as f:
            f.write("mine\n")
        # Plant a symlink on the name the first copy would take.
        victim = os.path.join(self.root, "victim")
        with open(victim, "w") as f:
            f.write("must survive")
        name = engine.conflict_name("todo.md", time.localtime(), 1)
        os.symlink(victim, os.path.join(alpha, name))
        self.result("sync", alpha)
        self.assertEqual(self.read(self.root, "victim"), "must survive")
        self.assertTrue(any(" 2).md" in n for n in os.listdir(alpha)))

    def test_symlinks_from_github_arrive_as_plain_files(self):
        other = self.vault("m2/Alpha", {"a.md": "1"})
        os.symlink("/etc/passwd", os.path.join(other, "link.md"))
        subprocess.run(["/usr/bin/git", "-C", other, "init", "-q", "-b", "main"], check=True)
        # Push a tree with a symlink straight into the repository.
        self.result("sync", other)
        alpha = self.vault("Alpha")
        self.result("sync", alpha)
        self.assertFalse(os.path.islink(os.path.join(alpha, "link.md")))

    def test_hooks_never_run(self):
        alpha = self.vault("Alpha", {"a.md": "1"})
        subprocess.run(["/usr/bin/git", "-C", alpha, "init", "-q", "-b", "main"], check=True)
        marker = os.path.join(self.root, "hook-ran")
        for hook in ("pre-commit", "post-commit", "post-merge", "pre-push"):
            path = os.path.join(alpha, ".git", "hooks", hook)
            with open(path, "w") as f:
                f.write(f"#!/bin/sh\ntouch {marker}\n")
            os.chmod(path, 0o755)
        self.result("sync", alpha)
        self.assertFalse(os.path.exists(marker))

    def test_refuses_files_github_would(self):
        alpha = self.vault("Alpha", {"a.md": "1"})
        with open(os.path.join(alpha, "huge.bin"), "wb") as f:
            f.truncate(engine.LIMIT_BYTES + 1)
        done = self.result("sync", alpha)
        self.assertEqual(done["event"], "error")
        self.assertIn("huge.bin", done["message"])
        self.assertEqual(self.remote_files(), [])

    def test_one_failure_does_not_stop_the_others(self):
        bad = self.vault("Bad", {"huge.bin": ""})
        with open(os.path.join(bad, "huge.bin"), "wb") as f:
            f.truncate(engine.LIMIT_BYTES + 1)
        good = self.vault("Good", {"g.md": "1"})
        events = [e["event"] for e in self.engine("sync", bad, good) if e["event"] != "step"]
        self.assertEqual(events, ["error", "done"])

    def test_nothing_to_do_sends_nothing(self):
        alpha = self.vault("Alpha", {"a.md": "1"})
        self.result("sync", alpha)
        head = self.remote_files()
        done = self.result("sync", alpha)
        self.assertEqual((done["sent"], done["received"]), (0, 0))
        self.assertEqual(self.remote_files(), head)

    # ------------------------------------------------------------ status

    def test_status_counts_changes_and_unsynced_commits(self):
        alpha = self.vault("Alpha", {"a.md": "1"})
        self.assertEqual(self.result("status", alpha)["isRepo"], False)
        self.result("sync", alpha)
        st = self.result("status", alpha)
        self.assertEqual((st["isRepo"], st["changes"], st["unpushed"]), (True, 0, 0))
        self.assertGreater(st["lastPushed"], 0)
        with open(os.path.join(alpha, "b.md"), "w") as f:
            f.write("2")
        os.rename(os.path.join(alpha, "a.md"), os.path.join(alpha, "c.md"))
        self.assertEqual(self.result("status", alpha)["changes"], 3)
        other = self.result("status", alpha, url="https://github.com/test/other")
        self.assertEqual(other["lastPushed"], 0, "each repository has its own sync history")

    # ------------------------------------------------------------ bounds and input

    def test_output_cap_stops_the_command(self):
        with self.assertRaises(engine.Failure):
            engine.run(["/usr/bin/yes"], cap=1024, timeout=10)

    def test_deadline_stops_the_whole_process_group(self):
        marker = os.path.join(self.root, "child-survived")
        start = time.monotonic()
        with self.assertRaises(engine.Failure):
            engine.run(["/bin/sh", "-c", f"(sleep 3; touch {marker}) & sleep 30"], timeout=1)
        self.assertLess(time.monotonic() - start, 5)
        time.sleep(3.5)
        self.assertFalse(os.path.exists(marker), "a child of the command outlived the deadline")

    def test_rejects_bad_arguments(self):
        env = {"HOME": self.home, "PATH": "/usr/bin:/bin"}
        for args in (["sync", "http://github.com/a/b", "--", "/tmp/x"], ["sync", URL, "--", "relative"],
                     ["sync", URL, "--", "/tmp/x", "/tmp/x"], ["delete", URL, "--"], ["sync", URL, "/tmp/x"]):
            rc = subprocess.run(["/usr/bin/python3", "-I", "-S", ENGINE, *args], env=env,
                                capture_output=True).returncode
            self.assertEqual(rc, 2, args)

    def test_names(self):
        when = time.strptime("2026-09-23 14:05", "%Y-%m-%d %H:%M")
        self.assertEqual(engine.conflict_name("a/b/note.v2.md", when, 1), "a/b/note.v2 (conflict 2026-09-23 1405).md")
        self.assertEqual(engine.conflict_name(".env", when, 3), ".env (conflict 2026-09-23 1405 3)")
        self.assertTrue(engine.is_conflict_copy("x/todo (conflict 2026-09-23 1405 2).md"))
        self.assertFalse(engine.is_conflict_copy("my (conflict notes).md"))
        self.assertEqual(engine.sync_refs("https://github.com/chyld/.github.git"), "refs/vault-sync/chyld/_.github")
        self.assertEqual(engine.vault_folder("/home/u/My Notes"), "Vaults/My Notes")
        self.assertEqual(engine.vault_folder("/home/u/.hidden"), "")
        for bad in ["", "/etc/passwd", "../x", "a//b", ".git/config", "a\nb"]:
            self.assertEqual(engine.rel_path(bad), "", bad)

    # ------------------------------------------------------------ security

    def test_filter_failure_aborts_before_push(self):
        alpha = self.vault("Alpha", {"note.md": "base"})
        self.assertEqual(self.result("sync", alpha)["event"], "done")
        refs = "refs/vault-sync/test/vault"
        def ref(name):
            return subprocess.check_output(
                ["/usr/bin/git", "-C", alpha, "rev-parse", refs + name]).strip()
        before = {name: ref(name) for name in ("/base", "/pushed")}
        self.push_remote_files({"Vaults/Alpha/note.md": "remote update"})
        remote_tip = self.remote_git("rev-parse", "main")
        lock = os.path.join(alpha, ".git", "vault-sync-filter.lock")
        with open(lock, "w") as f:
            f.write("stale lock")
        failed = self.result("sync", alpha)
        self.assertEqual(failed["event"], "error")
        self.assertIn("vault-sync-filter.lock", failed["message"])
        self.assertEqual(self.remote_git("rev-parse", "main"), remote_tip)
        self.assertEqual(self.remote_git("show", "main:Vaults/Alpha/note.md"), "remote update")
        self.assertEqual(self.read(alpha, "note.md"), "base")
        self.assertEqual({name: ref(name) for name in before}, before)
        os.unlink(lock)
        self.assertEqual(self.result("sync", alpha)["event"], "done")
        self.assertEqual(self.read(alpha, "note.md"), "remote update")

    def test_obsidian_folder_from_remote_is_never_merged(self):
        alpha = self.vault("Alpha", {"note.md": "safe", ".obsidian/app.json": "local settings"})
        self.result("sync", alpha)
        self.push_remote_files({
            "Vaults/Alpha/.obsidian/app.json": '{"malicious": true}',
            "Vaults/Alpha/.obsidian/plugins/evil/main.js": "evil",
            "Vaults/Alpha/legitimate.md": "This note is fine.",
        })
        done = self.result("sync", alpha)
        self.assertEqual(done["event"], "done")
        self.assertEqual(done["received"], 1)
        self.assertEqual(self.read(alpha, "legitimate.md"), "This note is fine.")
        self.assertEqual(self.read(alpha, ".obsidian/app.json"), "local settings")
        self.assertFalse(os.path.exists(os.path.join(alpha, ".obsidian", "plugins")))

    def test_obsidian_as_a_file_from_remote_is_rejected(self):
        alpha = self.vault("Alpha", {"note.md": "1"})
        self.result("sync", alpha)
        self.push_remote_files({"Vaults/Alpha/.obsidian": "not a directory",
                                "Vaults/Alpha/safe.md": "safe"})
        self.assertEqual(self.result("sync", alpha)["event"], "done")
        self.assertFalse(os.path.exists(os.path.join(alpha, ".obsidian")))
        self.assertEqual(self.read(alpha, "safe.md"), "safe")

    def test_trash_folder_from_remote_is_never_merged(self):
        alpha = self.vault("Alpha", {"note.md": "1"})
        self.result("sync", alpha)
        self.push_remote_files({"Vaults/Alpha/.trash/deleted.md": "deleted",
                                "Vaults/Alpha/kept.md": "kept"})
        self.assertEqual(self.result("sync", alpha)["event"], "done")
        self.assertFalse(os.path.exists(os.path.join(alpha, ".trash")))
        self.assertEqual(self.read(alpha, "kept.md"), "kept")

    def test_deeply_nested_obsidian_paths_are_filtered(self):
        alpha = self.vault("Alpha", {"a.md": "1"})
        self.result("sync", alpha)
        self.push_remote_files({"Vaults/Alpha/.obsidian/plugins/deep/nested/bad.js": "bad",
                                "Vaults/Alpha/good.md": "good"})
        self.assertEqual(self.result("sync", alpha)["event"], "done")
        self.assertFalse(os.path.exists(os.path.join(alpha, ".obsidian")))
        self.assertEqual(self.read(alpha, "good.md"), "good")

    def test_files_named_obsidian_in_subdirs_are_allowed(self):
        alpha = self.vault("Alpha", {"a.md": "1"})
        self.result("sync", alpha)
        self.push_remote_files({"Vaults/Alpha/notes/.obsidian": "An unusual note name."})
        self.assertEqual(self.result("sync", alpha)["event"], "done")
        self.assertEqual(self.read(alpha, "notes/.obsidian"), "An unusual note name.")


if __name__ == "__main__":
    unittest.main()
