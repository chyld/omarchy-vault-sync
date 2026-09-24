// Unit tests for Safe.js and Commands.js, the code every untrusted value
// passes through. Run with: node --test tests/
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const root = fileURLToPath(new URL("..", import.meta.url))

// QML JavaScript libraries start with ".pragma" / ".import" lines, which are
// not JavaScript; drop them and evaluate the rest in a sandbox.
function load(file, globals = {}) {
  const src = readFileSync(root + file, "utf8").replace(/^\.(pragma|import) .*$/gm, "")
  const context = vm.createContext({ ...globals })
  vm.runInContext(src, context)
  return context
}

const Safe = load("Safe.js")
const Commands = load("Commands.js", { Safe })

test("repoUrl accepts https github.com repos only, normalized", () => {
  const want = "https://github.com/chyld/notes.git"
  for (const ok of ["https://github.com/chyld/notes", "https://github.com/chyld/notes.git",
                    "https://github.com/chyld/notes/", "  https://github.com/chyld/notes  "])
    assert.equal(Safe.repoUrl(ok), want, ok)
  assert.equal(Safe.repoUrl("https://github.com/a-b/my.vault_2"), "https://github.com/a-b/my.vault_2.git")
  for (const bad of ["", "http://github.com/chyld/notes", "git@github.com:chyld/notes.git",
                     "https://gitlab.com/chyld/notes", "https://github.com/chyld", "https://github.com/chyld/..",
                     "https://github.com/-x/notes", "https://github.com/chyld/notes/tree/main",
                     "https://github.com/chyld/no tes", "https://user@github.com/chyld/notes",
                     "https://github.com/chyld/notes?x=1", "https://github.com/chyld/no\ntes", 42, null])
    assert.equal(Safe.repoUrl(bad), "", JSON.stringify(bad))
})

test("repoSlug and repoPage", () => {
  assert.equal(Safe.repoSlug("https://github.com/chyld/notes.git"), "chyld/notes")
  assert.equal(Safe.repoPage("https://github.com/chyld/notes"), "https://github.com/chyld/notes")
  assert.equal(Safe.repoPage("nope"), "")
})

test("vaultPath wants a clean absolute path", () => {
  assert.equal(Safe.vaultPath("/home/u/Documents/Alpha"), "/home/u/Documents/Alpha")
  assert.equal(Safe.vaultPath("/home/u/My Notes/"), "/home/u/My Notes")
  for (const bad of ["", "/", "relative/path", "/home/../etc", "/home/./u", "/home//u", "/a\nb", "/a‮b", 7, null])
    assert.equal(Safe.vaultPath(bad), "", JSON.stringify(bad))
})

test("relPath keeps paths inside the vault and out of .git", () => {
  assert.equal(Safe.relPath("notes/todo.md"), "notes/todo.md")
  assert.equal(Safe.relPath("-rf.md"), "-rf.md")
  for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", ".git/config", ".git", "a\nb", "a\u0000b"])
    assert.equal(Safe.relPath(bad), "", JSON.stringify(bad))
})

test("vaults reads obsidian.json defensively", () => {
  const text = JSON.stringify({ vaults: {
    a: { path: "/home/u/Documents/Alpha", ts: 1, open: true },
    b: { path: "relative" }, c: null, d: { path: "/home/u/Beta" } } })
  const v = JSON.parse(JSON.stringify(Safe.vaults(text)))
  assert.deepEqual(v, [{ path: "/home/u/Documents/Alpha", name: "Alpha", open: true },
                       { path: "/home/u/Beta", name: "Beta", open: false }])
  for (const bad of ["", "{", "[]", '{"vaults":[]}', '{"vaults":"x"}']) assert.equal(Safe.vaults(bad).length, 0)
})

test("the environment is minimal and only takes absolute directories", () => {
  const env = { ...Commands.environment("/home/u", "/run/user/1000", "unix:path=/run/user/1000/bus", "", "relative") }
  assert.deepEqual(Object.keys(env).sort(), ["DBUS_SESSION_BUS_ADDRESS", "HOME", "LC_ALL", "PATH", "XDG_RUNTIME_DIR"])
  assert.equal(env.PATH, "/usr/bin:/bin")
  assert.equal(Commands.environment("/home/u", "", "unix:path=/x;rm -rf /", "", "").DBUS_SESSION_BUS_ADDRESS, undefined)
})

test("omarchyBin only trusts a plain absolute OMARCHY_PATH", () => {
  assert.equal(Commands.omarchyBin("/usr/share/omarchy"), "/usr/share/omarchy/bin")
  assert.equal(Commands.omarchyBin("/tmp/../etc"), "/usr/share/omarchy/bin")
  assert.equal(Commands.omarchyBin("rel"), "/usr/share/omarchy/bin")
})

