.pragma library

// Input validation and parsing shared by the sync service (Service.qml) and
// its bar icon (Settings.qml). Everything that did not come from this
// plugin's own literals is treated as input: settings from shell.json, the
// Obsidian vault list, file names in the vault, and git output.

var MAX_PATH = 1024
var MAX_REL_PATH = 4096
var MAX_FILES = 5000
var MAX_VAULTS = 50
// GitHub refuses files over 100 MB and warns over 50 MB.
var WARN_BYTES = 50 * 1024 * 1024
var LIMIT_BYTES = 100 * 1024 * 1024

// C0/C1 controls, line/paragraph separators, BOM, and bidi marks and overrides.
var CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/

// A GitHub repository URL, normalized to "https://github.com/<owner>/<repo>.git",
// or "" when it is not one. Only https github.com URLs are accepted: git then
// logs in through the user's own credential helper (gh), never a prompt.
function repoUrl(value) {
  if (typeof value !== "string") return ""
  var m = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(value.trim())
  if (!m || m[2] === "." || m[2] === "..") return ""
  return "https://github.com/" + m[1] + "/" + m[2] + ".git"
}

// "<owner>/<repo>" for a URL that passed repoUrl(), else "".
function repoSlug(value) {
  var url = repoUrl(value)
  return url ? url.slice("https://github.com/".length, -".git".length) : ""
}

// Where a vault's sync state for this repository is kept in the vault's own
// git repository: "refs/vault-sync/<owner>/<repo>", else "". Each repository
// has its own, so a new URL starts out unsynced. A name part that git
// would refuse (a leading dot, a ".lock" ending) gets a leading "_".
function syncRefs(value) {
  var slug = repoSlug(value)
  if (!slug) return ""
  var parts = slug.split("/")
  for (var i = 0; i < parts.length; i++)
    if (parts[i].charAt(0) === "." || /\.lock$/.test(parts[i])) parts[i] = "_" + parts[i]
  return "refs/vault-sync/" + parts.join("/")
}

// The repository's page on GitHub, else "".
function repoPage(value) {
  var slug = repoSlug(value)
  return slug ? "https://github.com/" + slug : ""
}

// An absolute directory path with no control characters, no "." or ".."
// segments and no trailing slash, else "".
function vaultPath(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > MAX_PATH) return ""
  if (value.charAt(0) !== "/" || CONTROL.test(value)) return ""
  var s = value.replace(/\/+$/, "")
  var parts = s.split("/")
  for (var i = 1; i < parts.length; i++) {
    if (parts[i] === "" || parts[i] === "." || parts[i] === "..") return ""
  }
  return s.length > 1 ? s : ""
}

// The vault's folder on GitHub, "Vaults/<name>", from its path, else "":
// the name must be plain letters, digits, spaces, dots, dashes or
// underscores.
function vaultFolder(path) {
  var p = vaultPath(path)
  var name = p ? p.slice(p.lastIndexOf("/") + 1) : ""
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(name) || /[ .]$/.test(name)) return ""
  return "Vaults/" + name
}

// A list of vault paths made safe to sync: invalid paths, repeats, and a
// second vault with the same folder name on GitHub are dropped.
function cleanSelection(list) {
  var out = []
  var folders = Object.create(null)
  if (!Array.isArray(list)) return out
  for (var j = 0; j < list.length && out.length < MAX_VAULTS; j++) {
    var path = vaultPath(list[j])
    var folder = path ? vaultFolder(path) : ""
    if (!folder || folders[folder]) continue
    folders[folder] = true
    out.push(path)
  }
  return out
}

// The selection older versions kept in shell.json: `vaults` (a list of
// paths), else a single `vault`, else the vault Obsidian has open. Read
// once, to fill in the repository file.
function legacySelection(settings, known) {
  if (settings && Array.isArray(settings.vaults)) return cleanSelection(settings.vaults)
  if (settings && typeof settings.vault === "string" && settings.vault) return cleanSelection([settings.vault])
  for (var i = 0; i < known.length; i++) if (known[i].open) return cleanSelection([known[i].path])
  return []
}

