#!/usr/bin/python3 -I
"""Vault Sync's engine: every git operation on a vault.

Run by the shell as an argv array, never through a shell:

    /usr/bin/python3 -I -S engine.py status <repo-url or -> -- <vault>...
    /usr/bin/python3 -I -S engine.py sync   <repo-url>      -- <vault>...

It prints one JSON object per line, and nothing else on stdout:

    {"event": "status", "vault": ..., "isRepo": ..., "changes": n, "unpushed": n,
     "conflictCopies": [...], "lastPushed": seconds or 0}
    {"event": "step",   "vault": ..., "text": "Contacting GitHub"}
    {"event": "done",   "vault": ..., "sent": n, "received": n,
     "conflicts": [...], "warnings": [...]}
    {"event": "error",  "vault": ..., "message": ...}
    {"event": "end"}

A sync commits the vault's notes, merges what other devices pushed to the
vault's folder in the repository (Vaults/<name>/), and pushes the result. A
note changed on both sides keeps GitHub's version under its name, and this
machine's version is written beside it as "note (conflict <time>).md". It
never force-pushes and never resets.

Every git command runs in its own session under a deadline, and its output
is read under a byte cap; overflow or the deadline stops the whole process
group. git never runs hooks or an fsmonitor, and checks symlinks out as plain
files. Conflict copies are created with O_CREAT|O_EXCL|O_NOFOLLOW beneath
the vault, walked one directory at a time without following symlinks.
"""

import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

GIT = "/usr/bin/git"
KiB = 1024
MiB = KiB * KiB

MAX_VAULTS = 50
OUT_CAP = 8 * MiB          # stdout of one git command
ERR_CAP = 64 * KiB         # stderr of one git command
WARN_BYTES = 50 * MiB      # GitHub warns about files this large
LIMIT_BYTES = 100 * MiB    # and refuses files this large
MAX_LISTED = 20            # paths named in one event

LOCAL = 60                 # seconds for a local git command
NETWORK = 300              # seconds for ls-remote, fetch and push

# Only notes are synced: Obsidian's own folder and its trash stay local.
PATHSPEC = ["--", ":(top)", ":(top,exclude).obsidian", ":(top,exclude).trash"]

# Predictable git whatever the user's config says, and no code from a vault's
# repository: no hooks, no fsmonitor, symlinks from GitHub become plain files.
GIT_CONFIG = [
    "-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "core.pager=cat",
    "-c", "rerere.enabled=false", "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false", "-c", "core.symlinks=false",
    "-c", "advice.detachedHead=false", "-c", "gc.auto=0",
]

CONTROL = re.compile("[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]")


class Failure(Exception):
    """A readable reason a vault could not sync."""


# ------------------------------------------------------------ validation

def repo_url(value):
    """https://github.com/<owner>/<repo>, normalized to ...<repo>.git, or ""."""
    m = re.fullmatch(r"https://github\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?",
                     value.strip())
    if not m or m.group(2) in (".", ".."):
        return ""
    return f"https://github.com/{m.group(1)}/{m.group(2)}.git"


def sync_refs(url):
    """refs/vault-sync/<owner>/<repo>: where a vault keeps its sync state for
    one repository. A part git would refuse gets a leading "_"."""
    owner, repo = url[len("https://github.com/"):-len(".git")].split("/")
    parts = ["_" + p if p.startswith(".") or p.endswith(".lock") else p for p in (owner, repo)]
    return "refs/vault-sync/" + "/".join(parts)


def vault_path(value):
    """An absolute path with no control characters and no ., .. or empty parts."""
    if not isinstance(value, str) or not 2 <= len(value) <= 1024 or not value.startswith("/"):
        return ""
    if CONTROL.search(value):
        return ""
    s = value.rstrip("/")
    if any(p in ("", ".", "..") for p in s.split("/")[1:]):
        return ""
    return s if len(s) > 1 else ""


def vault_folder(path):
    """Vaults/<name>: the vault's folder in the repository, or ""."""
    name = path.rsplit("/", 1)[-1]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}", name) or name.endswith((" ", ".")):
        return ""
    return "Vaults/" + name