test("themeColor reads a colour from colors.toml", () => {
  const toml = '# theme\naccent = "#4783d0"\nbright_yellow = "#b7ac8d"\nyellow = "#978c6e"\ncolor3 = "#111111"\n'
  assert.equal(Safe.themeColor(toml, ["yellow", "color3"], "#e0af68"), "#978c6e")
  assert.equal(Safe.themeColor('color3 = "#123456"', ["yellow", "color3"], "#e0af68"), "#123456")
  for (const bad of ["", 'yellow = "red"', 'yellow = "#12345"', 'yellow = "#1234567"', 'xyellow = "#123456"', null])
    assert.equal(Safe.themeColor(bad, ["yellow"], "#e0af68"), "#e0af68", String(bad))
})

test("vaultFolder maps a vault to Vaults/<name>", () => {
  assert.equal(Safe.vaultFolder("/home/u/Documents/Alpha"), "Vaults/Alpha")
  assert.equal(Safe.vaultFolder("/home/u/My Notes"), "Vaults/My Notes")
  assert.equal(Safe.vaultFolder("/home/u/work.notes_2-x"), "Vaults/work.notes_2-x")
  for (const bad of ["", "/", "relative", "/home/u/.hidden", "/home/u/a:b", "/home/u/a*b", "/home/u/trailing.", "/home/u/" + "x".repeat(101)])
    assert.equal(Safe.vaultFolder(bad), "", bad)
})

test("hostText strips markup and controls for host-rendered tooltips", () => {
  assert.equal(Safe.hostText('Vault Sync: <img src="http://x/">a&b\u202e', 60), 'Vault Sync: img src="http://x/"ab')
  assert.equal(Safe.hostText("x".repeat(100), 10).length, 10)
  assert.equal(Safe.vaultName("/home/u/My Notes"), "My Notes")
})

test("the repository file maps each repository to its vaults", () => {
  const text = JSON.stringify({ version: 1, current: "https://github.com/chyld/ddd.git", repos: {
    "https://github.com/chyld/ddd": { vaults: ["/v/Alpha", "/v/Beta", "/w/Beta", "bad"] },
    "https://github.com/chyld/eee.git": { vaults: [] },
    "http://evil.example/x": { vaults: ["/v/Alpha"] },
    "https://github.com/chyld/fff": "nope" } })
  const config = Safe.repoConfig(text)
  assert.equal(config.current, "https://github.com/chyld/ddd")
  assert.deepEqual([...Safe.selectionFor(config, "https://github.com/chyld/ddd.git")], ["/v/Alpha", "/v/Beta"])
  assert.deepEqual([...Safe.selectionFor(config, "https://github.com/chyld/eee")], [])
  assert.deepEqual([...Safe.selectionFor(config, "https://github.com/chyld/new")], [])
  assert.equal(Object.keys(config.repos).length, 2)

  const next = JSON.parse(Safe.repoConfigText(config, "https://github.com/chyld/new/", { vaults: ["/v/Gamma"] }))
  assert.deepEqual(next, { version: 1, current: "https://github.com/chyld/ddd", repos: {
    "https://github.com/chyld/ddd": { vaults: ["/v/Alpha", "/v/Beta"] },
    "https://github.com/chyld/eee": { vaults: [] },
    "https://github.com/chyld/new": { vaults: ["/v/Gamma"] } } })

  for (const bad of ["", "{", "[]", '{"repos":[]}', "null"]) {
    const c = Safe.repoConfig(bad)
    assert.equal(c.current, "")
    assert.equal(Object.keys(c.repos).length, 0)
  }
})

test("the repository file keeps when each repository and vault last synced", () => {
  const d = new Date(2026, 8, 23, 22, 15, 4)
  let text = Safe.repoConfigText(Safe.repoConfig(""), "https://github.com/chyld/ddd", { vaults: ["/v/Zeta", "/v/Eta"] })
  text = Safe.repoConfigText(Safe.repoConfig(text), "https://github.com/chyld/ddd",
                             { lastSync: d, lastSummary: "\u21912 \u21931", synced: { "/v/Zeta": d } })
  const config = Safe.repoConfig(text)
  const url = "https://github.com/chyld/ddd.git"
  assert.deepEqual([...Safe.selectionFor(config, url)], ["/v/Zeta", "/v/Eta"])
  assert.equal(Safe.lastSyncFor(config, url).getTime(), d.getTime())
  assert.equal(Safe.lastSummaryFor(config, url), "\u21912 \u21931")
  assert.equal(Safe.vaultSyncedFor(config, url, "/v/Zeta").getTime(), d.getTime())
  assert.equal(Safe.vaultSyncedFor(config, url, "/v/Eta"), null)
  assert.match(JSON.parse(text).repos["https://github.com/chyld/ddd"].lastSync, /^2026-09-23T22:15:04[+-]\d{2}:\d{2}$/)

  // A later toggle keeps the times.
  const toggled = Safe.repoConfig(Safe.repoConfigText(config, url, { vaults: ["/v/Eta"] }))
  assert.equal(Safe.lastSyncFor(toggled, url).getTime(), d.getTime())
  assert.equal(Safe.vaultSyncedFor(toggled, url, "/v/Zeta").getTime(), d.getTime())

  for (const bad of ["", "yesterday", "2026-09-23", "2026-13-40T99:99:99Z", 5])
    assert.equal(Safe.cleanTime(bad), "", String(bad))
  assert.equal(Safe.lastSyncFor(Safe.repoConfig('{"repos":{"https://github.com/a/b":{"vaults":[],"lastSync":"soon"}}}'), "https://github.com/a/b"), null)
})

