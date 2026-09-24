import QtQuick
import Quickshell.Io
import "Commands.js" as Commands

// Runs one command at a time and hands its exit code, stdout and stderr to
// a callback. Output is read in chunks under a budget, and a command that
// outlives its deadline is killed; a command that cannot start reports
// exit code -1. The callback runs on the next tick, so it may start the
// next command straight away.
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

  // `callback(code, stdout, stderr)`. Returns false when a command is
  // already running or argv is missing.
  function run(argv, timeoutMs, callback) {
    if (!argv || runner.running) return false
    runner.pending = callback || function() {}
    runner.generation++
    runner.finished = false
    runner.out = ""
    runner.err = ""
    runner.overflow = false
    deadline.interval = timeoutMs || 30000
    proc.command = argv
    proc.running = true
    deadline.restart()
    return true
  }

  function complete(code, generation) {
    if (runner.finished || generation !== runner.generation) return
    runner.finished = true
    deadline.stop()
    var callback = runner.pending
    var failed = runner.overflow
    var out = failed ? "" : runner.out
    var err = runner.err
    runner.out = ""
    runner.err = ""
    Qt.callLater(function() {
      runner.pending = null
      if (callback) callback(failed ? -1 : code, out, err)
    })
  }

  function append(kind, chunk) {
    if (runner.overflow) return
    if (runner.out.length + runner.err.length + chunk.length > runner.budget) {
      runner.overflow = true
      runner.err = "output too large"
      proc.signal(15)
      return
    }
    if (kind === "out") runner.out += chunk
    else runner.err += chunk
  }

  Process {
    id: proc
    environment: Commands.ENV
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) { runner.append("out", chunk) }
    }
    stderr: SplitParser {
      splitMarker: ""
      onRead: function(chunk) { runner.append("err", chunk) }
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
    id: deadline
    onTriggered: {
      runner.err = "timed out"
      proc.signal(9)
    }
  }

  // Stop an in-flight command when the plugin unloads.
  Component.onDestruction: if (proc.running) proc.signal(9)
}
