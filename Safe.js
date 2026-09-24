.pragma library

// Input validation and parsing for the sync service (Service.qml) and its
// bar icon (Settings.qml). Everything that did not come from this plugin's
// own literals is treated as input: the Obsidian vault list, the theme,
// repos.json, the repository URL typed in the popup, and every line the
// engine prints.

var MAX_PATH = 1024
var MAX_REL_PATH = 4096
var MAX_VAULTS = 50
var MAX_REPOS = 200
var MAX_LISTED = 20

// C0/C1 controls, line/paragraph separators, BOM, and bidi marks and overrides.
var CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/

// ------------------------------------------------------------ repositories

// A GitHub repository URL, normalized to "https://github.com/<owner>/<repo>.git",
// or "" when it is not one. Only https github.com URLs are accepted: git then
// signs in through the user's own credential helper, never a prompt.
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

// The repository's page on GitHub, else "".
function repoPage(value) {
  var slug = repoSlug(value)
  return slug ? "https://github.com/" + slug : ""
}

// ------------------------------------------------------------ vaults

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

// The vault's folder in the repository, "Vaults/<name>", else "": the name
// must be plain letters, digits, spaces, dots, dashes or underscores.
function vaultFolder(path) {
  var p = vaultPath(path)
  var name = p ? p.slice(p.lastIndexOf("/") + 1) : ""
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(name) || /[ .]$/.test(name)) return ""
  return "Vaults/" + name
}

// A vault's display name: its folder name.
function vaultName(path) {
  var p = vaultPath(path)
  return p ? plain(p.slice(p.lastIndexOf("/") + 1), 60) : ""
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

// A path inside a vault, else "": relative, no "." or ".." segments, no
// control characters, and never inside .git.
function relPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REL_PATH) return ""
  if (value.charAt(0) === "/" || CONTROL.test(value)) return ""
  var parts = value.split("/")
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "" || parts[i] === "." || parts[i] === "..") return ""
  }
  return parts[0] === ".git" ? "" : value
}

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
    list.push({ path: path, name: vaultName(path), open: v.open === true })
  }
  return list
}

// ------------------------------------------------------------ text

// Text for display: controls removed and capped.
function plain(value, max) {
  var s = String(value === undefined || value === null ? "" : value)
  s = s.replace(new RegExp(CONTROL.source, "g"), "")
  var cap = max || 120
  return s.length > cap ? s.slice(0, cap - 1) + "\u2026" : s
}

// Text for a host component the plugin cannot pin to PlainText (the bar
// tooltip): no markup characters, no controls, capped.
function hostText(value, max) {
  return plain(String(value === undefined || value === null ? "" : value).replace(/[<>&]/g, ""), max)
}

// ------------------------------------------------------------ time

function pad(n) { return n < 10 ? "0" + n : String(n) }

// "14:05" today, else "Sep 23 14:05".
function shortTime(date, now) {
  var hm = pad(date.getHours()) + ":" + pad(date.getMinutes())
  if (date.toDateString() === now.toDateString()) return hm
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return months[date.getMonth()] + " " + date.getDate() + " " + hm
}

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

// ------------------------------------------------------------ repository file

// ~/.config/vault-sync/repos.json: the repository in use, which vaults sync
// to each repository, and when each last synced.
//   { "version": 1, "current": "https://github.com/<owner>/<repo>",
//     "repos": { "https://github.com/<owner>/<repo>": {
//       "vaults": [paths], "lastSync": time, "lastSummary": "\u21912 \u21931",
//       "synced": { path: time } } } }
// Read defensively: an unreadable file is an empty one, and an unreadable
// field is left out.

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
  var config = { current: "", repos: Object.create(null) }
  var data
  try { data = JSON.parse(String(text || "")) } catch (e) { return config }
  if (!data || typeof data !== "object" || Array.isArray(data)) return config
  config.current = repoPage(typeof data.current === "string" ? data.current : "")
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

// The file's text after `change` to `url`'s entry (any of vaults, lastSync,
// lastSummary, synced, merged per vault) and, when `current` is a string,
// with the repository in use set to it ("" for none).
function repoConfigText(config, url, change, current) {
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
  var out = { version: 1 }
  var cur = typeof current === "string" ? repoPage(current) : config.current
  if (cur) out.current = cur
  out.repos = repos
  return JSON.stringify(out, null, 2) + "\n"
}

// ------------------------------------------------------------ engine output

// One line printed by engine.py, validated: an event for one of `vaults`
// (or "end") with every field checked and capped, else null. The engine is
// the plugin's own code, but its output carries file names from the vaults
// and from GitHub, so it is input like any other.
function engineEvent(line, vaults) {
  var data
  try { data = JSON.parse(String(line)) } catch (e) { return null }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  if (data.event === "end") return { event: "end" }
  if (vaults.indexOf(data.vault) === -1) return null
  var count = function(v) { return typeof v === "number" && isFinite(v) && v >= 0 && v <= 1e10 ? Math.floor(v) : 0 }
  var paths = function(v) {
    var out = []
    if (!Array.isArray(v)) return out
    for (var i = 0; i < v.length && out.length < MAX_LISTED; i++) {
      var p = relPath(v[i])
      if (p) out.push(plain(p, 200))
    }
    return out
  }
  switch (data.event) {
  case "step":
    return { event: "step", vault: data.vault, text: plain(data.text, 80) }
  case "error":
    return { event: "error", vault: data.vault, message: plain(data.message, 200) || "Sync failed." }
  case "done":
    return { event: "done", vault: data.vault, sent: count(data.sent), received: count(data.received),
             conflicts: paths(data.conflicts), warnings: paths(data.warnings) }
  case "status":
    var copies = paths(data.conflictCopies)
    var pushed = count(data.lastPushed)
    return { event: "status", vault: data.vault, isRepo: data.isRepo === true, changes: count(data.changes),
             unpushed: count(data.unpushed), conflictCopies: copies,
             conflictCount: Math.max(copies.length, count(data.conflictCount)),
             lastPushed: pushed > 0 ? new Date(pushed * 1000) : null }
  default:
    return null
  }
}

// What a sync moved, for the popup header: "\u21913 \u21932", "2 kept twice",
// or "no changes".
function summary(sent, received, conflicts) {
  var parts = []
  if (sent > 0) parts.push("\u2191" + sent)
  if (received > 0) parts.push("\u2193" + received)
  if (conflicts > 0) parts.push(conflicts + " kept twice")
  return parts.length > 0 ? parts.join(" ") : "no changes"
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