// ------------------------------------------------------------ repository file

// ~/.config/vault-sync/repos.json: which vaults sync to which repository,
// and when each last synced.
//   { "version": 1, "migrated": true,
//     "repos": { "https://github.com/<owner>/<repo>": {
//       "vaults": [paths], "lastSync": time, "lastSummary": "\u21912 \u21931",
//       "synced": { path: time } } } }
// Times are ISO 8601 with the local offset. Read defensively: an unreadable
// file is an empty one, and an unreadable field is left out.
var MAX_REPOS = 200

// "2026-09-23T22:15:04-07:00": local time with its offset.
function isoTime(date) {
  var off = -date.getTimezoneOffset()
  var sign = off >= 0 ? "+" : "-"
  off = Math.abs(off)
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    "T" + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds()) +
    sign + pad(Math.floor(off / 60)) + ":" + pad(off % 60)
}

// An ISO 8601 time as written by isoTime(), else "".
function cleanTime(value) {
  if (typeof value !== "string") return ""
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return ""
  return isFinite(new Date(value).getTime()) ? value : ""
}

function repoEntry(raw) {
  var entry = { vaults: cleanSelection(raw.vaults), lastSync: cleanTime(raw.lastSync),
                lastSummary: typeof raw.lastSummary === "string" ? plain(raw.lastSummary, 40) : "",
                synced: Object.create(null) }
  var synced = raw.synced
  if (synced && typeof synced === "object" && !Array.isArray(synced)) {
    var n = 0
    for (var path in synced) {
      if (++n > MAX_VAULTS * 4) break
      if (!Object.prototype.hasOwnProperty.call(synced, path)) continue
      var p = vaultPath(path)
      var t = cleanTime(synced[path])
      if (p && t) entry.synced[p] = t
    }
  }
  return entry
}

function repoConfig(text) {
  var config = { migrated: false, repos: Object.create(null) }
  var data
  try { data = JSON.parse(String(text || "")) } catch (e) { return config }
  if (!data || typeof data !== "object" || Array.isArray(data)) return config
  config.migrated = data.migrated === true
  var repos = data.repos
  if (!repos || typeof repos !== "object" || Array.isArray(repos)) return config
  var n = 0
  var seen = 0
  for (var key in repos) {
    if (++seen > MAX_REPOS * 4 || n >= MAX_REPOS) break
    if (!Object.prototype.hasOwnProperty.call(repos, key)) continue
    var page = repoPage(key)
    var raw = repos[key]
    if (!page || !raw || typeof raw !== "object" || Array.isArray(raw)) continue
    config.repos[page] = repoEntry(raw)
    n++
  }
  return config
}

function entryFor(config, url) {
  var page = repoPage(url)
  return page && config.repos[page] ? config.repos[page] : null
}

// The vaults ticked for a repository; none for one the file doesn't know.
function selectionFor(config, url) {
  var entry = entryFor(config, url)
  return entry ? entry.vaults : []
}

// Whether the file has an entry for a repository, even an empty one.
function knowsRepo(config, url) {
  return entryFor(config, url) !== null
}

// When Sync now last finished for a repository, and what it moved.
function lastSyncFor(config, url) {
  var entry = entryFor(config, url)
  return entry && entry.lastSync ? new Date(entry.lastSync) : null
}
function lastSummaryFor(config, url) {
  var entry = entryFor(config, url)
  return entry ? entry.lastSummary : ""
}

// When a vault last synced to a repository.
function vaultSyncedFor(config, url, path) {
  var entry = entryFor(config, url)
  return entry && entry.synced[path] ? new Date(entry.synced[path]) : null
}

