import QtQuick
import QtQuick.Shapes
import qs.Commons

// The Vault Sync mark: an obsidian shard (the vault) inside two sync arrows.
//
// The phase changes the mark rather than swapping icons:
//   synced    gem in the accent colour
//   changes   gem in the theme's yellow: notes changed since the last sync
//   syncing   the arrows turn
//   conflict  plain gem, urgent dot: conflict copies in the vault
//   error     gem in the urgent colour, faded arrows
//   setup     faded gem, dashed ring
//
// Drawn on a 16-unit grid and scaled as vectors, so it stays sharp from the
// bar slot up to the popup.
Item {
  id: logo

  property string phase: "synced"
  property color color: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  // Notes changed since the last sync; the theme's yellow, from Settings.qml.
  property color dirty: "#e0af68"
  // The colour behind the mark, for the dot's ring.
  property color cutColor: Color.background

  readonly property bool idle: phase === "setup"
  readonly property color gemColor: phase === "synced" || phase === "syncing" ? accent
    : phase === "changes" ? dirty
    : phase === "error" ? urgent : color
  readonly property color dotColor: phase === "conflict" ? urgent : "transparent"

  implicitWidth: 16
  implicitHeight: 16

  Item {
    id: grid
    width: 16
    height: 16
    scale: Math.min(logo.width, logo.height) / 16
    transformOrigin: Item.TopLeft
    x: (logo.width - 16 * scale) / 2
    y: (logo.height - 16 * scale) / 2

    // Sync arrows: two arcs of a 6.4 ring with open arrowheads. They turn
    // while a sync runs.
    Item {
      id: ring
      width: 16
      height: 16
      opacity: logo.phase === "error" || logo.idle ? 0.45 : logo.phase === "syncing" ? 0.8 : 1

      RotationAnimator on rotation {
        running: logo.phase === "syncing"
        from: 0
        to: 360
        duration: 1400
        loops: Animation.Infinite
        onRunningChanged: if (!running) ring.rotation = 0
      }

      Shape {
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer

        ShapePath {
          strokeColor: logo.color
          strokeWidth: 1.25
          fillColor: "transparent"
          capStyle: ShapePath.RoundCap
          joinStyle: ShapePath.RoundJoin
          strokeStyle: logo.idle ? ShapePath.DashLine : ShapePath.SolidLine
          dashPattern: [1.1, 1.3]

          startX: 1.986; startY: 5.811
          PathArc { x: 12.903; y: 3.886; radiusX: 6.4; radiusY: 6.4; direction: PathArc.Clockwise }
          PathMove { x: 14.014; y: 10.189 }
          PathArc { x: 3.097; y: 12.114; radiusX: 6.4; radiusY: 6.4; direction: PathArc.Clockwise }
        }

        ShapePath {
          strokeColor: logo.idle ? "transparent" : logo.color
          strokeWidth: 1.25
          fillColor: "transparent"
          capStyle: ShapePath.RoundCap
          joinStyle: ShapePath.RoundJoin

          startX: 10.911; startY: 3.712
          PathLine { x: 12.903; y: 3.886 }
          PathLine { x: 13.077; y: 1.894 }
          PathMove { x: 5.089; y: 12.288 }
          PathLine { x: 3.097; y: 12.114 }
          PathLine { x: 2.923; y: 14.106 }
        }
      }
    }

    // The gem: an obsidian shard, five facets around an off-centre core,
    // each a different shade so it reads as faceted glass.
    Repeater {
      model: [
        { a: [8.7, 3.8], b: [10.9, 7.1], shade: 1.0 },
        { a: [10.9, 7.1], b: [8.9, 12.2], shade: 0.72 },
        { a: [8.9, 12.2], b: [5.3, 9.3], shade: 0.5 },
        { a: [5.3, 9.3], b: [6.3, 5.5], shade: 0.62 },
        { a: [6.3, 5.5], b: [8.7, 3.8], shade: 0.85 }
      ]

      Shape {
        required property var modelData
        anchors.fill: parent
        preferredRendererType: Shape.CurveRenderer

        ShapePath {
          readonly property color facet: Util.alpha(logo.gemColor, modelData.shade * (logo.idle ? 0.35 : 1))
          strokeColor: facet
          strokeWidth: 0.25
          fillColor: facet
          joinStyle: ShapePath.RoundJoin

          startX: 8.1; startY: 8.1
          PathLine { x: modelData.a[0]; y: modelData.a[1] }
          PathLine { x: modelData.b[0]; y: modelData.b[1] }
          PathLine { x: 8.1; y: 8.1 }
        }
      }
    }

    Shape {
      anchors.fill: parent
      preferredRendererType: Shape.CurveRenderer

      ShapePath {
        strokeColor: logo.gemColor
        strokeWidth: 0.55
        fillColor: "transparent"
        joinStyle: ShapePath.RoundJoin

        startX: 8.7; startY: 3.8
        PathLine { x: 10.9; y: 7.1 }
        PathLine { x: 8.9; y: 12.2 }
        PathLine { x: 5.3; y: 9.3 }
        PathLine { x: 6.3; y: 5.5 }
        PathLine { x: 8.7; y: 3.8 }
      }
    }

    // Status dot, top right.
    Rectangle {
      visible: logo.dotColor.a > 0
      x: 11.1
      y: 0.7
      width: 4.2
      height: 4.2
      radius: 2.1
      color: logo.dotColor
      border.width: 1
      border.color: logo.cutColor
    }
  }
}
