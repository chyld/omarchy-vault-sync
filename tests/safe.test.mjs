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

test("branchName", () => {
  for (const ok of ["main", "master", "feature/x", "v1.2"]) assert.equal(Safe.branchName(ok), ok)
  for (const bad of ["", "-x", "/x", "x/", "a..b", "x.lock", "a b", "a@{1}", ".hidden", "a/.b", "a//b"])
    assert.equal(Safe.branchName(bad), "", bad)
})

test("conflictName puts the tag before the extension", () => {
  const d = new Date(2026, 8, 23, 14, 5)
  assert.equal(Safe.conflictName("todo.md", d), "todo (conflict 2026-09-23 1405).md")
  assert.equal(Safe.conflictName("a/b/note.v2.md", d), "a/b/note.v2 (conflict 2026-09-23 1405).md")
  assert.equal(Safe.conflictName("dir.x/README", d), "dir.x/README (conflict 2026-09-23 1405)")
  assert.equal(Safe.conflictName(".env", d), ".env (conflict 2026-09-23 1405)")
  assert.equal(Safe.conflictName("todo.md", d, 3), "todo (conflict 2026-09-23 1405 3).md")
  for (const n of [1, 2, 7]) assert.ok(Safe.isConflictCopy(Safe.conflictName("x/todo.md", d, n)))
  assert.ok(!Safe.isConflictCopy("todo.md"))
  assert.ok(!Safe.isConflictCopy("my (conflict notes).md"))
})

test("commitMessage lists files and caps the list", () => {
  const d = new Date(2026, 8, 23, 14, 5)
  assert.equal(Safe.commitMessage(["a.md"], d), "Sync 2026-09-23 14:05 — 1 file changed\n\na.md")
  const many = Array.from({ length: 60 }, (_, i) => `n${i}.md`)
  const msg = Safe.commitMessage(many, d).split("\n")
  assert.equal(msg[0], "Sync 2026-09-23 14:05 — 60 files changed")
  assert.equal(msg.length, 2 + 50 + 1)
  assert.equal(msg.at(-1), "… and 10 more")
})

test("status parses porcelain -z, skipping rename sources", () => {
  const out = " M todo.md\x00?? new note.md\x00R  moved.md\x00old.md\x00 D gone.md\x00?? .git/x\x00"
  assert.deepEqual(JSON.parse(JSON.stringify(Safe.status(out))), [
    { code: " M", path: "todo.md" }, { code: "??", path: "new note.md" },
    { code: "R ", path: "moved.md" }, { code: " D", path: "gone.md" }])
  assert.equal(Safe.status("").length, 0)
})

test("remoteRefs reads the default branch and branches", () => {
  const sha = "a".repeat(40)
  const out = `ref: refs/heads/main\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/main\n${sha}\trefs/heads/dev\n${sha}\trefs/tags/v1\n`
  const r = Safe.remoteRefs(out)
  assert.equal(r.head, "main")
  assert.deepEqual([...r.branches], ["main", "dev"])
  const empty = Safe.remoteRefs("")
  assert.equal(empty.head, "")
  assert.equal(empty.branches.length, 0)
  assert.equal(Safe.remoteRefs("ref: refs/heads/-bad\tHEAD\n").head, "")
})

test("conflictSides reads index stages", () => {
  const sha = "b".repeat(40)
  const both = `100644 ${sha} 1\ta.md\x00100644 ${sha} 2\ta.md\x00100644 ${sha} 3\ta.md\x00`
  assert.deepEqual({ ...Safe.conflictSides(both) }, { ours: true, theirs: true })
  assert.deepEqual({ ...Safe.conflictSides(`100644 ${sha} 3\ta.md\x00`) }, { ours: false, theirs: true })
  assert.deepEqual({ ...Safe.conflictSides("") }, { ours: false, theirs: false })
})

test("sizedPaths parses find -printf output", () => {
  const out = "60000000\tvideo.mp4\x00" + "5\t../escape\x00" + "x\tbad.md\x00"
  assert.deepEqual(JSON.parse(JSON.stringify(Safe.sizedPaths(out))), [{ size: 60000000, path: "video.mp4" }])
})