// The file's text with `url`'s entry changed by `change`: any of vaults,
// lastSync, lastSummary, and synced (merged per vault). `migrated`, when
// given, is set too.
function repoConfigText(config, url, change, migrated) {
  var repos = {}
  var page = repoPage(url)
  var pages = Object.keys(config.repos)
  if (page && change && pages.indexOf(page) === -1) pages.push(page)
  pages.sort()
  for (var i = 0; i < pages.length; i++) {
    var old = config.repos[pages[i]] || repoEntry({})
    var entry = { vaults: old.vaults }
    if (old.lastSync) entry.lastSync = old.lastSync
    if (old.lastSummary) entry.lastSummary = old.lastSummary
    var synced = {}
    for (var p in old.synced) synced[p] = old.synced[p]
    if (pages[i] === page && change) {
      if (change.vaults) entry.vaults = cleanSelection(change.vaults)
      if (change.lastSync) entry.lastSync = isoTime(change.lastSync)
      if (change.lastSummary !== undefined) entry.lastSummary = plain(change.lastSummary, 40)
      if (change.synced) for (var q in change.synced) if (vaultPath(q)) synced[q] = isoTime(change.synced[q])
    }
    if (Object.keys(synced).length > 0) entry.synced = synced
    repos[pages[i]] = entry
  }
  var out = { version: 1, migrated: migrated === undefined ? config.migrated : migrated === true, repos: repos }
  return JSON.stringify(out, null, 2) + "\n"
}

// A vault's display name: its folder name.
function vaultName(path) {
  var p = vaultPath(path)
  return p ? plain(p.slice(p.lastIndexOf("/") + 1), 60) : ""
}

// Paths under `folder/`, with that prefix removed.
function inFolder(paths, folder) {
  var prefix = folder + "/"
  var list = []
  for (var i = 0; i < paths.length; i++)
    if (paths[i].indexOf(prefix) === 0 && paths[i].length > prefix.length) list.push(paths[i].slice(prefix.length))
  return list
}

// A path inside the vault as git reports it, else "": relative, no "." or
// ".." segments, no control characters, and never inside .git.
function relPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REL_PATH) return ""
  if (value.charAt(0) === "/" || CONTROL.test(value)) return ""
  var parts = value.split("/")
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "" || parts[i] === "." || parts[i] === "..") return ""
  }
  return parts[0] === ".git" ? "" : value
}

// A branch name, else "". Stricter than git's own rules.
function branchName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return ""
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) return ""
  if (/^[-\/.]|\/$|\.lock$|\.\.|\/\/|\/\.|@\{/.test(value)) return ""
  return value
}

// Text for display: controls removed and capped.
function plain(value, max) {
  var s = String(value === undefined || value === null ? "" : value)
  s = s.replace(new RegExp(CONTROL.source, "g"), "")
  var cap = max || 120
  return s.length > cap ? s.slice(0, cap - 1) + "\u2026" : s
}

// ------------------------------------------------------------ time

function pad(n) { return n < 10 ? "0" + n : String(n) }

// "2026-09-23 14:05" in local time.
function stamp(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes())
}

// "14:05" today, else "Sep 23 14:05".
function shortTime(date, now) {
  var hm = pad(date.getHours()) + ":" + pad(date.getMinutes())
  if (date.toDateString() === now.toDateString()) return hm
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return months[date.getMonth()] + " " + date.getDate() + " " + hm
}

// ------------------------------------------------------------ names

var CONFLICT_MARK = " (conflict "

// Where the local copy of a conflicted note goes:
// "dir/note.md" -> "dir/note (conflict 2026-09-23 1405).md", with " 2",
// " 3" and so on before the ")" for the n-th try when that name is taken.
function conflictName(path, date, n) {
  var tag = CONFLICT_MARK + date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + pad(date.getMinutes()) + (n > 1 ? " " + n : "") + ")"
  var slash = path.lastIndexOf("/")
  var dir = path.slice(0, slash + 1)
  var base = path.slice(slash + 1)
  var dot = base.lastIndexOf(".")
  if (dot <= 0) return dir + base + tag
  return dir + base.slice(0, dot) + tag + base.slice(dot)
}