def rel_path(value):
    """A path inside the vault as git reports it, or "": relative, no ., ..
    or empty parts, no control characters, never inside .git."""
    if not value or len(value) > 4096 or value.startswith("/") or CONTROL.search(value):
        return ""
    parts = value.split("/")
    if any(p in ("", ".", "..") for p in parts) or parts[0] == ".git":
        return ""
    return value


def branch_name(value):
    if not re.fullmatch(r"[A-Za-z0-9._/-]{1,100}", value or ""):
        return ""
    if re.search(r"^[-/.]|/$|\.lock$|\.\.|//|/\.|@\{", value):
        return ""
    return value


def plain(value, cap=200):
    s = CONTROL.sub("", str(value))
    return s if len(s) <= cap else s[:cap - 1] + "\u2026"


# ------------------------------------------------------------ names

def conflict_name(path, when, n):
    """dir/note.md -> dir/note (conflict 2026-09-23 1405).md, " 2" etc. for
    the n-th try."""
    tag = " (conflict " + time.strftime("%Y-%m-%d %H%M", when) + (f" {n}" if n > 1 else "") + ")"
    slash = path.rfind("/")
    head, base = path[:slash + 1], path[slash + 1:]
    dot = base.rfind(".")
    if dot <= 0:
        return head + base + tag
    return head + base[:dot] + tag + base[dot:]


CONFLICT_COPY = re.compile(r"\(conflict \d{4}-\d{2}-\d{2} \d{4}( \d+)?\)(\.[^/]*)?$")


def is_conflict_copy(path):
    return bool(CONFLICT_COPY.search(path.rsplit("/", 1)[-1]))


def commit_message(files, when):
    n = len(files)
    lines = ["Sync " + time.strftime("%Y-%m-%d %H:%M", when) + f" \u2014 {n} file{'' if n == 1 else 's'} changed"]
    if files:
        lines.append("")
        lines.extend(files[:50])
        if n > 50:
            lines.append(f"\u2026 and {n - 50} more")
    return "\n".join(lines)


def git_error(stderr):
    """A short, readable reason from a failed git command's stderr."""
    s = stderr.decode("utf-8", "replace") if isinstance(stderr, bytes) else str(stderr)
    checks = [
        (r"could not read Username|Authentication failed|terminal prompts disabled|Invalid username or (password|token)",
         "GitHub login needed. Run gh auth login, then gh auth setup-git, in a terminal."),
        (r"Repository not found|repository '.*' not found", "Repository not found, or your GitHub account can't access it."),
        (r"Could not resolve host|Failed to connect|Connection timed out|Network is unreachable",
         "Can't reach GitHub. Check your connection."),
        (r"Please tell me who you are|empty ident", "Git needs your name and email. Run git config --global user.name and user.email."),
        (r"Your local changes to the following files would be overwritten",
         "A note changed while syncing. Sync again."),
        (r"untracked working tree files would be overwritten",
         "GitHub has files that would overwrite files in the vault that aren't synced (such as .obsidian)."),
        (r"rejected|fetch first|non-fast-forward", "GitHub changed during the sync. Sync again."),
        (r"timed out", "A git command took too long and was stopped."),
    ]
    for pattern, message in checks:
        if re.search(pattern, s, re.I):
            return message
    for line in s.splitlines():
        line = re.sub(r"^(fatal|error): ", "", line).strip()
        if line:
            return plain(line, 160)
    return "Git failed."


# ------------------------------------------------------------ running git

def git_env():
    """git's environment: the minimal one the shell gave us, plus git's own
    switches. No prompts, no editor, English messages."""
    keep = ("HOME", "PATH", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "DBUS_SESSION_BUS_ADDRESS")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.setdefault("PATH", "/usr/bin:/bin")
    env.update({"LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0", "GIT_EDITOR": "true",
                "GIT_MERGE_AUTOEDIT": "no", "GIT_ASKPASS": "/usr/bin/true", "SSH_ASKPASS": "/usr/bin/true"})
    return env


