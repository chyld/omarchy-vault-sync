.pragma library
.import "Safe.js" as Safe

// Every command Vault Sync runs, built in one place. Each returns an argv
// array for Process.command: no shell is ever involved. Paths are passed
// after "--" wherever the tool allows it, so a file name can never be read
// as an option.

var GIT = "/usr/bin/git"
var FIND = "/usr/bin/find"
var MV = "/usr/bin/mv"
var CURL = "/usr/bin/curl"
var TIMEOUT = "/usr/bin/timeout"
var PYTHON = "/usr/bin/python3"
var DEFAULT_OMARCHY = "/usr/share/omarchy"

// Where the vault stands with a repository, kept in the vault's own git
// repository under Safe.syncRefs(url): "<refs>/base", its last synced
// commit, and "<refs>/pushed", the repository commit that sync pushed.
function baseRef(refs) { return refs + "/base" }
function pushedRef(refs) { return refs + "/pushed" }

// Only notes are synced: Obsidian's own folder and its trash stay local.
var PATHSPEC = ["--", ":(top)", ":(top,exclude).obsidian", ":(top,exclude).trash"]

// git in the vault, with settings that keep every run predictable whatever
// the user's global config says: no pager, no colour, plain paths, and no
// replayed conflict resolutions. A vault's repository never runs code or
// plants links: no hooks, no fsmonitor, and a symlink that arrives from
// GitHub is checked out as a plain file.
function git(vault, args) {
  return [GIT, "-C", vault,
          "-c", "core.quotePath=false", "-c", "color.ui=false",
          "-c", "rerere.enabled=false", "-c", "core.pager=cat",
          "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
          "-c", "core.symlinks=false"].concat(args)
}

// The whole environment of every command; nothing else is inherited. A
// fixed PATH, the home and runtime directories, and the session bus (git
// asks the user's credential helper, which may use the keyring). git never
// asks on a terminal, never opens an editor, and reports errors in English
// so gitError() can read them. Only absolute directory values are passed on.
function environment(home, runtimeDir, bus, configHome, ghConfigDir) {
  var env = { PATH: "/usr/bin:/bin", LC_ALL: "C",
              GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" }
  var dirs = { HOME: home, XDG_RUNTIME_DIR: runtimeDir, XDG_CONFIG_HOME: configHome, GH_CONFIG_DIR: ghConfigDir }
  for (var k in dirs) if (Safe.vaultPath(String(dirs[k] || ""))) env[k] = Safe.vaultPath(String(dirs[k]))
  var b = String(bus || "")
  if (/^unix:[A-Za-z0-9=,\/._-]{1,200}$/.test(b)) env.DBUS_SESSION_BUS_ADDRESS = b
  return env
}

// ------------------------------------------------------------ files

// files.py, next to this file: the only reads and writes outside a vault's
// repository (Obsidian's vault list, the theme's colours, repos.json), each
// through a checked descriptor. `script` is its absolute path.
function readFile(script, what) { return [PYTHON, "-I", "-S", script, "read", what] }
function writeRepos(script) { return [PYTHON, "-I", "-S", script, "write", "repos"] }

// ------------------------------------------------------------ repository

function showPrefix(vault) { return git(vault, ["rev-parse", "--show-prefix"]) }
function init(vault, branch) { return git(vault, ["init", "-q", "-b", branch]) }
function remoteUrl(vault) { return git(vault, ["remote", "get-url", "origin"]) }
function addRemote(vault, url) { return git(vault, ["remote", "add", "origin", url]) }
function setRemote(vault, url) { return git(vault, ["remote", "set-url", "origin", url]) }
function currentBranch(vault) { return git(vault, ["symbolic-ref", "--short", "-q", "HEAD"]) }
function commitId(vault, ref) { return git(vault, ["rev-parse", "-q", "--verify", ref + "^{commit}"]) }
function hasHead(vault) { return git(vault, ["rev-parse", "-q", "--verify", "HEAD"]) }
function mergeInProgress(vault) { return git(vault, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]) }
function abortMerge(vault) { return git(vault, ["merge", "--abort"]) }

// ------------------------------------------------------------ local state