// Whether a path is a conflict copy made by conflictName().
function isConflictCopy(path) {
  var base = String(path).slice(String(path).lastIndexOf("/") + 1)
  return /\(conflict \d{4}-\d{2}-\d{2} \d{4}( \d+)?\)(\.[^\/]*)?$/.test(base)
}

// The commit message for a sync: a subject line, then the changed files.
function commitMessage(files, date) {
  var n = files.length
  var lines = ["Sync " + stamp(date) + " \u2014 " + n + (n === 1 ? " file" : " files") + " changed"]
  if (n > 0) lines.push("")
  for (var i = 0; i < n && i < 50; i++) lines.push(files[i])
  if (n > 50) lines.push("\u2026 and " + (n - 50) + " more")
  return lines.join("\n")
}

// What a finished sync did, for the notification and the popup:
// { headline, body, short }. Conflict copies are counted as conflicts, not
// as files sent or received.
function syncSummary(sent, received, conflicts, warnings) {
  var up = sent.filter(function(p) { return !isConflictCopy(p) })
  var down = received.filter(function(p) { return !isConflictCopy(p) })
  var files = function(n) { return n + (n === 1 ? " file" : " files") }
  var names = function(list) {
    return list.slice(0, 3).join(", ") + (list.length > 3 ? " and " + (list.length - 3) + " more" : "")
  }
  var body = []
  if (up.length > 0) body.push("Uploaded " + files(up.length))
  if (down.length > 0) body.push("Downloaded " + files(down.length))
  if (conflicts.length > 0)
    body.push("Kept both versions of " + names(conflicts) + ". Your copy is marked (conflict).")
  if (warnings.length > 0) body.push("Over 50 MB: " + names(warnings))
  if (body.length === 0) body.push("Nothing changed here or on GitHub.")

  var parts = []
  if (up.length > 0) parts.push("\u2191" + up.length)
  if (down.length > 0) parts.push("\u2193" + down.length)
  if (conflicts.length > 0) parts.push(conflicts.length + " kept twice")
  var headline = up.length === 0 && down.length === 0 && conflicts.length === 0 ? "Vault already up to date"
    : "Vault synced: " + [up.length > 0 ? files(up.length) + " up" : "",
                          down.length > 0 ? files(down.length) + " down" : ""].filter(function(x) { return x }).join(", ")
  if (conflicts.length > 0 && up.length === 0 && down.length === 0) headline = "Vault synced"
  return { headline: headline, body: body.join("\n"), short: parts.length > 0 ? parts.join(" ") : "no changes" }
}

// ------------------------------------------------------------ git output

// NUL-separated paths (`-z` output), validated and bounded.
function nulPaths(out) {
  var list = []
  var parts = String(out || "").split("\u0000")
  for (var i = 0; i < parts.length && list.length < MAX_FILES; i++) {
    var p = relPath(parts[i])
    if (p) list.push(p)
  }
  return list
}

// `git status --porcelain=v1 -z` as [{ code, path }]. A rename or copy is
// followed by its source path, which is skipped.
function status(out) {
  var list = []
  var parts = String(out || "").split("\u0000")
  for (var i = 0; i < parts.length && list.length < MAX_FILES; i++) {
    var entry = parts[i]
    if (entry.length < 4 || entry.charAt(2) !== " ") continue
    var code = entry.slice(0, 2)
    var p = relPath(entry.slice(3))
    if (/[RC]/.test(code)) i++
    if (p) list.push({ code: code, path: p })
  }
  return list
}

// `git ls-remote --symref <url>`: the default branch and the branches that
// exist. An empty repository has neither.
function remoteRefs(out) {
  var result = { head: "", branches: [] }
  var lines = String(out || "").split("\n")
  for (var i = 0; i < lines.length && i < 10000; i++) {
    var sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(lines[i])
    if (sym) { result.head = branchName(sym[1]); continue }
    var ref = /^[0-9a-f]{40,64}\trefs\/heads\/(\S+)$/.exec(lines[i])
    if (ref && branchName(ref[1]) && result.branches.length < 1000) result.branches.push(ref[1])
  }
  return result
}