def run(argv, stdin=b"", timeout=LOCAL, cap=OUT_CAP, env=None, sink=None):
    """Run argv in its own session. Returns (code, stdout, stderr). stdout is
    read under `cap` bytes (or streamed to `sink`, a writable descriptor,
    under `cap`); stderr under ERR_CAP. Overflow or the deadline stops the
    whole process group (TERM, then KILL) and raises Failure."""
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=True, close_fds=True, env=env or git_env())
    deadline = time.monotonic() + timeout
    out, err, total = [], [], 0
    pending = memoryview(stdin or b"")
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ, "out")
    sel.register(proc.stderr, selectors.EVENT_READ, "err")
    if pending:
        os.set_blocking(proc.stdin.fileno(), False)
        sel.register(proc.stdin, selectors.EVENT_WRITE, "in")
    else:
        proc.stdin.close()
    err_len = 0
    try:
        while sel.get_map():
            left = deadline - time.monotonic()
            if left <= 0:
                raise Failure("A git command took too long and was stopped.")
            for key, _ in sel.select(min(left, 1.0)):
                if key.data == "in":
                    try:
                        n = os.write(key.fileobj.fileno(), pending[:65536])
                        pending = pending[n:]
                    except BrokenPipeError:
                        pending = pending[:0]
                    if not pending:
                        sel.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    sel.unregister(key.fileobj)
                    continue
                if key.data == "out":
                    total += len(chunk)
                    if total > cap:
                        raise Failure("A git command produced more output than expected and was stopped.")
                    if sink is not None:
                        view = memoryview(chunk)
                        while view:
                            view = view[os.write(sink, view):]
                    else:
                        out.append(chunk)
                else:
                    err_len += len(chunk)
                    if err_len <= ERR_CAP:
                        err.append(chunk)
        left = max(0.1, deadline - time.monotonic())
        code = proc.wait(timeout=left)
    except BaseException:
        stop(proc)
        raise
    finally:
        sel.close()
        for f in (proc.stdin, proc.stdout, proc.stderr):
            try:
                f.close()
            except OSError:
                pass
    return code, b"".join(out), b"".join(err)


def stop(proc):
    """TERM the process group, then KILL, then reap. Quick enough to finish
    before the shell's own KILL reaches this process."""
    for sig, wait in ((signal.SIGTERM, 0.8), (signal.SIGKILL, 0.5)):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            break
        try:
            proc.wait(timeout=wait)
            break
        except subprocess.TimeoutExpired:
            continue


class Git:
    """git in one vault."""

    def __init__(self, vault):
        self.vault = vault

    def argv(self, args):
        return [GIT, "-C", self.vault, *GIT_CONFIG, *args]

    def run(self, *args, stdin=b"", timeout=LOCAL, cap=OUT_CAP, env=None, sink=None):
        return run(self.argv(args), stdin=stdin, timeout=timeout, cap=cap, env=env, sink=sink)

    def ok(self, *args, **kw):
        """stdout of a command that must succeed."""
        code, out, err = self.run(*args, **kw)
        if code != 0:
            raise Failure(git_error(err))
        return out

    def text(self, *args, **kw):
        return self.ok(*args, **kw).decode("utf-8", "strict").strip()

    def maybe(self, *args, **kw):
        """stdout (stripped) of a query that may fail, else ""."""
        code, out, _ = self.run(*args, **kw)
        return out.decode("utf-8", "strict").strip() if code == 0 else ""

    def paths(self, *args, **kw):
        """NUL-separated paths from a -z command, validated."""
        out = self.ok(*args, **kw)
        found = []
        for raw in out.split(b"\0"):
            if not raw:
                continue
            try:
                p = rel_path(raw.decode("utf-8", "strict"))
            except UnicodeDecodeError:
                raise Failure("A file name in the vault isn't valid UTF-8.")
            if p:
                found.append(p)
        return found


# ------------------------------------------------------------ files beneath the vault