test("gitError gives readable reasons", () => {
  assert.match(Safe.gitError("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), /gh auth login/)
  assert.match(Safe.gitError("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found"), /not found/)
  assert.match(Safe.gitError("fatal: unable to access: Could not resolve host: github.com"), /connection/)
  assert.match(Safe.gitError(" ! [rejected] HEAD -> main (fetch first)"), /Sync again/)
  assert.equal(Safe.gitError("fatal: something odd\n"), "something odd")
  assert.equal(Safe.gitError(""), "Git failed.")
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

test("commands are argv arrays with paths after --", () => {
  const v = "/home/u/Alpha"
  const add = [...Commands.add(v, ["-rf.md", "a b.md"])]
  assert.equal(add[0], "/usr/bin/git")
  assert.deepEqual(add.slice(add.indexOf("--")), ["--", ":(top,literal)-rf.md", ":(top,literal)a b.md"])
  assert.deepEqual([...Commands.move(v, "a.md", "a (conflict).md")],
                   ["/usr/bin/mv", "--no-clobber", "--", v + "/a.md", v + "/a (conflict).md"])
  const status = [...Commands.status(v)]
  assert.ok(status.indexOf("--no-optional-locks") < status.indexOf("status"))
  assert.deepEqual(status.slice(status.indexOf("--")), ["--", ":(top)", ":(top,exclude).obsidian", ":(top,exclude).trash"])
  assert.equal(Commands.visibility("nope"), null)
  assert.equal([...Commands.visibility("https://github.com/chyld/notes")].at(-1), "https://api.github.com/repos/chyld/notes")
})


test("syncSummary says what a sync moved", () => {
  const plain = (o) => JSON.parse(JSON.stringify(o))
  assert.deepEqual(plain(Safe.syncSummary([], [], [], [])), {
    headline: "Vault already up to date", body: "Nothing changed here or on GitHub.", short: "no changes" })
  const s = plain(Safe.syncSummary(["a.md", "b.md", "c.md", "d.md"], ["x.md"], [], []))
  assert.equal(s.headline, "Vault synced: 4 files up, 1 file down")
  assert.equal(s.body, "Uploaded 4 files\nDownloaded 1 file")
  assert.equal(s.short, "↑4 ↓1")
  const c = plain(Safe.syncSummary(["todo (conflict 2026-09-23 1405).md"], ["todo.md"], ["todo.md"], ["big.bin"]))
  assert.equal(c.headline, "Vault synced: 1 file down")
  assert.equal(c.body, "Downloaded 1 file\nKept both versions of todo.md. Your copy is marked (conflict).\nOver 50 MB: big.bin")
  assert.equal(c.short, "↓1 1 kept twice")
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

test("inFolder keeps paths under a folder, without the prefix", () => {
  assert.deepEqual([...Safe.inFolder(["Vaults/Alpha/a.md", "Vaults/Alpha/d/b.md", "Vaults/Alphabet/c.md", "Vaults/Alpha", "x.md"], "Vaults/Alpha")],
                   ["a.md", "d/b.md"])
})

test("layout commands use a separate index and literal paths", () => {
  const v = "/home/u/Alpha"
  const stage = [...Commands.unstageFolder(v, "Vaults/Alpha")]
  assert.deepEqual(stage.slice(0, 2), ["/usr/bin/env", "GIT_INDEX_FILE=/home/u/Alpha/.git/vault-sync-index"])
  assert.equal(stage.at(-1), ":(top,literal)Vaults/Alpha")
  assert.equal([...Commands.stageHeadAt(v, "Vaults/Alpha")].at(-2), "--prefix=Vaults/Alpha/")
  assert.deepEqual([...Commands.push(v, "abc", "main")].slice(-3), ["-q", "origin", "abc:refs/heads/main"])
  assert.deepEqual([...Commands.unpushed(v, "refs/vault-sync/chyld/notes")].slice(-5),
                   ["--count", "--ignore-missing", "HEAD", "--not", "refs/vault-sync/chyld/notes/base"])
  assert.deepEqual([...Commands.commitTree(v, "t", ["p1"], "m")].slice(-6), ["commit-tree", "t", "-p", "p1", "-m", "m"])
})

test("legacySelection reads the old list, the old single vault, or the open one", () => {
  const known = [{ path: "/v/Alpha", open: false }, { path: "/v/Beta", open: true }]
  assert.deepEqual([...Safe.legacySelection({ vaults: ["/v/Alpha", "/v/Beta", "/v/Alpha", "/w/Alpha", "rel", "/v/.x"] }, known)],
                   ["/v/Alpha", "/v/Beta"])
  assert.deepEqual([...Safe.legacySelection({ vaults: [] }, known)], [])
  assert.deepEqual([...Safe.legacySelection({ vault: "/v/Alpha" }, known)], ["/v/Alpha"])
  assert.deepEqual([...Safe.legacySelection({}, known)], ["/v/Beta"])
  assert.deepEqual([...Safe.legacySelection(null, [])], [])
  assert.equal(Safe.vaultName("/home/u/My Notes"), "My Notes")
})

test("the repository file maps each repository to its vaults", () => {
  const text = JSON.stringify({ version: 1, migrated: true, repos: {
    "https://github.com/chyld/ddd": { vaults: ["/v/Alpha", "/v/Beta", "/w/Beta", "bad"] },
    "https://github.com/chyld/eee.git": { vaults: [] },
    "http://evil.example/x": { vaults: ["/v/Alpha"] },
    "https://github.com/chyld/fff": "nope" } })
  const config = Safe.repoConfig(text)
  assert.equal(config.migrated, true)
  assert.deepEqual([...Safe.selectionFor(config, "https://github.com/chyld/ddd.git")], ["/v/Alpha", "/v/Beta"])
  assert.deepEqual([...Safe.selectionFor(config, "https://github.com/chyld/eee")], [])
  assert.equal(Safe.knowsRepo(config, "https://github.com/chyld/eee"), true)
  assert.deepEqual([...Safe.selectionFor(config, "https://github.com/chyld/new")], [])
  assert.equal(Safe.knowsRepo(config, "https://github.com/chyld/new"), false)
  assert.equal(Object.keys(config.repos).length, 2)

  const next = JSON.parse(Safe.repoConfigText(config, "https://github.com/chyld/new/", { vaults: ["/v/Gamma"] }))
  assert.deepEqual(next, { version: 1, migrated: true, repos: {
    "https://github.com/chyld/ddd": { vaults: ["/v/Alpha", "/v/Beta"] },
    "https://github.com/chyld/eee": { vaults: [] },
    "https://github.com/chyld/new": { vaults: ["/v/Gamma"] } } })

  for (const bad of ["", "{", "[]", '{"repos":[]}', "null"]) {
    const c = Safe.repoConfig(bad)
    assert.equal(c.migrated, false)
    assert.equal(Object.keys(c.repos).length, 0)
  }
})

test("syncRefs gives each repository its own refs", () => {
  assert.equal(Safe.syncRefs("https://github.com/chyld/notes"), "refs/vault-sync/chyld/notes")
  assert.equal(Safe.syncRefs("https://github.com/chyld/ddd.git"), "refs/vault-sync/chyld/ddd")
  assert.equal(Safe.syncRefs("https://github.com/chyld/.github"), "refs/vault-sync/chyld/_.github")
  assert.equal(Safe.syncRefs("https://github.com/chyld/x.lock"), "refs/vault-sync/chyld/_x.lock")
  assert.equal(Safe.syncRefs("nope"), "")
})

test("the repository file keeps when each repository and vault last synced", () => {
  const d = new Date(2026, 8, 23, 22, 15, 4)
  let text = Safe.repoConfigText(Safe.repoConfig(""), "https://github.com/chyld/ddd", { vaults: ["/v/Zeta", "/v/Eta"] }, true)
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