// Read-only: --no-optional-locks keeps it from taking the index lock that a
// sync may need at the same moment.
function status(vault) {
  return git(vault, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"].concat(PATHSPEC))
}

// Commits on this machine that are not in the repository yet: those after
// the last sync to it. Before the first, every commit.
function unpushed(vault, refs) {
  return git(vault, ["rev-list", "--count", "--ignore-missing", "HEAD", "--not", baseRef(refs)])
}

// When this vault last reached the repository, in seconds since the epoch;
// nothing before the first sync.
function lastPushed(vault, refs) {
  return git(vault, ["log", "-1", "--format=%ct", "--ignore-missing", pushedRef(refs)])
}

// Conflict copies left from earlier syncs.
function conflictCopies(vault) {
  return git(vault, ["ls-files", "-z", "--", ":(top,glob)**/*(conflict *"])
}

function addAll(vault) { return git(vault, ["add", "-A"].concat(PATHSPEC)) }
function staged(vault) { return git(vault, ["diff", "--cached", "--name-only", "-z"]) }
function commit(vault, message) { return git(vault, ["commit", "-q", "--no-verify", "-m", message]) }
function commitMerge(vault) { return git(vault, ["commit", "-q", "--no-verify", "--no-edit"]) }

// Files of 50 MB or more outside .git, .obsidian and .trash, as
// "size<TAB>path<NUL>".
function largeFiles(vault) {
  return [FIND, vault, "-mindepth", "1",
          "(", "-name", ".git", "-o", "-name", ".obsidian", "-o", "-name", ".trash", ")", "-prune",
          "-o", "-type", "f", "-size", "+" + (Safe.WARN_BYTES / 1024 / 1024 - 1) + "M",
          "-printf", "%s\\t%P\\0"]
}

// Which of `paths` git ignores; they are never synced.
function ignored(vault, paths) {
  return git(vault, ["check-ignore", "-z", "--"].concat(paths))
}

// Files that differ between two commits, and every file in a commit,
// optionally only under `folder`: what a sync sent and received.
function changedBetween(vault, from, to, folder) {
  return git(vault, ["diff", "--name-only", "-z", "--no-renames", from, to, "--"]
    .concat(folder ? [":(top,literal)" + folder] : []))
}
function allFiles(vault, rev, folder) {
  return git(vault, ["ls-tree", "-r", "--name-only", "-z", rev, "--"].concat(folder ? [folder] : []))
}

// ------------------------------------------------------------ repository layout

// On GitHub each vault lives in its own folder, Vaults/<name>/, while in
// the vault its notes stay at the top. These build the repository's tree in
// a separate index file, so the vault's own index and files are never
// touched: GitHub's tree, with the vault's folder replaced by HEAD.
function staging(vault, args) {
  return ["/usr/bin/env", "GIT_INDEX_FILE=" + vault + "/.git/vault-sync-index"].concat(git(vault, args))
}
function stageTree(vault, commit) { return staging(vault, commit ? ["read-tree", commit] : ["read-tree", "--empty"]) }
function unstageFolder(vault, folder) {
  return staging(vault, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", ":(top,literal)" + folder])
}
function stageHeadAt(vault, folder) { return staging(vault, ["read-tree", "--prefix=" + folder + "/", "HEAD"]) }
function writeStaged(vault) { return staging(vault, ["write-tree"]) }

// The tree of a commit, or of one folder in it.
function treeOf(vault, commit, folder) {
  return git(vault, ["rev-parse", "-q", "--verify", folder ? commit + ":" + folder : commit + "^{tree}"])
}

function commitTree(vault, tree, parents, message) {
  var args = ["commit-tree", tree]
  for (var i = 0; i < parents.length; i++) args.push("-p", parents[i])
  return git(vault, args.concat(["-m", message]))
}

function updateRef(vault, ref, commit) { return git(vault, ["update-ref", ref, commit]) }

// ------------------------------------------------------------ GitHub

function remoteRefs(vault, url) { return git(vault, ["ls-remote", "--symref", url]) }

function fetch(vault, branch) {
  return git(vault, ["fetch", "-q", "--no-tags", "origin",
                     "+refs/heads/" + branch + ":refs/remotes/origin/" + branch])
}

function merge(vault, commit) {
  return git(vault, ["merge", "-q", "--no-edit", "--allow-unrelated-histories",
                     "-m", "Sync: merge changes from GitHub", commit])
}

// Pushes one commit to the branch. Never forced: GitHub refuses it when the
// branch moved on, and the sync merges again.
function push(vault, commit, branch) {
  return git(vault, ["push", "-q", "origin", commit + ":refs/heads/" + branch])
}

// Whether a repository is public: GitHub answers 200 without a login only
// for a public repository, and 404 for a private or missing one.
function visibility(url) {
  var slug = Safe.repoSlug(url)
  return slug ? [CURL, "-q", "-sS", "--proto", "=https", "--max-time", "10", "--max-filesize", "1048576",
                 "--noproxy", "*", "-o", "/dev/null", "-w", "%{http_code}",
                 "-H", "Accept: application/vnd.github+json",
                 "--", "https://api.github.com/repos/" + slug] : null
}

// ------------------------------------------------------------ conflicts

function conflicted(vault) { return git(vault, ["diff", "--name-only", "-z", "--diff-filter=U"]) }
function conflictStages(vault, path) { return git(vault, ["ls-files", "-u", "-z", "--", ":(top,literal)" + path]) }
function checkoutOurs(vault, path) { return git(vault, ["checkout", "--ours", "--", ":(top,literal)" + path]) }
function checkoutTheirs(vault, path) { return git(vault, ["checkout", "--theirs", "--", ":(top,literal)" + path]) }
function add(vault, paths) {
  var specs = []
  for (var i = 0; i < paths.length; i++) specs.push(":(top,literal)" + paths[i])
  return git(vault, ["add", "-A", "--"].concat(specs))
}

function exists(vault, path) { return ["/usr/bin/test", "-e", vault + "/" + path] }

// Renames a file inside the vault, refusing to replace an existing one.
function move(vault, from, to) {
  return [MV, "--no-clobber", "--", vault + "/" + from, vault + "/" + to]
}

// ------------------------------------------------------------ Omarchy

// The bin folder of the Omarchy install in use, from $OMARCHY_PATH when it
// is a plain absolute path, else the packaged location.
function omarchyBin(root) {
  var s = typeof root === "string" ? root : ""
  if (!/^\/[A-Za-z0-9._\/-]{1,200}$/.test(s) || s.indexOf("..") !== -1) s = DEFAULT_OMARCHY
  return s + "/bin"
}

function openUrl(root, url) {
  var page = Safe.repoPage(url)
  return page ? [omarchyBin(root) + "/omarchy-launch-browser", page] : null
}