def create_beneath(vault, rel):
    """A new file at vault/rel, created with O_EXCL and without following a
    symlink anywhere below the vault. Returns its descriptor, or None when the
    name is taken."""
    parts = rel.split("/")
    fd = os.open(vault, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for name in parts[:-1]:
            nfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nfd
        try:
            return os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                           0o666, dir_fd=fd)
        except FileExistsError:
            return None
    finally:
        os.close(fd)


# ------------------------------------------------------------ status

def status(vault, url):
    """A vault's local state, without touching the network or changing it."""
    git = Git(vault)
    result = {"event": "status", "vault": vault, "isRepo": False, "changes": 0, "unpushed": 0,
              "conflictCopies": [], "lastPushed": 0}
    code, out, _ = git.run("rev-parse", "--show-prefix")
    if code != 0 or out.strip():
        return result                                # not the vault's own repository yet
    result["isRepo"] = True
    out = git.ok("--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", *PATHSPEC)
    result["changes"] = count_status(out)
    copies = [p for p in git.paths("ls-files", "-z", "--", ":(top,glob)**/*(conflict *") if is_conflict_copy(p)]
    result["conflictCopies"] = copies[:MAX_LISTED]
    result["conflictCount"] = len(copies)
    if url:
        refs = sync_refs(url)
        n = git.maybe("rev-list", "--count", "--ignore-missing", "HEAD", "--not", refs + "/base")
        result["unpushed"] = int(n) if n.isdigit() else 0
        t = git.maybe("log", "-1", "--format=%ct", "--ignore-missing", refs + "/pushed")
        result["lastPushed"] = int(t) if t.isdigit() else 0
    return result


def count_status(out):
    """Entries in `git status --porcelain=v1 -z` output ("XY path"); a rename
    or copy is followed by its source path, which is not counted."""
    parts = out.split(b"\0")
    n, i = 0, 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4 or entry[2:3] != b" ":
            continue
        n += 1
        if b"R" in entry[:2] or b"C" in entry[:2]:
            i += 1
    return n


# ------------------------------------------------------------ sync

