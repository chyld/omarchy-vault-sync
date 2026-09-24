import QtQuick
import qs.Commons
import qs.Ui
import "Safe.js" as Safe

// Bar icon for Vault Sync. The icon shows the sync state; clicking it opens
// a popup with the status, the repository, and under it the tree of vaults
// synced to it. Everything shown comes from the sync service, and every
// change goes through it: the popup keeps no settings of its own, so the
// popups on several monitors always agree.
Panel {
  id: root
  moduleName: "chyld.vault-sync"
  ipcTarget: "chyld.vault-sync"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // The long-running sync service (Service.qml); null until the host has
  // loaded it, so it is looked up again until found.
  property var service: null

  function findService() {
    var shell = root.bar ? root.bar.shell : null
    var found = shell && typeof shell.serviceFor === "function" ? shell.serviceFor(root.moduleName) : null
    if (found !== root.service) root.service = found || null
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.service === null
    triggeredOnStart: true
    onTriggered: root.findService()
  }

  onBarChanged: root.findService()

  readonly property string phase: root.service ? root.service.phase : "setup"

  onOpenedChanged: {
    if (!opened || !root.service) return
    root.service.refresh()
    root.service.checkVisibility()
    urlField.text = Safe.repoPage(root.service.repoUrl)
  }

  // ------------------------------------------------------------ state text

  // The mark turns the theme's yellow when notes changed since the last
  // sync; the service reads it from the current Omarchy theme.
  readonly property color dirtyColor: root.service ? root.service.dirtyColor : "#e0af68"

  // Behind the mark: the bar's own background, or the theme's when the bar
  // is see-through.
  readonly property color markBackground: root.bar && root.bar.background && root.bar.background.a > 0.5
    ? root.bar.background : Color.background

  // ------------------------------------------------------------ repository

  // Saves the URL typed in the field when it is a valid GitHub URL, or
  // clears it when the field is empty. `tidy` also rewrites the field in
  // its normal form, which is left for when typing has finished.
  function commitUrl(tidy) {
    urlSave.stop()
    if (!root.service) return
    var typed = urlField.text
    var page = Safe.repoPage(typed)
    if (page) {
      root.service.setRepoUrl(page)
      if (tidy && typed !== page) urlField.text = page
    } else if (typed.trim() === "") {
      root.service.setRepoUrl("")
    } else {
      return
    }
    root.dropLegacySettings()
  }

  // Older versions kept the URL on this widget's entry in shell.json. The
  // service now keeps it in its own file, so the old key is removed once a
  // URL has been set here.
  function dropLegacySettings() {
    var legacy = false
    for (var k in root.settings) if (k !== "id") legacy = true
    if (!legacy || !root.bar || !root.bar.shell) return
    root.settings = ({})
    root.bar.shell.updateEntryInline(root.moduleName, {})
  }

  Timer {
    id: urlSave
    interval: 500
    onTriggered: root.commitUrl(false)
  }

  // ------------------------------------------------------------ vaults

  // Adds or removes a vault from those synced to the repository. The
  // service keeps this per repository, in its own file.
  function toggleVault(path) {
    if (root.service) root.service.toggleVault(path)
  }

  // Every Obsidian vault, plus any selected one Obsidian no longer lists.
  readonly property var treeRows: {
    var s = root.service
    if (!s) return []
    var rows = []
    var seen = Object.create(null)
    for (var i = 0; i < s.vaults.length; i++) {
      rows.push({ path: s.vaults[i].path, name: s.vaults[i].name })
      seen[s.vaults[i].path] = true
    }
    for (var j = 0; j < s.selected.length; j++)
      if (!seen[s.selected[j]]) rows.push({ path: s.selected[j], name: Safe.vaultName(s.selected[j]) })
    return rows
  }

  // A vault row's status: { text, color }.
  function rowStatus(path) {
    var s = root.service
    if (!s) return { text: "", color: root.barForeground }
    if (s.selected.indexOf(path) === -1) {
      var folder = Safe.vaultFolder(path)
      if (!folder) return { text: "can't sync this name", color: Util.alpha(root.barForeground, 0.6) }
      for (var i = 0; i < s.selected.length; i++)
        if (Safe.vaultFolder(s.selected[i]) === folder) return { text: "name in use", color: Util.alpha(root.barForeground, 0.6) }
      return { text: "not synced", color: Util.alpha(root.barForeground, 0.6) }
    }
    var st = s.state(path)
    switch (s.vaultPhase(path)) {
    case "syncing": return { text: "syncing…", color: Color.accent }
    case "error": return { text: "failed", color: Color.urgent }
    case "conflict":
      var c = st.conflictCount
      return { text: c + (c === 1 ? " conflict" : " conflicts"), color: Color.urgent }
    case "changes":
      if (!st.isRepo || !st.lastPushed) return { text: "never synced", color: root.dirtyColor }
      if (st.changes > 0) return { text: st.changes + " changed", color: root.dirtyColor }
      return { text: st.unpushed + " to send", color: root.dirtyColor }
    default:
      var when = s.vaultSynced(path)
      return { text: when ? "synced " + Safe.shortTime(when, new Date()) : "synced", color: Color.accent }
    }
  }

  // ------------------------------------------------------------ state text

  readonly property string headline: {
    var s = root.service
    if (!s) return "Starting"
    var t = s.totals
    switch (root.phase) {
    case "setup": return "Not set up"
    // The header shows progress through the vaults; the step in progress
    // is the line at the bottom.
    case "syncing":
      return s.syncTotal > 1 ? "Syncing " + Math.max(1, s.syncIndex) + " of " + s.syncTotal + " vaults" : "Syncing\u2026"
    case "error": return "Sync failed"
    case "conflict": return t.conflicts + (t.conflicts === 1 ? " conflict copy" : " conflict copies")
    case "changes":
      if (t.changes > 0) return t.changes + (t.changes === 1 ? " change to sync" : " changes to sync")
      return t.unsynced + (t.unsynced === 1 ? " vault to sync" : " vaults to sync")
    default: return "Up to date"
    }
  }

  readonly property string detail: {
    var s = root.service
    if (!s) return ""
    if (root.phase === "error") return s.totals.errorVault + ": " + s.totals.error
    if (root.phase === "setup") return !s.repoUrl ? "Enter a repository URL" : "Tick the vaults to sync"
    if (root.phase === "conflict") return "Merge each pair by hand, then delete the (conflict) copy"
    var when = s.lastSync || s.totals.lastPushed
    if (!when) return ""
    var text = "Synced " + Safe.shortTime(when, new Date())
    return s.lastSync && s.lastSummary ? text + " · " + s.lastSummary : text
  }

  // Conflict copies across the selected vaults, as "<vault>/<path>".
  readonly property var conflictPaths: {
    var s = root.service
    var list = []
    if (!s) return list
    for (var i = 0; i < s.selected.length; i++) {
      var copies = s.state(s.selected[i]).conflictCopies
      for (var j = 0; j < copies.length; j++) list.push(Safe.vaultName(s.selected[i]) + "/" + copies[j])
    }
    return list
  }

  readonly property color stateColor: root.phase === "error" ? Color.urgent
    : root.phase === "changes" ? root.dirtyColor
    : root.phase === "conflict" || root.phase === "synced" ? Color.accent
    : root.barForeground

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Logo {
        phase: root.phase
        dirty: root.dirtyColor
        color: button.foreground
        cutColor: root.markBackground
      }
    }
    tooltipText: root.opened ? "" : Safe.hostText("Vault Sync: " + root.headline, 60)
    onPressed: function(b) {
      if (b === Qt.MiddleButton && root.service) {
        if (urlField.invalid) return root.open()
        root.commitUrl(true)
        root.service.start()
      }
      else root.toggle()
    }
  }

  // ------------------------------------------------------------ popup parts

  component Caption: Text {
    width: parent ? parent.width : 0
    textFormat: Text.PlainText
    wrapMode: Text.WordWrap
    color: Util.alpha(root.barForeground, 0.85)
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }

  // A short list of paths, one per line.
  component PathList: Column {
    id: pathList
    property var paths: []
    property int limit: 5
    width: parent ? parent.width : 0

    Repeater {
      model: pathList.paths.slice(0, pathList.limit)

      Text {
        required property var modelData
        width: pathList.width
        textFormat: Text.PlainText
        elide: Text.ElideMiddle
        text: Safe.plain(modelData, 200)
        color: Util.alpha(root.barForeground, 0.9)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }

    Caption {
      visible: pathList.paths.length > pathList.limit
      text: "and " + (pathList.paths.length - pathList.limit) + " more"
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(8)

        // ---------------------------------------------------------- status

        Row {
          width: parent.width
          spacing: Style.space(10)

          Logo {
            id: stateGlyph
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(30)
            height: width
            phase: root.phase
            dirty: root.dirtyColor
            color: root.barForeground
            cutColor: Color.popups.background
          }

          Column {
            width: parent.width - stateGlyph.width - parent.spacing
            anchors.verticalCenter: parent.verticalCenter

            // The headline, with the plugin's name tucked in on the right.
            Item {
              width: parent.width
              height: headlineText.implicitHeight

              Text {
                id: headlineText
                anchors.left: parent.left
                anchors.right: appName.left
                anchors.rightMargin: Style.space(8)
                textFormat: Text.PlainText
                elide: Text.ElideRight
                text: Safe.plain(root.headline, 80)
                color: root.phase === "error" ? root.stateColor : root.barForeground
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: true
              }

              Text {
                id: appName
                anchors.right: parent.right
                anchors.baseline: headlineText.baseline
                textFormat: Text.PlainText
                text: "VAULT SYNC"
                color: Util.alpha(root.barForeground, 0.85)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
              }
            }

            Caption {
              visible: text !== ""
              text: Safe.plain(root.detail, 300)
              color: root.phase === "error" ? Util.alpha(Color.urgent, 0.9) : Util.alpha(root.barForeground, 0.85)
            }
          }
        }

        PathList {
          visible: root.phase === "conflict"
          paths: root.conflictPaths
        }

        Caption {
          visible: root.service !== null && root.service.warnings.length > 0 && !root.service.syncing
          text: root.service ? "Over 50 MB: " + root.service.warnings.slice(0, 3).join(", ") : ""
          color: Util.alpha(Color.urgent, 0.9)
        }

        Rectangle {
          width: parent.width
          height: 1
          color: Util.alpha(root.barForeground, 0.10)
        }

        // ---------------------------------------------------------- repository

        Row {
          width: parent.width
          spacing: Style.space(8)

          Text {
            id: repoGlyph
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: "\u{f02a4}"   // nf-md-github
            color: root.barForeground
            font.family: Style.font.family
            font.pixelSize: Style.font.body + 2
          }

          TextField {
            id: urlField
            width: parent.width - repoGlyph.width - parent.spacing
            placeholderText: "https://github.com/you/notes"
            maximumLength: 200
            foreground: root.barForeground
            text: root.service ? Safe.repoPage(root.service.repoUrl) : ""
            // The field keeps what was typed; only a valid URL is saved.
            property bool invalid: text.trim() !== "" && Safe.repoUrl(text) === ""
            // Saved shortly after typing stops, when focus leaves, and
            // before a sync, so Sync now always uses what the field shows.
            onTextChanged: if (activeFocus) urlSave.restart()
            onEditingFinished: root.commitUrl(true)
          }
        }

        Caption {
          visible: urlField.invalid
          text: "Use a URL like https://github.com/you/notes"
          color: Util.alpha(Color.urgent, 0.9)
        }

        // Public repositories are readable by anyone.
        Caption {
          visible: root.service !== null && root.service.visibility === "public" && !urlField.invalid
          text: "\u{f0026}  Public repo: anyone can read your synced notes."
          color: Color.urgent
          font.bold: true
        }

        // ---------------------------------------------------------- vault tree

        // The vaults under the repository: ticked ones sync to it, each into
        // Vaults/<name>/.
        Column {
          id: tree
          width: parent.width

          Repeater {
            model: root.treeRows

            Item {
              id: treeRow
              required property var modelData
              required property int index
              readonly property bool last: index === root.treeRows.length - 1
              readonly property bool checked: root.service !== null && root.service.selected.indexOf(modelData.path) !== -1
              readonly property var status: root.rowStatus(modelData.path)
              readonly property bool blocked: !checked && (status.text === "name in use" || status.text === "can't sync this name")

              width: tree.width
              height: Style.space(26)

              // Tree lines: a branch to this row, and the trunk down to the
              // next one.
              Rectangle {
                x: Math.round(repoGlyph.width / 2)
                y: 0
                width: 1
                height: treeRow.last ? parent.height / 2 : parent.height
                color: Util.alpha(root.barForeground, 0.35)
              }

              Rectangle {
                x: Math.round(repoGlyph.width / 2)
                y: parent.height / 2
                width: checkGlyph.x - x - Style.space(4)
                height: 1
                color: Util.alpha(root.barForeground, 0.35)
              }

              Rectangle {
                id: rowHover
                x: Style.space(22)
                width: parent.width - x
                height: parent.height
                radius: Style.cornerRadius
                color: rowMouse.containsMouse && !treeRow.blocked ? Util.alpha(root.barForeground, 0.06) : "transparent"
              }

              Text {
                id: checkGlyph
                x: Style.space(26)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: treeRow.checked ? "\u{f0132}" : "\u{f0131}"   // nf-md-checkbox_marked / _blank_outline
                color: treeRow.checked ? Color.accent : Util.alpha(root.barForeground, treeRow.blocked ? 0.35 : 0.7)
                font.family: Style.font.family
                font.pixelSize: Style.font.body + 2
              }

              Text {
                anchors.left: checkGlyph.right
                anchors.leftMargin: Style.space(8)
                anchors.right: statusText.left
                anchors.rightMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                elide: Text.ElideRight
                text: treeRow.modelData.name
                color: Util.alpha(root.barForeground, treeRow.checked ? 1 : 0.7)
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                font.bold: treeRow.checked
              }

              Text {
                id: statusText
                anchors.right: parent.right
                anchors.rightMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
                textFormat: Text.PlainText
                text: treeRow.status.text
                color: treeRow.status.color
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
              }

              MouseArea {
                id: rowMouse
                x: rowHover.x
                width: rowHover.width
                height: parent.height
                hoverEnabled: true
                enabled: !treeRow.blocked && root.service !== null && root.service.repoUrl !== "" && !root.service.syncing
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: root.toggleVault(treeRow.modelData.path)
              }
            }
          }
        }

        Caption {
          visible: root.treeRows.length === 0
          text: "No vaults found. Open a vault in Obsidian first."
        }

        Caption {
          visible: root.treeRows.length > 0 && root.service !== null && root.service.repoUrl === ""
          text: "Enter a repository URL, then tick the vaults to sync to it."
        }

        // ---------------------------------------------------------- actions

        Row {
          width: parent.width
          spacing: Style.space(6)

          Button {
            id: syncButton
            width: parent.width - githubButton.width - parent.spacing
            text: root.phase === "syncing" ? "Syncing…"
              : root.service && root.service.selected.length > 1 ? "Sync " + root.service.selected.length + " vaults" : "Sync now"
            iconText: "\u{f063f}"
            iconSpinning: root.phase === "syncing"
            bordered: true
            selected: root.phase !== "syncing" && root.phase !== "setup"
            // Typed text counts: an empty field clears the repository, and a
            // half-typed one must not sync to the previous URL.
            enabled: root.service !== null && !root.service.syncing && !urlField.invalid
              && urlField.text.trim() !== "" && root.service.selected.length > 0
            opacity: enabled ? 1 : 0.5
            foreground: root.barForeground
            onClicked: {
              root.commitUrl(true)
              root.service.start()
            }
          }

          Button {
            id: githubButton
            iconText: "\u{f02a4}"
            tooltipText: "Open on GitHub"
            bordered: true
            enabled: root.service !== null && root.service.repoUrl !== ""
            opacity: enabled ? 1 : 0.5
            foreground: root.barForeground
            onClicked: root.service.openRepo()
          }
        }

        Caption {
          text: "Syncs to Vaults/<name>/ \u00b7 .obsidian stays local"
          color: Util.alpha(root.barForeground, 0.75)
        }

        // ---------------------------------------------------------- activity

        // A quiet line while a sync runs: the step in progress. Gone as soon
        // as it ends.
        Column {
          id: activityLog
          readonly property var entries: {
            var all = root.service ? root.service.activity : []
            var syncing = root.service !== null && root.service.syncing
            return syncing && all.length > 0 ? [all[all.length - 1]] : []
          }
          width: parent.width
          visible: entries.length > 0
          spacing: Style.space(2)

          Rectangle {
            width: parent.width
            height: 1
            color: Util.alpha(root.barForeground, 0.08)
          }

          Item { width: 1; height: Style.space(2) }

          Repeater {
            model: activityLog.entries

            Text {
              required property var modelData
              width: activityLog.width
              textFormat: Text.PlainText
              elide: Text.ElideRight
              text: "\u2026  " + modelData.text
              color: Util.alpha(root.barForeground, 0.8)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }
        }
      }
    }
  }
}
