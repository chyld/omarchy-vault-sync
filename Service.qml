import QtQuick
import Quickshell
import Quickshell.Io
import "Defaults.js" as Defaults
import "Safe.js" as Safe
import "Commands.js" as Commands

// Vault Sync: an Obsidian vault kept in step with a GitHub repository.
//
// Nothing touches the network until Sync now is pressed. A sync commits the
// vault's notes, merges what other devices pushed, and pushes the result.
// When a note changed on both sides, GitHub's version keeps the name and
// this machine's version is saved beside it as "note (conflict <time>).md",
// so the sync always finishes and nothing is lost. It never force-pushes
// and never resets.
//
//   Service.qml    settings, the repository file, local status, the sync itself
//   Settings.qml   the bar icon and its popup
//   Logo.qml       the mark, changing with the sync state
//   Runner.qml     runs one command at a time, with a deadline
//   Commands.js    every command Vault Sync runs
//   Safe.js        validation and parsing of everything that is not a literal
Item {
  id: sync

  property var shell: null
  property var manifest: null

  readonly property string pluginId: manifest && manifest.id ? String(manifest.id) : "chyld.vault-sync"
  readonly property string omarchyRoot: String(Quickshell.env("OMARCHY_PATH") || "")
  readonly property string home: String(Quickshell.env("HOME") || "")

  // ------------------------------------------------------------ settings

  // Settings live on this plugin's bar entry in shell.json, saved by the host
  // when the popup changes them. The bar icon hands its current settings
  // straight to this service; without it, the host's copy of the bar config
  // is used.
  property var pushedSettings: null

  readonly property var settings: {
    if (sync.pushedSettings && typeof sync.pushedSettings === "object") return sync.pushedSettings
    var cfg = sync.shell && sync.shell.barConfig ? sync.shell.barConfig : null
    var layout = cfg && cfg.layout ? cfg.layout : null
    if (!layout) return ({})
    var sections = ["left", "center", "right"]
    for (var s = 0; s < sections.length; s++) {
      var list = layout[sections[s]]
      if (!Array.isArray(list)) continue
      for (var i = 0; i < list.length && i < 200; i++) {
        var entry = list[i]
        if (entry && typeof entry === "object" && entry.id === sync.pluginId) return entry
      }
    }
    return ({})
  }

  function setting(key) {
    var v = sync.settings[key]
    return (v === undefined || v === null) ? Defaults.values[key] : v
  }

  // ------------------------------------------------------------ files

  // Files outside the vaults are read and written only through files.py,
  // which opens each one with O_NOFOLLOW, checks the descriptor and caps the
  // size, and writes repos.json 0600 in a 0700 directory. The FileViews
  // below only watch for changes; they never read.
  readonly property string filesScript: {
    var url = String(Qt.resolvedUrl("files.py"))
    return url.indexOf("file://") === 0 ? Safe.vaultPath(decodeURIComponent(url.slice(7))) : ""
  }

  property string obsidianText: ""   // ~/.config/obsidian/obsidian.json
  property string themeText: ""      // the theme's colors.toml
  property string reposText: ""      // ~/.config/vault-sync/repos.json
  property bool reposReady: false
  property int reposWrites: 0        // writes not yet on disk

  Runner { id: io }
  property var ioQueue: []

  function ioRun(key, argv, stdin, done) {
    for (var i = 0; i < sync.ioQueue.length; i++) if (key && sync.ioQueue[i].key === key) return
    sync.ioQueue = sync.ioQueue.concat([{ key: key, argv: argv, stdin: stdin, done: done }])
    if (!io.running) sync.ioNext()
  }

  function ioNext() {
    if (sync.ioQueue.length === 0 || io.running) return
    var job = sync.ioQueue[0]
    sync.ioQueue = sync.ioQueue.slice(1)
    var started = io.run(job.argv, 10000, function(code, out, err) {
      job.done(code, out, err)
      Qt.callLater(sync.ioNext)
    }, job.stdin === null ? undefined : job.stdin)
    if (!started) { job.done(-1, "", ""); Qt.callLater(sync.ioNext) }
  }

  // Reads one of the files files.py knows into its property. A missing file
  // reads as empty; a refused one (a symlink, a FIFO, too large) as empty too.
  function readFile(what) {
    if (!sync.filesScript) return
    sync.ioRun("read:" + what, Commands.readFile(sync.filesScript, what), null, function(code, out) {
      var text = code === 0 ? out : ""
      if (what === "obsidian") sync.obsidianText = text
      else if (what === "theme") sync.themeText = text
      else if (what === "repos") {
        // A read queued before a write would bring back the old contents.
        if (sync.reposWrites === 0) sync.reposText = text
        sync.reposReady = true
      }
    })
  }

  // Watchers only: they say a file changed, and files.py reads it.
  FileView {
    path: sync.home ? sync.home + "/.config/obsidian/obsidian.json" : ""
    preload: false
    blockAllReads: true
    watchChanges: true
    printErrors: false
    onFileChanged: sync.readFile("obsidian")
  }

  FileView {
    path: sync.home ? sync.home + "/.local/state/omarchy/current/theme/colors.toml" : ""
    preload: false
    blockAllReads: true
    watchChanges: true
    printErrors: false
    onFileChanged: sync.readFile("theme")
  }

  FileView {
    id: reposWatch
    path: sync.home ? sync.home + "/.config/vault-sync/repos.json" : ""
    preload: false
    blockAllReads: true
    watchChanges: true
    printErrors: false
    onFileChanged: sync.readFile("repos")
  }

  Component.onCompleted: {
    sync.readFile("obsidian")
    sync.readFile("theme")
    sync.readFile("repos")
    sync.checkVisibility()
  }

  // Obsidian's own vault list: the tree in the popup.
  readonly property var vaults: Safe.vaults(sync.obsidianText)

  // The theme's yellow, for notes changed since the last sync.
  readonly property color dirtyColor: Safe.themeColor(sync.themeText, ["yellow", "color3"], "#e0af68")

  readonly property string repoUrl: Safe.repoUrl(String(sync.setting("repoUrl") || ""))

  // ------------------------------------------------------------ repository file

  // Which vaults sync to which repository lives in its own file, outside
  // the plugin and shell.json, so every repository remembers its vaults:
  // switching to a known URL ticks its vaults again, and a new URL starts
  // with none ticked.
  readonly property var repoConfig: Safe.repoConfig(sync.reposText)

  function writeRepoConfig(text) {
    if (!sync.filesScript || !sync.reposReady) return
    sync.reposText = text   // shown at once, before the write lands
    sync.reposWrites++
    sync.ioRun("", Commands.writeRepos(sync.filesScript), text, function() {
      sync.reposWrites--
      // Watch the file again: a watch set up before it existed may not fire.
      reposWatch.path = ""
      reposWatch.path = sync.home + "/.config/vault-sync/repos.json"
    })
  }

  // The vaults synced to the chosen repository, each in its own
  // Vaults/<name>/.
  readonly property var selected: Safe.selectionFor(sync.repoConfig, sync.repoUrl)
  readonly property bool configured: sync.repoUrl !== "" && sync.selected.length > 0

  // When a vault last synced to the chosen repository, or null.
  function vaultSynced(path) {
    return Safe.vaultSyncedFor(sync.repoConfig, sync.repoUrl, path)
  }

  // Ticks or unticks a vault for the chosen repository.
  function toggleVault(path) {
    if (!sync.repoUrl || sync.syncing || !Safe.vaultPath(path)) return
    var list = sync.selected.slice()
    var i = list.indexOf(path)
    if (i === -1) list.push(path)
    else list.splice(i, 1)
    sync.writeRepoConfig(Safe.repoConfigText(sync.repoConfig, sync.repoUrl, { vaults: list }))
  }

  onSelectedChanged: sync.refresh()
  // A different repository has its own sync history: forget what was shown
  // for the old one at once, then read it again for the new one.
  onRepoUrlChanged: { sync.states = ({}); sync.checkVisibility(); sync.refresh() }

  // ------------------------------------------------------------ state

  property bool syncing: false
  property string stage: ""            // what the running sync is doing
  // When Sync now last finished for this repository, and what it moved
  // (e.g. "\u21913 \u21932"), from the repository file.
  readonly property var lastSync: Safe.lastSyncFor(sync.repoConfig, sync.repoUrl)
  readonly property string lastSummary: Safe.lastSummaryFor(sync.repoConfig, sync.repoUrl)
  property var warnings: []            // large files it found

  // Per vault, by path: { isRepo, changes, unpushed, conflictCopies,
  // lastPushed, error }. Replaced as a whole on every change, so bindings
  // follow it.
  property var states: ({})

  function state(path) {
    var st = sync.states[path]
    return st ? st : { isRepo: false, changes: [], unpushed: 0, conflictCopies: [], lastPushed: null, error: "" }
  }

  function setState(path, patch) {
    var all = {}
    for (var k in sync.states) all[k] = sync.states[k]
    var next = {}
    var old = sync.state(path)
    for (var o in old) next[o] = old[o]
    for (var p in patch) next[p] = patch[p]
    all[path] = next
    sync.states = all
  }

  function clearErrors() {
    for (var i = 0; i < sync.selected.length; i++) sync.setState(sync.selected[i], { error: "" })
  }

  // A vault's own phase, as the bar icon would show it.
  function vaultPhase(path) {
    var st = sync.state(path)
    if (sync.job && sync.job.vault === path) return "syncing"
    if (st.error) return "error"
    if (st.conflictCopies.length > 0) return "conflict"
    if (!st.isRepo || !st.lastPushed || st.changes.length > 0 || st.unpushed > 0) return "changes"
    return "synced"
  }

  // Across the selected vaults: the first error, and the totals.
  readonly property var totals: {
    var t = { error: "", errorVault: "", changes: 0, unsynced: 0, conflicts: 0, lastPushed: null }
    for (var i = 0; i < sync.selected.length; i++) {
      var path = sync.selected[i]
      var st = sync.state(path)
      if (st.error && !t.error) { t.error = st.error; t.errorVault = Safe.vaultName(path) }
      t.changes += st.changes.length
      if (!st.isRepo || !st.lastPushed || st.changes.length > 0 || st.unpushed > 0) t.unsynced++
      t.conflicts += st.conflictCopies.length
      if (st.lastPushed && (!t.lastPushed || st.lastPushed > t.lastPushed)) t.lastPushed = st.lastPushed
    }
    return t
  }

  // "setup" | "syncing" | "error" | "conflict" | "changes" | "synced"
  readonly property string phase: {
    if (sync.syncing) return "syncing"
    if (!sync.configured) return "setup"
    if (sync.totals.error) return "error"
    if (sync.totals.conflicts > 0) return "conflict"
    if (sync.totals.unsynced > 0) return "changes"
    return "synced"
  }

  // The repository's visibility: "" (unknown), "checking", "public" or "private".
  property string visibility: ""
  property string visibilityUrl: ""

  // ------------------------------------------------------------ local status

  Runner { id: local }

  property var refreshQueue: []

  // Local only, for every selected vault in turn: git status, commits not
  // yet synced, conflict copies, and when it last reached GitHub. Nothing
  // here touches the network or changes a vault.
  function refresh() {
    if (sync.syncing) return
    // Called while the service is still being built: nothing to do yet.
    var selected = sync.selected || []
    var queue = (sync.refreshQueue || []).slice()
    for (var i = 0; i < selected.length; i++)
      if (queue.indexOf(selected[i]) === -1) queue.push(selected[i])
    sync.refreshQueue = queue
    if (!local.running) sync.refreshNext()
  }

  function refreshNext() {
    if (sync.refreshQueue.length === 0 || sync.syncing) { sync.refreshQueue = []; return }
    var vault = sync.refreshQueue[0]
    sync.refreshQueue = sync.refreshQueue.slice(1)
    var url = sync.repoUrl
    var refs = Safe.syncRefs(url)
    // A result for a repository that is no longer the chosen one is dropped.
    var done = function(patch) {
      if (url === sync.repoUrl) sync.setState(vault, patch)
      Qt.callLater(sync.refreshNext)
    }
    local.run(Commands.showPrefix(vault), 10000, function(code, out) {
      if (code !== 0 || out.trim() !== "") return done({ isRepo: false, changes: [], unpushed: 0, conflictCopies: [], lastPushed: null })
      local.run(Commands.status(vault), 30000, function(code, out) {
        var changes = code === 0 ? Safe.status(out) : []
        if (!refs) return done({ isRepo: true, changes: changes, unpushed: 0, conflictCopies: [], lastPushed: null })
        local.run(Commands.unpushed(vault, refs), 10000, function(code, out) {
          var n = Number(out.trim())
          var unpushed = code === 0 && isFinite(n) ? n : 0
          local.run(Commands.conflictCopies(vault), 10000, function(code, out) {
            var copies = code === 0 ? Safe.nulPaths(out).filter(Safe.isConflictCopy) : []
            local.run(Commands.lastPushed(vault, refs), 10000, function(code, out) {
              var t = Number(out.trim())
              done({ isRepo: true, changes: changes, unpushed: unpushed, conflictCopies: copies,
                     lastPushed: code === 0 && t > 0 && isFinite(t) ? new Date(t * 1000) : null })
            })
          })
        })
      })
    })
  }

  // Local changes are checked every five minutes, and also when the popup
  // opens, after every sync and when the selection changes.
  Timer {
    interval: 300000
    repeat: true
    running: sync.selected.length > 0
    triggeredOnStart: true
    onTriggered: sync.refresh()
  }

  // ------------------------------------------------------------ visibility

  Runner { id: probe }

  // Asks GitHub, without logging in, whether the repository is public.
  function checkVisibility() {
    var url = sync.repoUrl
    if (!url) { sync.visibility = ""; sync.visibilityUrl = ""; return }
    if (url === sync.visibilityUrl && (sync.visibility === "public" || sync.visibility === "private")) return
    if (probe.running) { visibilityRetry.restart(); return }
    sync.visibilityUrl = url
    sync.visibility = "checking"
    probe.run(Commands.visibility(url), 15000, function(code, out) {
      if (url !== sync.repoUrl) { sync.checkVisibility(); return }
      var status = out.trim()
      sync.visibility = code !== 0 ? "" : status === "200" ? "public" : status === "404" ? "private" : ""
    })
  }

  Timer { id: visibilityRetry; interval: 500; onTriggered: sync.checkVisibility() }

  // ------------------------------------------------------------ sync

  Runner { id: runner }

  // The sync in progress: its inputs and what it found along the way.
  property var job: null

  // One step: run `argv`, then `next(code, out, err)`. Network steps get
  // longer deadlines.
  function step(label, argv, timeoutMs, next) {
    var job = sync.job
    if (!job) return
    if (label) {
      var text = Safe.vaultName(job.vault) + " \u00b7 " + label
      if (text !== sync.stage) { sync.stage = text; sync.log(text, "step") }
    }
    if (!runner.run(argv, timeoutMs, function(code, out, err) {
      if (sync.job !== job) return
      next(code, out, err)
    })) sync.fail("Couldn't run git.")
  }

  // Sync now: every selected vault in turn. One failing doesn't stop the
  // others; each keeps its own error until its next sync.
  property var queue: []
  property var run: null
  // Progress through the vaults of the running sync: the one in progress
  // (1-based) of how many.
  property int syncIndex: 0
  property int syncTotal: 0

  function start() {
    if (sync.syncing || runner.running || !sync.configured) return
    sync.activity = []
    sync.syncing = true
    sync.refreshQueue = []
    sync.queue = sync.selected.slice()
    sync.syncTotal = sync.queue.length
    sync.syncIndex = 0
    sync.run = { url: sync.repoUrl, sent: [], received: [], conflicts: [], warnings: [], synced: {} }
    sync.syncNext()
  }

  function syncNext() {
    if (sync.queue.length === 0) return sync.allDone()
    var vault = sync.queue[0]
    sync.queue = sync.queue.slice(1)
    sync.syncIndex = sync.syncTotal - sync.queue.length
    var folder = Safe.vaultFolder(vault)
    sync.setState(vault, { error: "" })
    sync.job = { vault: vault, url: sync.repoUrl, refs: Safe.syncRefs(sync.repoUrl), folder: folder, date: new Date(), remote: null, branch: "",
                 merging: false, merged: false, retried: false, conflicts: [], warnings: [],
                 before: null, remoteTip: "", pushed: "" }
    if (!folder) return sync.fail("Rename the vault folder to letters, digits, spaces, dots, dashes or underscores.")
    sync.checkRemote()
  }

  function allDone() {
    var run = sync.run
    sync.job = null
    sync.run = null
    sync.syncing = false
    sync.stage = ""
    sync.warnings = run.warnings
    // Kept in the repository file, so it survives a restart.
    var summary = Safe.syncSummary(run.sent, run.received, run.conflicts, run.warnings).short
    sync.writeRepoConfig(Safe.repoConfigText(sync.repoConfig, run.url,
      { lastSync: new Date(), lastSummary: summary, synced: run.synced }))
    sync.activity = []
    Qt.callLater(sync.refresh)
  }

  // 1. Can GitHub be reached, and what is on it?
  function checkRemote() {
    var job = sync.job
    sync.step("Contacting GitHub", Commands.remoteRefs(job.vault, job.url), 60000, function(code, out, err) {
      if (code !== 0) return sync.fail(Safe.gitError(err))
      job.remote = Safe.remoteRefs(out)
      sync.ensureRepo()
    })
  }

  // 2. The vault gets its own repository the first time.
  function ensureRepo() {
    var job = sync.job
    sync.step("Checking the vault", Commands.showPrefix(job.vault), 10000, function(code, out, err) {
      if (code === 0 && out.trim() === "") return sync.ensureRemote()
      if (code !== 0 && !/not a git repository/i.test(err)) return sync.fail(Safe.gitError(err))
      // Not a repository, or inside another one: start the vault's own.
      var branch = job.remote.head || "main"
      sync.step("Setting up git", Commands.init(job.vault, branch), 10000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        sync.ensureRemote()
      })
    })
  }

  // 3. origin points at the configured repository.
  function ensureRemote() {
    var job = sync.job
    sync.step("", Commands.remoteUrl(job.vault), 10000, function(code, out) {
      var current = out.trim()
      if (code === 0 && current === job.url) return sync.clearMerge()
      var argv = code === 0 ? Commands.setRemote(job.vault, job.url) : Commands.addRemote(job.vault, job.url)
      sync.step("", argv, 10000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        sync.clearMerge()
      })
    })
  }

  // 4. A merge left by an interrupted sync is abandoned. Its local side was
  // committed first, so nothing is lost.
  function clearMerge() {
    var job = sync.job
    sync.step("", Commands.mergeInProgress(job.vault), 10000, function(code) {
      if (code !== 0) return sync.pickBranch()
      sync.step("", Commands.abortMerge(job.vault), 30000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        sync.pickBranch()
      })
    })
  }

  // 5. Sync with GitHub's default branch, or main in an empty repository.
  function pickBranch() {
    var job = sync.job
    sync.step("", Commands.currentBranch(job.vault), 10000, function(code, out) {
      if (!Safe.branchName(out.trim())) return sync.fail("The vault's git repository isn't on a branch.")
      job.branch = job.remote.head || "main"
      sync.checkSizes()
    })
  }

  // 6. GitHub refuses files over 100 MB and warns over 50 MB.
  function checkSizes() {
    var job = sync.job
    sync.step("Checking file sizes", Commands.largeFiles(job.vault), 60000, function(code, out, err) {
      var large = Safe.sizedPaths(out).filter(function(f) { return f.size >= Safe.WARN_BYTES })
      if (large.length === 0) return sync.commitLocal()
      var paths = large.map(function(f) { return f.path })
      sync.step("", Commands.ignored(job.vault, paths), 10000, function(code, out) {
        var skip = code === 0 ? Safe.nulPaths(out) : []
        var tooBig = []
        for (var i = 0; i < large.length; i++) {
          if (skip.indexOf(large[i].path) !== -1) continue
          if (large[i].size >= Safe.LIMIT_BYTES) tooBig.push(large[i].path)
          else job.warnings.push(large[i].path)
        }
        if (tooBig.length > 0)
          return sync.fail("Too large for GitHub (over 100 MB): " + tooBig.slice(0, 3).join(", ") + (tooBig.length > 3 ? " and more" : ""))
        sync.commitLocal()
      })
    })
  }

  // 7. Commit this machine's changes.
  function commitLocal() {
    var job = sync.job
    sync.step("Saving your changes", Commands.addAll(job.vault), 60000, function(code, out, err) {
      if (code !== 0) return sync.fail(Safe.gitError(err))
      sync.step("", Commands.staged(job.vault), 30000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        var files = Safe.nulPaths(out)
        if (files.length === 0) return sync.fetchRemote()
        sync.step("", Commands.commit(job.vault, Safe.commitMessage(files, job.date)), 60000, function(code, out, err) {
          if (code !== 0) return sync.fail(Safe.gitError(err))
          sync.fetchRemote()
        })
      })
    })
  }

  // 8. Bring in what other devices pushed to this vault's folder. An empty
  // repository, or one without the branch yet, has nothing to bring in.
  function fetchRemote() {
    var job = sync.job
    // This machine's commit before anything came in, to count what did.
    if (job.before === null) {
      return sync.step("", Commands.commitId(job.vault, "HEAD"), 10000, function(code, out) {
        job.before = code === 0 ? out.trim() : ""
        sync.fetchRemote()
      })
    }
    if (job.remote.branches.indexOf(job.branch) === -1) { job.remoteTip = ""; return sync.buildRemote() }
    sync.step("Getting changes from GitHub", Commands.fetch(job.vault, job.branch), 120000, function(code, out, err) {
      if (code !== 0) return sync.fail(Safe.gitError(err))
      sync.step("", Commands.commitId(job.vault, "refs/remotes/origin/" + job.branch), 10000, function(code, out) {
        job.remoteTip = code === 0 ? out.trim() : ""
        if (!job.remoteTip) return sync.fail("Couldn't read the repository's " + job.branch + " branch.")
        sync.incoming()
      })
    })
  }

  // GitHub's copy of this vault's folder, as a commit on top of the last
  // sync, so a normal merge brings in exactly what changed there. Before
  // the first sync it has no parent, and the merge joins the two.
  function incoming() {
    var job = sync.job
    sync.step("", Commands.treeOf(job.vault, job.remoteTip, job.folder), 10000, function(code, out) {
      var theirs = code === 0 ? out.trim() : ""
      if (!theirs) return sync.buildRemote()   // the folder isn't on GitHub yet
      sync.step("", Commands.commitId(job.vault, Commands.baseRef(job.refs)), 10000, function(code, out) {
        var base = code === 0 ? out.trim() : ""
        var mergeIt = function() {
          var parents = base ? [base] : []
          sync.step("", Commands.commitTree(job.vault, theirs, parents, "Sync: " + job.folder + " on GitHub"), 10000, function(code, out, err) {
            if (code !== 0) return sync.fail(Safe.gitError(err))
            sync.mergeRemote(out.trim())
          })
        }
        if (!base) return mergeIt()
        sync.step("", Commands.treeOf(job.vault, base, ""), 10000, function(code, out) {
          if (code === 0 && out.trim() === theirs) return sync.buildRemote()   // unchanged since the last sync
          mergeIt()
        })
      })
    })
  }

  function mergeRemote(commit) {
    var job = sync.job
    job.merging = true
    job.merged = true
    sync.step("Merging", Commands.merge(job.vault, commit), 60000, function(code, out, err) {
      if (code === 0) { job.merging = false; return sync.buildRemote() }
      sync.step("", Commands.conflicted(job.vault), 30000, function(c, list) {
        var paths = c === 0 ? Safe.nulPaths(list) : []
        if (paths.length === 0) return sync.fail(Safe.gitError(err))
        sync.resolve(paths, 0)
      })
    })
  }

  // 9. Keep both sides of each conflicted note: GitHub's version keeps the
  // name, this machine's is saved beside it. When one side deleted the note
  // and the other edited it, the edit is kept.
  function resolve(paths, index) {
    var job = sync.job
    if (index >= paths.length) {
      return sync.step("", Commands.commitMerge(job.vault), 60000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        job.merging = false
        sync.buildRemote()
      })
    }
    var path = paths[index]
    var next = function() { sync.resolve(paths, index + 1) }
    sync.step("Keeping both versions of " + Safe.plain(path, 60), Commands.conflictStages(job.vault, path), 10000, function(code, out, err) {
      if (code !== 0) return sync.fail(Safe.gitError(err))
      var sides = Safe.conflictSides(out)
      if (sides.ours && sides.theirs) return sync.keepBoth(path, next)
      var argv = sides.theirs ? Commands.checkoutTheirs(job.vault, path)
               : sides.ours ? Commands.checkoutOurs(job.vault, path) : null
      var addIt = function() {
        sync.step("", Commands.add(job.vault, [path]), 10000, function(code, out, err) {
          if (code !== 0) return sync.fail(Safe.gitError(err))
          next()
        })
      }
      if (!argv) return addIt()
      sync.step("", argv, 10000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        addIt()
      })
    })
  }

  function keepBoth(path, next) {
    var job = sync.job
    sync.freeName(path, 1, function(copy) {
      sync.step("", Commands.checkoutOurs(job.vault, path), 10000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        sync.step("", Commands.move(job.vault, path, copy), 10000, function(code, out, err) {
          if (code !== 0) return sync.fail("Couldn't save your copy of " + Safe.plain(path, 80) + ".")
          sync.step("", Commands.checkoutTheirs(job.vault, path), 10000, function(code, out, err) {
            if (code !== 0) return sync.fail(Safe.gitError(err))
            sync.step("", Commands.add(job.vault, [path, copy]), 10000, function(code, out, err) {
              if (code !== 0) return sync.fail(Safe.gitError(err))
              job.conflicts.push(path)
              next()
            })
          })
        })
      })
    })
  }

  // The first conflict-copy name for `path` that is not taken.
  function freeName(path, n, done) {
    var job = sync.job
    var copy = Safe.conflictName(path, job.date, n)
    if (n > 20 || !Safe.relPath(copy)) return sync.fail("Couldn't name a copy of " + Safe.plain(path, 80) + ".")
    sync.step("", Commands.exists(job.vault, copy), 10000, function(code) {
      if (code === 0) sync.freeName(path, n + 1, done)
      else done(copy)
    })
  }

  // 10. The repository's new commit: GitHub's tree with this vault's folder
  // replaced by the vault, built in a separate index file.
  function buildRemote() {
    var job = sync.job
    sync.step("", Commands.hasHead(job.vault), 10000, function(code) {
      if (code !== 0) return sync.finish()   // an empty vault and nothing on GitHub
      sync.step("", Commands.stageTree(job.vault, job.remoteTip), 30000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        sync.step("", Commands.unstageFolder(job.vault, job.folder), 30000, function(code, out, err) {
          if (code !== 0) return sync.fail(Safe.gitError(err))
          sync.step("", Commands.stageHeadAt(job.vault, job.folder), 30000, function(code, out, err) {
            if (code !== 0) return sync.fail(Safe.gitError(err))
            sync.step("", Commands.writeStaged(job.vault), 30000, function(code, out, err) {
              if (code !== 0) return sync.fail(Safe.gitError(err))
              sync.pushTree(out.trim())
            })
          })
        })
      })
    })
  }

  // 11. Push. It never forces: when GitHub moved on during the sync, fetch
  // and merge once more.
  function pushTree(tree) {
    var job = sync.job
    var commitAndPush = function() {
      var parents = job.remoteTip ? [job.remoteTip] : []
      var message = "Sync " + job.folder + " " + Safe.stamp(job.date)
      sync.step("", Commands.commitTree(job.vault, tree, parents, message), 10000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        var commit = out.trim()
        sync.step("Sending to GitHub", Commands.push(job.vault, commit, job.branch), 120000, function(code, out, err) {
          if (code === 0) { job.pushed = commit; return sync.markSynced() }
          if (!job.retried && /rejected|fetch first|non-fast-forward/i.test(err)) {
            job.retried = true
            if (job.remote.branches.indexOf(job.branch) === -1) job.remote.branches.push(job.branch)
            return sync.fetchRemote()
          }
          sync.fail(Safe.gitError(err))
        })
      })
    }
    if (!job.remoteTip) return commitAndPush()
    sync.step("", Commands.treeOf(job.vault, job.remoteTip, ""), 10000, function(code, out) {
      if (code === 0 && out.trim() === tree) { job.pushed = job.remoteTip; return sync.markSynced() }   // nothing to send
      commitAndPush()
    })
  }

  // 12. Remember where this sync left the vault and GitHub.
  function markSynced() {
    var job = sync.job
    sync.step("", Commands.updateRef(job.vault, Commands.baseRef(job.refs), "HEAD"), 10000, function(code, out, err) {
      if (code !== 0) return sync.fail(Safe.gitError(err))
      sync.step("", Commands.updateRef(job.vault, Commands.pushedRef(job.refs), job.pushed), 10000, function(code, out, err) {
        if (code !== 0) return sync.fail(Safe.gitError(err))
        sync.step("", Commands.updateRef(job.vault, "refs/remotes/origin/" + job.branch, job.pushed), 10000, function() {
          sync.countChanges()
        })
      })
    })
  }

  // 13. What the sync did. Sent: this vault's folder on GitHub before and
  // after the push. Received: the vault before and after the merge.
  function countChanges() {
    var job = sync.job
    var sentArgv = job.remoteTip ? Commands.changedBetween(job.vault, job.remoteTip, job.pushed, job.folder)
                                 : Commands.allFiles(job.vault, job.pushed, job.folder)
    sync.step("", sentArgv, 30000, function(code, out) {
      job.sent = code === 0 ? Safe.inFolder(Safe.nulPaths(out), job.folder) : []
      if (!job.merged) { job.received = []; return sync.finish() }
      var receivedArgv = job.before ? Commands.changedBetween(job.vault, job.before, "HEAD", "")
                                    : Commands.allFiles(job.vault, "HEAD", "")
      sync.step("", receivedArgv, 30000, function(code, out) {
        job.received = code === 0 ? Safe.nulPaths(out) : []
        sync.finish()
      })
    })
  }

  function finish() {
    var job = sync.job
    var name = Safe.vaultName(job.vault)
    sync.job = null
    sync.stage = ""
    var sent = job.sent || []
    var received = job.received || []
    sync.run.sent = sync.run.sent.concat(sent)
    sync.run.received = sync.run.received.concat(received)
    sync.run.conflicts = sync.run.conflicts.concat(job.conflicts.map(function(p) { return name + "/" + p }))
    sync.run.warnings = sync.run.warnings.concat(job.warnings.map(function(p) { return name + "/" + p }))
    sync.run.synced[job.vault] = new Date()
    sync.setState(job.vault, { error: "" })
    Qt.callLater(sync.syncNext)
  }

  function fail(message) {
    var job = sync.job
    sync.job = null
    sync.stage = ""
    if (!job) return
    sync.setState(job.vault, { error: message })
    // Undo a half-finished merge. The local side was committed before it
    // started, and a copy already saved beside a note stays in the vault.
    if (job.merging) runner.run(Commands.abortMerge(job.vault), 30000, function() { sync.syncNext() })
    else Qt.callLater(sync.syncNext)
  }

  // ------------------------------------------------------------ activity

  // The steps of the running sync, [{ text, kind: "step" }]; the last is
  // the one in progress, shown at the bottom of the popup. Cleared when the
  // sync ends: results show in the header and on each vault's row.
  property var activity: []

  function log(text, kind) {
    var list = sync.activity.slice(-20)
    list.push({ text: Safe.plain(text, 200), kind: kind })
    sync.activity = list
  }

  function openRepo() {
    var argv = Commands.openUrl(sync.omarchyRoot, sync.repoUrl)
    if (argv) Quickshell.execDetached(argv)
  }
}