// `git ls-files -u -z -- <path>`: which sides of a conflict exist.
// Stage 2 is this machine's version, stage 3 is GitHub's.
function conflictSides(out) {
  var sides = { ours: false, theirs: false }
  var parts = String(out || "").split("\u0000")
  for (var i = 0; i < parts.length && i < 16; i++) {
    var m = /^[0-7]{6} [0-9a-f]{40,64} ([123])\t/.exec(parts[i])
    if (!m) continue
    if (m[1] === "2") sides.ours = true
    if (m[1] === "3") sides.theirs = true
  }
  return sides
}

// `find -printf "%s\t%P\0"` as [{ size, path }].
function sizedPaths(out) {
  var list = []
  var parts = String(out || "").split("\u0000")
  for (var i = 0; i < parts.length && list.length < 1000; i++) {
    var tab = parts[i].indexOf("\t")
    if (tab <= 0) continue
    var size = Number(parts[i].slice(0, tab))
    var p = relPath(parts[i].slice(tab + 1))
    if (p && isFinite(size) && size >= 0) list.push({ size: size, path: p })
  }
  return list
}

// A short, readable reason for a failed git command, from its stderr.
function gitError(stderr) {
  var s = String(stderr || "")
  if (/could not read Username|Authentication failed|terminal prompts disabled|Invalid username or (password|token)/i.test(s))
    return "GitHub login needed. Run gh auth login in a terminal."
  if (/Repository not found|repository '.*' not found/i.test(s))
    return "Repository not found, or your GitHub account can't access it."
  if (/Could not resolve host|Failed to connect|Connection timed out|Network is unreachable/i.test(s))
    return "Can't reach GitHub. Check your connection."
  if (/Please tell me who you are|empty ident/i.test(s))
    return "Git needs your name and email. Run git config --global user.name and user.email."
  if (/cannot change to|No such file or directory/i.test(s))
    return "The vault folder doesn't exist."
  if (/untracked working tree files would be overwritten/i.test(s))
    return "GitHub has files that would overwrite files in the vault that aren't synced (such as .obsidian)."
  if (/rejected|fetch first|non-fast-forward/i.test(s))
    return "GitHub changed during the sync. Sync again."
  var lines = s.split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^(fatal|error): /, "").trim()
    if (line) return plain(line, 160)
  }
  return "Git failed."
}

// ------------------------------------------------------------ theme

// A colour from the Omarchy theme's colors.toml: the first of `keys` that is
// set to a "#rrggbb" value, else `fallback`.
function themeColor(text, keys, fallback) {
  var src = String(text || "").slice(0, 65536)
  for (var i = 0; i < keys.length; i++) {
    var m = new RegExp("^" + keys[i] + "\\s*=\\s*\"(#[0-9A-Fa-f]{6})\"\\s*$", "m").exec(src)
    if (m) return m[1]
  }
  return fallback
}

// ------------------------------------------------------------ obsidian

// The vaults listed in ~/.config/obsidian/obsidian.json as [{ path, name, open }].
function vaults(text) {
  var data
  try { data = JSON.parse(String(text || "")) } catch (e) { return [] }
  var map = data && typeof data === "object" ? data.vaults : null
  if (!map || typeof map !== "object" || Array.isArray(map)) return []
  var list = []
  var seen = 0
  for (var id in map) {
    if (++seen > MAX_VAULTS * 4 || list.length >= MAX_VAULTS) break
    if (!Object.prototype.hasOwnProperty.call(map, id)) continue
    var v = map[id]
    var path = v && typeof v === "object" ? vaultPath(v.path) : ""
    if (!path) continue
    list.push({ path: path, name: plain(path.slice(path.lastIndexOf("/") + 1), 60), open: v.open === true })
  }
  return list
}