class Sync:
    """One vault synced with one repository."""

    def __init__(self, vault, url, emit):
        self.vault = vault
        self.url = url
        self.refs = sync_refs(url)
        self.folder = vault_folder(vault)
        self.git = Git(vault)
        self.emit = emit
        self.when = time.localtime()
        self.conflicts = []
        self.warnings = []
        self.merging = False
        self.merged = False

    def step(self, text):
        self.emit({"event": "step", "vault": self.vault, "text": text})

    def run(self):
        if not self.folder:
            raise Failure("Rename the vault folder to letters, digits, spaces, dots, dashes or underscores.")
        git = self.git

        # 1. Can GitHub be reached, and what is on it?
        self.step("Contacting GitHub")
        head, branches = self.remote_refs()
        branch = head or "main"

        # 2. The vault gets its own repository the first time: not a
        #    repository yet, or inside another one.
        self.step("Checking the vault")
        code, out, err = git.run("rev-parse", "--show-prefix")
        if code != 0 and not re.search(rb"not a git repository", err, re.I):
            raise Failure(git_error(err))
        if code != 0 or out.strip():
            self.step("Setting up git")
            git.ok("init", "-q", "-b", branch)

        # 3. origin points at the chosen repository.
        current = git.maybe("remote", "get-url", "origin")
        if current != self.url:
            git.ok("remote", "set-url" if current else "add", "origin", self.url)

        # 4. A merge left by an interrupted sync is abandoned. Its local side
        #    was committed first, so nothing is lost.
        if git.maybe("rev-parse", "-q", "--verify", "MERGE_HEAD"):
            git.ok("merge", "--abort")
        if not branch_name(git.maybe("symbolic-ref", "--short", "-q", "HEAD")):
            raise Failure("The vault's git repository isn't on a branch.")

        # 5. Commit this machine's changes, after checking their sizes.
        self.step("Saving your changes")
        git.ok("add", "-A", *PATHSPEC)
        self.check_sizes()
        staged = git.paths("diff", "--cached", "--name-only", "-z")
        if staged:
            git.ok("commit", "-q", "--no-verify", "-m", commit_message(staged, self.when))
        before = git.maybe("rev-parse", "-q", "--verify", "HEAD^{commit}")

        # 6-8. Merge what GitHub has, then push. It never forces: when GitHub
        #      moved on in between, fetch and merge once more.
        for attempt in (1, 2):
            tip = ""
            if branch in branches:
                self.step("Getting changes from GitHub")
                git.ok("fetch", "-q", "--no-tags", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
                       timeout=NETWORK)
                tip = git.maybe("rev-parse", "-q", "--verify", f"refs/remotes/origin/{branch}^{{commit}}")
                if not tip:
                    raise Failure(f"Couldn't read the repository's {branch} branch.")
                self.merge_incoming(tip)
            if not git.maybe("rev-parse", "-q", "--verify", "HEAD"):
                return self.done(tip, tip, before)   # an empty vault and nothing on GitHub
            tree = self.repository_tree(tip)
            if tip and tree == git.text("rev-parse", tip + "^{tree}"):
                pushed = tip                          # nothing to send
                break
            parents = ["-p", tip] if tip else []
            pushed = git.text("commit-tree", tree, *parents, "-m",
                              f"Sync {self.folder} " + time.strftime("%Y-%m-%d %H:%M", self.when))
            self.step("Sending to GitHub")
            code, _, err = git.run("push", "-q", "origin", f"{pushed}:refs/heads/{branch}", timeout=NETWORK)
            if code == 0:
                break
            if attempt == 1 and re.search(rb"rejected|fetch first|non-fast-forward", err, re.I):
                branches.add(branch)
                continue
            raise Failure(git_error(err))

        # 9. Remember where this sync left the vault and the repository.
        git.ok("update-ref", self.refs + "/base", "HEAD")
        git.ok("update-ref", self.refs + "/pushed", pushed)
        git.ok("update-ref", f"refs/remotes/origin/{branch}", pushed)
        return self.done(tip, pushed, before)

    def remote_refs(self):
        out = self.git.ok("ls-remote", "--symref", self.url, timeout=NETWORK, cap=4 * MiB).decode("utf-8", "replace")
        head, branches = "", set()
        for line in out.splitlines()[:10000]:
            m = re.fullmatch(r"ref: refs/heads/(\S+)\tHEAD", line)
            if m:
                head = branch_name(m.group(1))
                continue
            m = re.fullmatch(r"[0-9a-f]{40,64}\trefs/heads/(\S+)", line)
            if m and branch_name(m.group(1)) and len(branches) < 1000:
                branches.add(m.group(1))
        return head, branches

    def check_sizes(self):
        """GitHub refuses files over 100 MB and warns over 50 MB. The sizes
        are those of exactly what is staged, from git's object database."""
        git = self.git
        # --raw -z: ":<mode> <mode> <sha> <sha> <status>" NUL "<path>" NUL, repeated.
        parts = git.ok("diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-renames", "--diff-filter=AM").split(b"\0")
        entries = []
        for meta, raw in zip(parts[0::2], parts[1::2]):
            fields = meta.split()
            if not meta.startswith(b":") or len(fields) < 5 or not re.fullmatch(rb"[0-9a-f]{40,64}", fields[3]):
                continue
            try:
                path = rel_path(raw.decode("utf-8", "strict"))
            except UnicodeDecodeError:
                raise Failure("A file name in the vault isn't valid UTF-8.")
            if path:
                entries.append((fields[3], path))
        if not entries:
            return
        sizes = git.ok("cat-file", "--batch-check=%(objectsize)",
                       stdin=b"".join(sha + b"\n" for sha, _ in entries)).split()
        too_big = []
        for (sha, path), size in zip(entries, sizes):
            n = int(size) if size.isdigit() else 0
            if n >= LIMIT_BYTES:
                too_big.append(path)
            elif n >= WARN_BYTES:
                self.warnings.append(path)
        if too_big:
            raise Failure("Too large for GitHub (over 100 MB): " + ", ".join(too_big[:3]) +
                          (" and more" if len(too_big) > 3 else ""))

    def filter_tree(self, tree):
        """A tree with .obsidian and .trash removed: the remote's tree,
        filtered so those folders can never arrive from GitHub. Returns the
        filtered tree's SHA-1, or "" when nothing is left."""
        git = self.git
        gitdir = git.text("rev-parse", "--absolute-git-dir")
        env = git_env()
        env["GIT_INDEX_FILE"] = os.path.join(gitdir, "vault-sync-filter")
        try:
            # Read the remote tree into a temporary index.
            git.ok("read-tree", tree, env=env)
            # Remove .obsidian and .trash at the top level. git rm -r removes
            # a directory and everything under it, so .obsidian/app.json,
            # .obsidian/plugins/... etc. are all removed.
            git.ok("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--",
                   ":(top,literal).obsidian", ":(top,literal).trash", env=env)
            # Write the filtered tree.
            return git.text("write-tree", env=env)
        except Failure:
            return ""

    def merge_incoming(self, tip):
        """GitHub's copy of this vault's folder, as a commit on top of the last
        sync, so a normal merge brings in exactly what changed there. Before
        the first sync it has no parent, and the merge joins the two.
        
        .obsidian and .trash are excluded from the incoming tree: a repository
        contributor or compromised remote cannot place them in the vault."""
        git = self.git
        theirs = git.maybe("rev-parse", "-q", "--verify", f"{tip}:{self.folder}")
        if not theirs:
            return                                   # the folder isn't on GitHub yet
        base = git.maybe("rev-parse", "-q", "--verify", self.refs + "/base^{commit}")
        if base and git.text("rev-parse", base + "^{tree}") == theirs:
            return                                   # unchanged since the last sync
        
        # Filter the remote tree: read it into a temporary index, remove
        # .obsidian and .trash (which must never come from GitHub), and
        # write the filtered tree.
        filtered = self.filter_tree(theirs)
        if not filtered:
            return                                   # nothing left after filtering
        
        commit = git.text("commit-tree", filtered, *(["-p", base] if base else []),
                          "-m", f"Sync: {self.folder} on GitHub")
        self.step("Merging")
        self.merging = self.merged = True
        code, _, err = git.run("merge", "-q", "--no-edit", "--allow-unrelated-histories",
                               "-m", "Sync: merge changes from GitHub", commit)
        if code != 0:
            conflicted = git.paths("diff", "--name-only", "-z", "--diff-filter=U")
            if not conflicted:
                raise Failure(git_error(err))
            for path in conflicted:
                self.resolve(path)
            git.ok("commit", "-q", "--no-verify", "--no-edit")
        self.merging = False

    def resolve(self, path):
        """Keep both sides of a conflicted note: GitHub's version keeps the
        name, this machine's is written beside it. When one side deleted the
        note and the other edited it, the edit is kept."""
        git = self.git
        self.step("Keeping both versions of " + plain(path, 60))
        spec = ":(top,literal)" + path
        stages = {}
        for line in git.ok("ls-files", "-u", "-z", "--", spec).split(b"\0"):
            m = re.fullmatch(rb"[0-7]{6} ([0-9a-f]{40,64}) ([123])\t.*", line, re.S)
            if m:
                stages[m.group(2)] = m.group(1).decode()
        ours, theirs = stages.get(b"2"), stages.get(b"3")
        if ours and theirs:
            copy = self.write_copy(path, ours)
            git.ok("checkout", "--theirs", "--", spec)
            git.ok("add", "-A", "--", spec, ":(top,literal)" + copy)
            self.conflicts.append(path)
        else:
            if theirs:
                git.ok("checkout", "--theirs", "--", spec)
            elif ours:
                git.ok("checkout", "--ours", "--", spec)
            git.ok("add", "-A", "--", spec)

    def write_copy(self, path, blob):
        """This machine's version of `path`, written to a new conflict-copy
        name beside it. The name is claimed with O_EXCL, so an existing file
        is never replaced."""
        for n in range(1, 21):
            copy = conflict_name(path, self.when, n)
            if not rel_path(copy):
                break
            fd = create_beneath(self.vault, copy)
            if fd is None:
                continue
            try:
                self.git.ok("cat-file", "blob", blob, cap=LIMIT_BYTES, sink=fd)
                os.fsync(fd)
            except BaseException:
                os.close(fd)
                fd = None
                self.remove_beneath(copy)
                raise
            finally:
                if fd is not None:
                    os.close(fd)
            return copy
        raise Failure("Couldn't name a copy of " + plain(path, 80) + ".")

    def remove_beneath(self, rel):
        parts = rel.split("/")
        fd = os.open(self.vault, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            for name in parts[:-1]:
                nfd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
                os.close(fd)
                fd = nfd
            try:
                os.unlink(parts[-1], dir_fd=fd)
            except OSError:
                pass
        finally:
            os.close(fd)

    def repository_tree(self, tip):
        """The repository's tree with this vault's folder replaced by the
        vault's HEAD, built in a separate index file so the vault's own index
        and files are never touched."""
        git = self.git
        gitdir = git.text("rev-parse", "--absolute-git-dir")
        env = git_env()
        env["GIT_INDEX_FILE"] = os.path.join(gitdir, "vault-sync-index")
        git.ok("read-tree", *([tip] if tip else ["--empty"]), env=env)
        git.ok("rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ":(top,literal)" + self.folder, env=env)
        git.ok("read-tree", "--prefix=" + self.folder + "/", "HEAD", env=env)
        return git.text("write-tree", env=env)

    def done(self, tip, pushed, before):
        """What the sync did. Sent: this vault's folder in the repository
        before and after the push. Received: the vault before and after the
        merge."""
        git = self.git
        sent = received = 0
        if pushed and pushed != tip:
            if tip:
                sent = len(git.paths("diff", "--name-only", "-z", "--no-renames", tip, pushed, "--",
                                     ":(top,literal)" + self.folder))
            else:
                sent = len(git.paths("ls-tree", "-r", "--name-only", "-z", pushed, "--", self.folder))
        if self.merged:
            if before:
                changed = git.paths("diff", "--name-only", "-z", "--no-renames", before, "HEAD", "--")
            else:
                changed = git.paths("ls-tree", "-r", "--name-only", "-z", "HEAD")
            received = len([p for p in changed if not is_conflict_copy(p)])
        return {"event": "done", "vault": self.vault, "sent": sent, "received": received,
                "conflicts": self.conflicts[:MAX_LISTED], "conflictCount": len(self.conflicts),
                "warnings": self.warnings[:MAX_LISTED]}

    def abort(self):
        """Undo a half-finished merge. The local side was committed before
        it started, and a copy already written beside a note stays."""
        if self.merging:
            try:
                self.git.run("merge", "--abort")
            except Failure:
                pass


# ------------------------------------------------------------ main

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


class Stopped(BaseException):
    """The shell stopped this process (TERM): stop the git command in
    progress, which runs in its own process group, then exit."""


def on_term(signum, frame):
    raise Stopped()


def main(argv):
    signal.signal(signal.SIGTERM, on_term)
    if len(argv) < 4 or argv[1] not in ("status", "sync") or argv[3] != "--":
        return 2
    op = argv[1]
    url = "" if argv[2] == "-" and op == "status" else repo_url(argv[2])
    if not url and not (argv[2] == "-" and op == "status"):
        return 2
    vaults = []
    for v in argv[4:]:
        p = vault_path(v)
        if not p or p in vaults or len(vaults) >= MAX_VAULTS:
            return 2
        vaults.append(p)
    for vault in vaults:
        try:
            if op == "status":
                emit(status(vault, url))
            else:
                job = Sync(vault, url, emit)
                try:
                    emit(job.run())
                except BaseException:
                    job.abort()
                    raise
        except Failure as e:
            emit({"event": "error", "vault": vault, "message": plain(str(e), 200)})
        except (OSError, UnicodeDecodeError, ValueError) as e:
            emit({"event": "error", "vault": vault, "message": plain(f"Unexpected error: {e}", 200)})
        except Stopped:
            return 143
    emit({"event": "end"})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
