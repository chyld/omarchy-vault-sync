import QtQuick
import Quickshell
import Quickshell.Io
import "Commands.js" as Commands

// Runs one command at a time and hands its exit code, stdout and stderr to
// a callback. The callback runs on the next tick, so it may start the next
// command straight away.
//
// Every command runs under /usr/bin/timeout in its own process group, so
// the deadline stops the command and everything it started (git's remote
// helpers, a credential helper) with TERM, then KILL two seconds later. A
// backstop timer does the same from here if timeout itself hangs, and on
// unload. Output is read in chunks under a budget; overflow stops the
// command and counts as failure. The budget counts characters, not bytes,
// so it is a second line of defence: the byte limits are at the source,
// in engine.py and files.py. The environment is not inherited: it is
// the minimal set Commands.environment() builds. A command that cannot
// start reports exit code -1.
Item {
  id: runner

  readonly property bool running: proc.running || runner.pending !== null
  property var pending: null
  property bool finished: true
  // Counts runs, so a late signal from an earlier command is ignored.
  property int generation: 0
  property string out: ""
  property string err: ""
  property bool overflow: false
  property int budget: 1048576
  property var stdinText: null
  // Streaming mode: stdout is handed to `onLine` one line at a time as it
  // arrives, instead of being collected. A line longer than lineMax stops
  // the command, like the byte budget.
  property var onLine: null
  property string partial: ""
  property int lineMax: 65536
  property int received: 0

  // `callback(code, stdout, stderr)`. `stdin`, when given, is written to the
  // command and then closed. With `lineHandler`, stdout goes to it line by
  // line and `callback` gets "" for stdout. Returns false when a command is
  // already running or argv is missing.
  function run(argv, timeoutMs, callback, stdin, lineHandler) {
    if (!argv || runner.running) return false
    var seconds = Math.max(1, Math.ceil((timeoutMs || 30000) / 1000))
    runner.pending = callback || function() {}
    runner.generation++
    runner.finished = false
    runner.out = ""
    runner.err = ""
    runner.overflow = false
    runner.stdinText = stdin === undefined || stdin === null ? null : String(stdin)
    runner.onLine = lineHandler || null
    runner.partial = ""
    runner.received = 0
    proc.stdinEnabled = runner.stdinText !== null
    proc.command = [Commands.TIMEOUT, "-k", "2", "--", seconds + "s"].concat(argv)
    proc.running = true
    backstop.interval = seconds * 1000 + 5000
    backstop.restart()
    return true
  }

  function complete(code, generation) {
    if (runner.finished || generation !== runner.generation) return
    runner.finished = true
    backstop.stop()
    kill.stop()
    var callback = runner.pending
    var failed = runner.overflow
    var out = failed ? "" : runner.out
    var err = code === 124 ? "timed out" : runner.err
    runner.out = ""
    runner.err = ""
    Qt.callLater(function() {
      runner.pending = null
      if (callback) callback(failed ? -1 : code, out, err)
    })
  }

  // Every byte counts against the budget, whether collected or streamed.
  function append(kind, chunk) {
    if (runner.overflow) return
    runner.received += chunk.length
    if (runner.received > runner.budget) return runner.overflowed("output too large")
    if (kind === "err") { runner.err += chunk; return }
    if (!runner.onLine) { runner.out += chunk; return }
    var lines = (runner.partial + chunk).split("\n")
    runner.partial = lines.pop()
    if (runner.partial.length > runner.lineMax) return runner.overflowed("output line too long")
    for (var i = 0; i < lines.length; i++) if (lines[i]) runner.onLine(lines[i])
  }

  function overflowed(reason) {
    runner.overflow = true
    runner.err = reason
    runner.stop()
  }

  // TERM reaches timeout, which passes it on to the command's process group;
  // KILL follows if anything is left.
  function stop() {
    if (!proc.running) return
    proc.signal(15)
    kill.restart()
  }

  Process {
    id: proc
    clearEnvironment: true
    environment: Commands.environment(Quickshell.env("HOME"), Quickshell.env("XDG_RUNTIME_DIR"),
                                      Quickshell.env("DBUS_SESSION_BUS_ADDRESS"), Quickshell.env("XDG_CONFIG_HOME"),
                                      Quickshell.env("GH_CONFIG_DIR"))
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) { runner.append("out", chunk) }
    }
    stderr: SplitParser {
      splitMarker: ""
      onRead: function(chunk) { runner.append("err", chunk) }
    }
    onStarted: {
      if (runner.stdinText === null) return
      proc.write(runner.stdinText)
      proc.stdinEnabled = false   // closes stdin
    }
    onExited: function(code) { runner.complete(code, runner.generation) }
    // A command that failed to start never exits.
    onRunningChanged: {
      if (running) return
      var generation = runner.generation
      Qt.callLater(function() { runner.complete(-1, generation) })
    }
  }

  Timer {
    id: backstop
    onTriggered: { runner.err = "timed out"; runner.stop() }
  }

  Timer {
    id: kill
    interval: 2000
    onTriggered: if (proc.running) proc.signal(9)
  }

  // Stop an in-flight command when the plugin unloads.
  Component.onDestruction: if (proc.running) proc.signal(15)
}
