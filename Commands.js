.pragma library
.import "Safe.js" as Safe

// Every command the shell runs for Vault Sync, built in one place. Each
// returns an argv array for Process.command: no shell is ever involved.
// All git work happens in engine.py, and every file outside the vaults is
// read and written by files.py; both run under the system Python in
// isolated mode (-I -S), from this plugin's own directory.

var PYTHON = "/usr/bin/python3"
var CURL = "/usr/bin/curl"
var TIMEOUT = "/usr/bin/timeout"
var DEFAULT_OMARCHY = "/usr/share/omarchy"

// The whole environment of every command; nothing else is inherited. A
// fixed PATH, the home and runtime directories, and the session bus (git
// asks the user's credential helper, which may use the keyring). Only
// absolute directory values are passed on.
function environment(home, runtimeDir, bus, configHome, ghConfigDir) {
  var env = { PATH: "/usr/bin:/bin", LC_ALL: "C" }
  var dirs = { HOME: home, XDG_RUNTIME_DIR: runtimeDir, XDG_CONFIG_HOME: configHome, GH_CONFIG_DIR: ghConfigDir }
  for (var k in dirs) if (Safe.vaultPath(String(dirs[k] || ""))) env[k] = Safe.vaultPath(String(dirs[k]))
  var b = String(bus || "")
  if (/^unix:[A-Za-z0-9=,\/._-]{1,200}$/.test(b)) env.DBUS_SESSION_BUS_ADDRESS = b
  return env
}

// ------------------------------------------------------------ files.py

// Obsidian's vault list, the theme's colours or repos.json, read through a
// checked descriptor. `script` is files.py's absolute path.
function readFile(script, what) { return [PYTHON, "-I", "-S", script, "read", what] }

// repos.json, written 0600 from stdin.
function writeRepos(script) { return [PYTHON, "-I", "-S", script, "write", "repos"] }

// ------------------------------------------------------------ engine.py

// The local state of `vaults`, against `url` (or no repository), as JSON
// lines. Read-only: nothing is changed and nothing leaves the machine.
function status(script, url, vaults) {
  return [PYTHON, "-I", "-S", script, "status", Safe.repoUrl(url) || "-", "--"].concat(vaults)
}

// Sync `vaults` with `url`, as JSON lines. Null without a valid URL.
function sync(script, url, vaults) {
  var repo = Safe.repoUrl(url)
  return repo ? [PYTHON, "-I", "-S", script, "sync", repo, "--"].concat(vaults) : null
}

// ------------------------------------------------------------ GitHub

// Whether a repository is public: GitHub answers 200 without a login only
// for a public repository, and 404 for a private or missing one. No
// credentials, no redirects, nothing read but the status code.
function visibility(url) {
  var slug = Safe.repoSlug(url)
  return slug ? [CURL, "-q", "-sS", "--proto", "=https", "--max-time", "10", "--max-filesize", "1048576",
                 "--noproxy", "*", "-o", "/dev/null", "-w", "%{http_code}",
                 "-H", "Accept: application/vnd.github+json",
                 "--", "https://api.github.com/repos/" + slug] : null
}

// ------------------------------------------------------------ Omarchy

// The bin folder of the Omarchy install in use, from $OMARCHY_PATH when it
// is a plain absolute path, else the packaged location.
function omarchyBin(root) {
  var s = typeof root === "string" ? root : ""
  if (!/^\/[A-Za-z0-9._\/-]{1,200}$/.test(s) || s.indexOf("..") !== -1) s = DEFAULT_OMARCHY
  return s + "/bin"
}

// Open on GitHub: the repository's page, a validated https github.com URL.
function openUrl(root, url) {
  var page = Safe.repoPage(url)
  return page ? [omarchyBin(root) + "/omarchy-launch-browser", page] : null
}
