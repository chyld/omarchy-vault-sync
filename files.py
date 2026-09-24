#!/usr/bin/python3 -I
"""Every file Vault Sync reads or writes outside a vault's git repository.

Run by the shell as an argv array, never through a shell:

    /usr/bin/python3 -I -S files.py read obsidian   Obsidian's vault list
    /usr/bin/python3 -I -S files.py read theme      the Omarchy theme's colors.toml
    /usr/bin/python3 -I -S files.py read repos      Vault Sync's own repos.json
    /usr/bin/python3 -I -S files.py write repos     repos.json, from stdin

Reads open the file once with O_NOFOLLOW|O_NONBLOCK, check that descriptor
(a regular file, owned by this user, one link, within the size limit), and
read at most limit + 1 bytes from it, so a planted symlink, FIFO or huge
file is refused rather than followed, waited on or loaded. A missing file
prints nothing and exits 0; a refused one exits 3.

Writes go to repos.json only: the directory chain ~/.config/vault-sync is
walked from the passwd home with held descriptors (no symlinks, owned by
this user, the plugin's own directory 0700), the JSON on stdin is checked
and size-limited, written to an exclusively created random temporary at
0600, fsynced, renamed over repos.json and the directory fsynced.
"""

import json
import os
import pwd
import secrets
import stat
import sys

KiB = 1024

# Fixed, literal paths relative to the home directory: nothing here comes
# from the caller except the name of one of these.
READS = {
    "obsidian": ((".config", "obsidian"), "obsidian.json", 256 * KiB),
    "theme": ((".local", "state", "omarchy", "current", "theme"), "colors.toml", 64 * KiB),
    "repos": ((".config", "vault-sync"), "repos.json", 256 * KiB),
}
REPOS_DIR = (".config", "vault-sync")
REPOS_FILE = "repos.json"
REPOS_MAX = 256 * KiB

EXIT_REFUSED = 3
EXIT_USAGE = 2


def home():
    # $HOME can be set by whoever started us; the passwd entry is the anchor.
    return pwd.getpwuid(os.geteuid()).pw_dir


def read_file(parts, name, limit):
    """Bytes of ~/<parts>/<name>, None if it doesn't exist. Other apps' parent
    directories (a theme folder, a dotfiles symlink) may be symlinks; the file
    itself may not."""
    path = os.path.join(home(), *parts, name)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1:
            raise PermissionError(f"refusing {name}: not a regular file of this user with one link")
        if st.st_size > limit:
            raise PermissionError(f"refusing {name}: larger than {limit} bytes")
        os.set_blocking(fd, True)
        data = b""
        while len(data) <= limit:
            chunk = os.read(fd, min(64 * KiB, limit + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        if len(data) > limit:
            raise PermissionError(f"refusing {name}: grew past {limit} bytes")
        return data
    finally:
        os.close(fd)


def open_dir_chain(parts):
    """Walk ~/<parts> with held descriptors, creating what is missing (0700),
    and return a descriptor of the last directory. Every component must be a
    real directory owned by this user; the last one is made 0700."""
    fd = os.open(home(), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for i, name in enumerate(parts):
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            try:
                nfd = os.open(name, flags, dir_fd=fd)
            except FileNotFoundError:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                nfd = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = nfd
            st = os.fstat(fd)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid():
                raise PermissionError(f"refusing directory {name}: not a directory of this user")
            if i == len(parts) - 1 and st.st_mode & 0o077:
                os.fchmod(fd, 0o700)
        return fd
    except BaseException:
        os.close(fd)
        raise


def write_atomic(dirfd, name, data):
    tmp = f".{name}.{secrets.token_hex(8)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dirfd)
    try:
        os.fchmod(fd, 0o600)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        # rename(2) replaces a symlink at the destination rather than writing through it.
        os.rename(tmp, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
        os.fsync(dirfd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dirfd)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)


def check_repos(payload):
    """repos.json must be a JSON object of the expected shape; Safe.js does the
    field-by-field validation when it is read back."""
    doc = json.loads(payload.decode("utf-8", "strict"))
    if not isinstance(doc, dict) or not isinstance(doc.get("repos", {}), dict):
        raise ValueError("repos.json must be an object with a repos object")


def main(argv):
    if len(argv) != 3 or argv[1] not in ("read", "write"):
        return EXIT_USAGE
    op, what = argv[1], argv[2]
    try:
        if op == "read":
            if what not in READS:
                return EXIT_USAGE
            data = read_file(*READS[what])
            if data is not None:
                sys.stdout.buffer.write(data)
            return 0
        if what != "repos":
            return EXIT_USAGE
        payload = sys.stdin.buffer.read(REPOS_MAX + 1)
        if len(payload) > REPOS_MAX:
            raise ValueError("repos.json larger than the limit")
        check_repos(payload)
        dirfd = open_dir_chain(REPOS_DIR)
        try:
            write_atomic(dirfd, REPOS_FILE, payload)
        finally:
            os.close(dirfd)
        return 0
    except (PermissionError, ValueError, UnicodeDecodeError, OSError) as e:
        print(f"files.py: {e}", file=sys.stderr)
        return EXIT_REFUSED


if __name__ == "__main__":
    sys.exit(main(sys.argv))