test("the repository in use is kept in the file, and can be cleared", () => {
  let config = Safe.repoConfig("")
  config = Safe.repoConfig(Safe.repoConfigText(config, "", null, "https://github.com/chyld/notes/"))
  assert.equal(config.current, "https://github.com/chyld/notes")
  // Changing an entry leaves the repository in use alone.
  config = Safe.repoConfig(Safe.repoConfigText(config, "https://github.com/chyld/other", { vaults: ["/v/A"] }))
  assert.equal(config.current, "https://github.com/chyld/notes")
  config = Safe.repoConfig(Safe.repoConfigText(config, "", null, ""))
  assert.equal(config.current, "")
  assert.equal(Safe.repoConfig('{"current":"http://evil.example/x"}').current, "")
})

test("engine lines are validated before use", () => {
  const vaults = ["/v/Alpha"]
  assert.equal(Safe.engineEvent("not json", vaults), null)
  assert.equal(Safe.engineEvent('{"event":"step","vault":"/v/Other","text":"x"}', vaults), null)
  assert.equal(Safe.engineEvent('{"event":"rm -rf","vault":"/v/Alpha"}', vaults), null)
  assert.deepEqual({ ...Safe.engineEvent('{"event":"end"}', vaults) }, { event: "end" })
  const step = Safe.engineEvent('{"event":"step","vault":"/v/Alpha","text":"Merging\u202e<b>"}', vaults)
  assert.equal(step.text, "Merging<b>")
  const done = Safe.engineEvent(JSON.stringify({ event: "done", vault: "/v/Alpha", sent: 3, received: -1,
    conflicts: ["todo.md", "../x", "/etc/passwd", 5], warnings: Array(50).fill("big.bin") }), vaults)
  assert.equal(done.sent, 3)
  assert.equal(done.received, 0)
  assert.deepEqual([...done.conflicts], ["todo.md"])
  assert.equal(done.warnings.length, 20)
  const st = Safe.engineEvent(JSON.stringify({ event: "status", vault: "/v/Alpha", isRepo: "yes", changes: 1e99,
    unpushed: 2, conflictCopies: [], conflictCount: 4, lastPushed: 1790000000 }), vaults)
  assert.equal(st.isRepo, false)
  assert.equal(st.changes, 0)
  assert.equal(st.conflictCount, 4)
  assert.equal(st.lastPushed.getTime(), 1790000000 * 1000)
  assert.equal(Safe.engineEvent('{"event":"error","vault":"/v/Alpha"}', vaults).message, "Sync failed.")
})

test("summary says what a sync moved", () => {
  assert.equal(Safe.summary(3, 2, 0), "\u21913 \u21932")
  assert.equal(Safe.summary(0, 0, 1), "1 kept twice")
  assert.equal(Safe.summary(0, 0, 0), "no changes")
})

test("the engine and helpers run from the system Python in isolated mode", () => {
  assert.deepEqual([...Commands.status("/p/engine.py", "", ["/v/A"])],
                   ["/usr/bin/python3", "-I", "-S", "/p/engine.py", "status", "-", "--", "/v/A"])
  assert.deepEqual([...Commands.sync("/p/engine.py", "https://github.com/chyld/notes", ["/v/A", "/v/B"])],
                   ["/usr/bin/python3", "-I", "-S", "/p/engine.py", "sync", "https://github.com/chyld/notes.git", "--", "/v/A", "/v/B"])
  assert.equal(Commands.sync("/p/engine.py", "http://evil.example/x", ["/v/A"]), null)
  assert.deepEqual([...Commands.readFile("/p/files.py", "repos")], ["/usr/bin/python3", "-I", "-S", "/p/files.py", "read", "repos"])
  const curl = [...Commands.visibility("https://github.com/chyld/notes")]
  assert.equal(curl[1], "-q")
  assert.ok(!curl.includes("-L"))
  assert.deepEqual(curl.slice(-2), ["--", "https://api.github.com/repos/chyld/notes"])
  assert.deepEqual([...Commands.openUrl("/usr/share/omarchy", "https://github.com/chyld/notes.git")],
                   ["/usr/share/omarchy/bin/omarchy-launch-browser", "https://github.com/chyld/notes"])
})
