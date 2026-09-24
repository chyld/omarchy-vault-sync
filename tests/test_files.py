"""Tests for files.py, the only code that reads or writes files outside a
vault's git repository. Run with: /usr/bin/python3 -m unittest discover -s tests"""

import sys

sys.dont_write_bytecode = True   # no __pycache__ in the plugin tree

import importlib.util
import os
import stat
import subprocess
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("files", os.path.join(HERE, "..", "files.py"))
files = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(files)


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = self.tmp.name
        files.home = lambda: self.home
        self.obsidian_dir = os.path.join(self.home, ".config", "obsidian")
        os.makedirs(self.obsidian_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, what):
        return files.read_file(*files.READS[what])

    def write_repos(self, text):
        dirfd = files.open_dir_chain(files.REPOS_DIR)
        try:
            files.check_repos(text.encode())
            files.write_atomic(dirfd, files.REPOS_FILE, text.encode())
        finally:
            os.close(dirfd)

    # ------------------------------------------------------------ reads

    def test_reads_a_regular_file(self):
        with open(os.path.join(self.obsidian_dir, "obsidian.json"), "w") as f:
            f.write('{"vaults": {}}')
        self.assertEqual(self.read("obsidian"), b'{"vaults": {}}')

    def test_missing_file_is_none(self):
        self.assertIsNone(self.read("obsidian"))
        self.assertIsNone(self.read("repos"))

    def test_refuses_a_symlink(self):
        victim = os.path.join(self.home, "secret")
        with open(victim, "w") as f:
            f.write("private")
        os.symlink(victim, os.path.join(self.obsidian_dir, "obsidian.json"))
        with self.assertRaises(OSError):
            self.read("obsidian")

    def test_refuses_a_fifo_without_hanging(self):
        os.mkfifo(os.path.join(self.obsidian_dir, "obsidian.json"))
        result = []
        t = threading.Thread(target=lambda: result.append(self._try_read()), daemon=True)
        t.start()
        t.join(3)
        self.assertFalse(t.is_alive(), "reading a FIFO must not block")
        self.assertEqual(result, ["refused"])

    def _try_read(self):
        try:
            self.read("obsidian")
            return "read"
        except PermissionError:
            return "refused"

    def test_refuses_a_hard_link(self):
        path = os.path.join(self.obsidian_dir, "obsidian.json")
        with open(path, "w") as f:
            f.write("{}")
        os.link(path, os.path.join(self.home, "other-name"))
        with self.assertRaises(PermissionError):
            self.read("obsidian")

    def test_refuses_an_oversized_file(self):
        with open(os.path.join(self.obsidian_dir, "obsidian.json"), "wb") as f:
            f.write(b" " * (256 * 1024 + 1))
        with self.assertRaises(PermissionError):
            self.read("obsidian")

    # ------------------------------------------------------------ writes

    def test_writes_0600_in_a_0700_directory(self):
        self.write_repos('{"version": 1, "repos": {}}')
        d = os.path.join(self.home, ".config", "vault-sync")
        self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(d, "repos.json")).st_mode), 0o600)
        self.assertEqual(self.read("repos"), b'{"version": 1, "repos": {}}')
        self.assertEqual([n for n in os.listdir(d) if n != "repos.json"], [], "no temporary left behind")

    def test_tightens_an_existing_open_directory(self):
        d = os.path.join(self.home, ".config", "vault-sync")
        os.makedirs(d, mode=0o755)
        os.chmod(d, 0o755)
        self.write_repos('{"repos": {}}')
        self.assertEqual(stat.S_IMODE(os.stat(d).st_mode), 0o700)

    def test_replaces_a_planted_symlink_instead_of_writing_through_it(self):
        d = os.path.join(self.home, ".config", "vault-sync")
        os.makedirs(d, mode=0o700)
        victim = os.path.join(self.home, "victim")
        with open(victim, "w") as f:
            f.write("must survive")
        os.symlink(victim, os.path.join(d, "repos.json"))
        self.write_repos('{"repos": {}}')
        with open(victim) as f:
            self.assertEqual(f.read(), "must survive")
        self.assertFalse(os.path.islink(os.path.join(d, "repos.json")))

    def test_refuses_a_symlinked_directory(self):
        elsewhere = os.path.join(self.home, "elsewhere")
        os.makedirs(elsewhere)
        os.symlink(elsewhere, os.path.join(self.home, ".config", "vault-sync"))
        with self.assertRaises(OSError):
            self.write_repos('{"repos": {}}')
        self.assertEqual(os.listdir(elsewhere), [])

    def test_refuses_invalid_json(self):
        for bad in ["", "not json", "[]", '{"repos": []}']:
            with self.assertRaises(ValueError, msg=bad):
                files.check_repos(bad.encode())

    # ------------------------------------------------------------ command line

    def test_command_line_rejects_other_names(self):
        script = os.path.join(HERE, "..", "files.py")
        for args in (["read", "../etc/passwd"], ["write", "obsidian"], ["delete", "repos"], []):
            rc = subprocess.run(["/usr/bin/python3", "-I", "-S", script, *args],
                                stdin=subprocess.DEVNULL, capture_output=True).returncode
            self.assertEqual(rc, files.EXIT_USAGE, args)


if __name__ == "__main__":
    unittest.main()
