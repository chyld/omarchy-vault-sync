import QtQuick
import Quickshell
import Quickshell.Io
import "Safe.js" as Safe
import "Commands.js" as Commands

// Vault Sync: Obsidian vaults kept in step with a GitHub repository, each
// vault in its own Vaults/<name>/ folder.
//
// This service holds the state and drives two helpers; the popup
// (Settings.qml) only shows it and calls start(), setRepoUrl() and
// toggleVault().
//
//   Service.qml    state, the repository file, and running the helpers
//   Settings.qml   the bar icon and its popup
//   Logo.qml       the mark, changing with the sync state
//   Runner.qml     runs one command at a time: deadline, byte budget,
//                  minimal environment
//   engine.py      every git operation: status and sync, as JSON lines
//   files.py       every file read or written outside a vault
//   Commands.js    every command the shell runs
//   Safe.js        validation of everything that is not a literal
//
// Nothing touches the network except Sync now and the one anonymous check
// of whether the repository is public.
Item {
  id: sync

  property var shell: null
  property var manifest: null

  readonly property string pluginId: manifest && manifest.id ? String(manifest.id) : "chyld.vault-sync"
  readonly property string omarchyRoot: String(Quickshell.env("OMARCHY_PATH") || "")
  readonly property string home: String(Quickshell.env("HOME") || "")

  // The helpers, next to this file.
  function helper(name) {
    var url = String(Qt.resolvedUrl(name))
    return url.indexOf("file://") === 0 ? Safe.vaultPath(decodeURIComponent(url.slice(7))) : ""
  }
  readonly property string filesScript: sync.helper("files.py")
  readonly property string engineScript: sync.helper("engine.py")

  // ------------------------------------------------------------ files

  // Read through files.py: opened once without following a symlink, checked,
  // size-limited. The FileViews below only watch for changes; they never read.
  property string obsidianText: ""   // ~/.config/obsidian/obsidian.json
  property string themeText: ""      // the theme's colors.toml
  property string reposText: ""      // ~/.config/vault-sync/repos.json
  property bool reposReady: false
  property int reposWrites: 0        // writes not yet on disk

  Runner { id: io }
  property var ioQueue: []

  // One files.py command at a time; a read already queued is not queued twice.
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
    }, job.stdin)
    if (!started) { job.done(-1, "", ""); Qt.callLater(sync.ioNext) }
  }

  // A missing or refused file (a symlink, a FIFO, too large) reads as empty.
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
  }

  // Obsidian's own vault list: the tree in the popup.
  readonly property var vaults: Safe.vaults(sync.obsidianText)

  // The theme's yellow, for notes changed since the last sync.
  readonly property color dirtyColor: Safe.themeColor(sync.themeText, ["yellow", "color3"], "#e0af68")

  // ------------------------------------------------------------ repository file

  // ~/.config/vault-sync/repos.json is the one place the repository in use,
  // the vaults ticked for each repository and their sync times are kept.
  // Only this service writes it, so every popup (one per monitor's bar)
  // shows the same thing.
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

  // The repository in use. Older versions kept it on the bar entry in
  // shell.json; that is read (never written) until the file names one.
  readonly property string legacyRepoUrl: {
    var cfg = sync.shell && sync.shell.barConfig ? sync.shell.barConfig : null
    var layout = cfg && cfg.layout ? cfg.layout : null
    var sections = ["left", "center", "right"]
    for (var s = 0; layout && s < sections.length; s++) {
      var list = layout[sections[s]]
      for (var i = 0; Array.isArray(list) && i < list.length && i < 200; i++) {
        var entry = list[i]
        if (entry && typeof entry === "object" && entry.id === sync.pluginId && typeof entry.repoUrl === "string")
          return entry.repoUrl
      }
    }
    return ""
  }
  readonly property string repoUrl: Safe.repoUrl(sync.repoConfig.current || sync.legacyRepoUrl)

  function setRepoUrl(value) {
    var page = Safe.repoPage(value)
    if (page === Safe.repoPage(sync.repoUrl) && sync.repoConfig.current === page) return
    if (sync.syncing) return
    sync.writeRepoConfig(Safe.repoConfigText(sync.repoConfig, "", null, page))
  }

  // The vaults ticked for the repository in use.
  readonly property var selected: Safe.selectionFor(sync.repoConfig, sync.repoUrl)
  readonly property bool configured: sync.repoUrl !== "" && sync.selected.length > 0

  function toggleVault(path) {
    if (!sync.repoUrl || sync.syncing || !Safe.vaultPath(path)) return
    var list = sync.selected.slice()
    var i = list.indexOf(path)
    if (i === -1) list.push(path)
    else list.splice(i, 1)
    sync.writeRepoConfig(Safe.repoConfigText(sync.repoConfig, sync.repoUrl, { vaults: list }))
  }

  // When Sync now last finished for this repository, what it moved, and
  // when each vault last synced to it.
  readonly property var lastSync: Safe.lastSyncFor(sync.repoConfig, sync.repoUrl)
  readonly property string lastSummary: Safe.lastSummaryFor(sync.repoConfig, sync.repoUrl)
  function vaultSynced(path) {
    return Safe.vaultSyncedFor(sync.repoConfig, sync.repoUrl, path)
  }

  onSelectedChanged: sync.refresh()
  // Another repository has its own sync history: forget what was shown for
  // the old one at once, then read it again for the new one.
  onRepoUrlChanged: { sync.states = ({}); sync.warnings = []; sync.checkVisibility(); sync.refresh() }

  // ------------------------------------------------------------ state

  // Per vault, by path: { isRepo, changes, unpushed, conflictCopies,
  // conflictCount, lastPushed, error }. Replaced as a whole on every change,
  // so bindings follow it.
  property var states: ({})

  function state(path) {
    var st = sync.states[path]
    return st ? st : { isRepo: false, changes: 0, unpushed: 0, conflictCopies: [], conflictCount: 0,
                       lastPushed: null, error: "" }
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

  function unsynced(st) {
    return !st.isRepo || !st.lastPushed || st.changes > 0 || st.unpushed > 0
  }

  // A vault's own phase, as the bar icon would show it.
  function vaultPhase(path) {
    var st = sync.state(path)
    if (sync.syncingVault === path) return "syncing"
    if (st.error) return "error"
    if (st.conflictCount > 0) return "conflict"
    if (sync.unsynced(st)) return "changes"
    return "synced"
  }

  // Across the selected vaults: the first error, and the totals.
  readonly property var totals: {
    var t = { error: "", errorVault: "", changes: 0, unsynced: 0, conflicts: 0, lastPushed: null }
    for (var i = 0; i < sync.selected.length; i++) {
      var path = sync.selected[i]
      var st = sync.state(path)
      if (st.error && !t.error) { t.error = st.error; t.errorVault = Safe.vaultName(path) }
      t.changes += st.changes
      if (sync.unsynced(st)) t.unsynced++
      t.conflicts += st.conflictCount
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

  // ------------------------------------------------------------ local status

  Runner { id: local }
  property bool refreshAgain: false

  // The local state of every selected vault, from one engine run: no
  // network, nothing changed. Asked again once if asked while running.
  function refresh() {
    if (sync.syncing || !sync.engineScript) return
    var vaults = (sync.selected || []).slice()
    if (vaults.length === 0) return
    if (local.running) { sync.refreshAgain = true; return }
    var url = sync.repoUrl
    local.run(Commands.status(sync.engineScript, url, vaults), 300000, function() {
      if (sync.refreshAgain) { sync.refreshAgain = false; Qt.callLater(sync.refresh) }
    }, null, function(line) {
      var e = Safe.engineEvent(line, vaults)
      // A result for a repository that is no longer the one in use is dropped.
      if (!e || e.event !== "status" || url !== sync.repoUrl || sync.syncing) return
      sync.setState(e.vault, { isRepo: e.isRepo, changes: e.changes, unpushed: e.unpushed,
                               conflictCopies: e.conflictCopies, conflictCount: e.conflictCount,
                               lastPushed: e.lastPushed })
    })
  }

  // Every five minutes, and when the popup opens, after every sync and when
  // the selection changes.
  Timer {
    interval: 300000
    repeat: true
    running: sync.selected.length > 0
    triggeredOnStart: true
    onTriggered: sync.refresh()
  }

  // ------------------------------------------------------------ visibility

  // The repository's visibility: "" (unknown), "checking", "public" or "private".
  property string visibility: ""
  property string visibilityUrl: ""

  Runner { id: probe }

  // Asks GitHub, without logging in, whether the repository is public. Once
  // per repository per session, unless the answer didn't come back.
  function checkVisibility() {
    var url = sync.repoUrl
    if (!url) { sync.visibility = ""; sync.visibilityUrl = ""; return }
    if (url === sync.visibilityUrl && sync.visibility !== "") return
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

  property bool syncing: false
  property string syncingVault: ""   // the vault the engine is on
  property string stage: ""          // what it is doing there
  property int syncIndex: 0          // that vault's place in the run, 1-based
  property int syncTotal: 0
  property var warnings: []          // files over 50 MB in the last run
  property var run: null

  // The steps of the running sync, [{ text }]; the last is the one in
  // progress, shown at the bottom of the popup. Cleared when the sync ends:
  // results show in the header and on each vault's row.
  property var activity: []

  // Sync now: every selected vault in turn, in one engine run. One failing
  // doesn't stop the others; each keeps its own error until its next sync.
  function start() {
    var vaults = sync.selected.slice()
    var argv = Commands.sync(sync.engineScript, sync.repoUrl, vaults)
    if (sync.syncing || runner.running || !sync.configured || !argv || !sync.engineScript) return
    sync.syncing = true
    sync.activity = []
    sync.syncIndex = 0
    sync.syncTotal = vaults.length
    sync.run = { url: sync.repoUrl, vaults: vaults, sent: 0, received: 0, conflicts: 0, warnings: [],
                 synced: {}, reported: {} }
    // A whole run is bounded: the engine's own deadlines are per git command.
    var started = runner.run(argv, 600000 * vaults.length, sync.finished, null, sync.onEvent)
    if (!started) sync.finished(-1, "", "Couldn't start the sync.")
  }

  function onEvent(line) {
    var run = sync.run
    var e = run ? Safe.engineEvent(line, run.vaults) : null
    if (!e || e.event === "end") return
    if (e.vault !== sync.syncingVault) {
      sync.syncingVault = e.vault
      sync.syncIndex = run.vaults.indexOf(e.vault) + 1
      sync.setState(e.vault, { error: "" })
    }
    if (e.event === "step") {
      sync.stage = e.text
      var list = sync.activity.slice(-20)
      list.push({ text: Safe.vaultName(e.vault) + " · " + e.text })
      sync.activity = list
    } else if (e.event === "done") {
      run.reported[e.vault] = true
      run.synced[e.vault] = new Date()
      run.sent += e.sent
      run.received += e.received
      run.conflicts += e.conflicts.length
      for (var i = 0; i < e.warnings.length; i++) run.warnings.push(Safe.vaultName(e.vault) + "/" + e.warnings[i])
      sync.setState(e.vault, { error: "" })
    } else if (e.event === "error") {
      run.reported[e.vault] = true
      sync.setState(e.vault, { error: e.message })
    }
  }

  function finished(code, out, err) {
    var run = sync.run
    sync.run = null
    sync.syncing = false
    sync.syncingVault = ""
    sync.stage = ""
    sync.activity = []
    if (!run) return
    // A vault the engine never reported on (it was stopped, or failed to
    // start) gets a reason.
    var reason = code === 124 || /timed out/.test(err) ? "The sync took too long and was stopped."
      : "The sync stopped unexpectedly."
    for (var i = 0; i < run.vaults.length; i++)
      if (!run.reported[run.vaults[i]]) sync.setState(run.vaults[i], { error: reason })
    sync.warnings = run.warnings.slice(0, 20)
    // Kept in the repository file so it survives a restart, but only when
    // at least one vault synced.
    if (Object.keys(run.synced).length > 0)
      sync.writeRepoConfig(Safe.repoConfigText(sync.repoConfig, run.url,
        { lastSync: new Date(), lastSummary: Safe.summary(run.sent, run.received, run.conflicts), synced: run.synced }))
    Qt.callLater(sync.refresh)
  }

  function openRepo() {
    var argv = Commands.openUrl(sync.omarchyRoot, sync.repoUrl)
    if (argv) Quickshell.execDetached(argv)
  }
}
