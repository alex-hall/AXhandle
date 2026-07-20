import Foundation
import SwiftUI

@main
struct AXhandleSampleApp: App {
  var body: some Scene {
    WindowGroup {
      RootTabs()
    }
  }
}

/// Four tabs, one per API area the e2e suite exercises: the original compose
/// form (tap/fill/type/check + matchers), a dynamic list (swipe, count,
/// waitForCount, waitForGone, firstPresent), native alerts (tapLabel), and a
/// tap canvas (tapPoint). Tab switches themselves exercise tap({ until }).
private struct RootTabs: View {
  var body: some View {
    TabView {
      ComposeView()
        .tabItem { Label("Compose", systemImage: "square.and.pencil") }

      ListView()
        .tabItem { Label("List", systemImage: "list.bullet") }

      AlertsView()
        .tabItem { Label("Alerts", systemImage: "exclamationmark.bubble") }

      CanvasView()
        .tabItem { Label("Canvas", systemImage: "hand.tap") }
    }
  }
}

// The original sample form — ids unchanged so the original e2e spec keeps
// passing against it.
private struct ComposeView: View {
  @State private var message = ""
  @State private var didSend = false
  @State private var notificationsEnabled = false

  private var canSend: Bool {
    !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Composer") {
          VStack(alignment: .leading, spacing: 12) {
            Text("Message composer")
              .accessibilityIdentifier("composer-title")

            TextField("Message", text: $message)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .accessibilityLabel("Message")
              .accessibilityIdentifier("message-input")

            Button("Send") {
              didSend = true
            }
            .accessibilityIdentifier("send")
            .disabled(!canSend)

            if didSend {
              Text("Delivered")
                .accessibilityLabel("Delivery status: Delivered")
                .accessibilityIdentifier("delivery-status")
            }
          }
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("composer")
        }

        Section("Controls") {
          Toggle("Notifications", isOn: $notificationsEnabled)
            .accessibilityIdentifier("notifications")

          NavigationLink("Details") {
            DetailsView()
          }
          .accessibilityIdentifier("details-link")
        }
      }
      .accessibilityIdentifier("sample-root")
      .navigationTitle("AXe Sample")
    }
  }
}

private struct DetailsView: View {
  var body: some View {
    Text("Details screen")
      .accessibilityIdentifier("details-screen")
      .navigationTitle("Details")
  }
}

/// A long list plus add/remove controls. Reaching the deep rows requires
/// swiping; adding and removing rows gives count / waitForCount / waitForGone
/// something real to observe.
private struct ListView: View {
  @State private var rowCount = 40

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        HStack {
          Button("Add Row") { rowCount += 1 }
            .accessibilityIdentifier("add-row")
          Button("Remove Row") { rowCount = max(0, rowCount - 1) }
            .accessibilityIdentifier("remove-row")
        }
        .buttonStyle(.bordered)
        .padding(8)

        List(0..<max(rowCount, 0), id: \.self) { index in
          Text("Row \(index + 1)")
            .accessibilityIdentifier("row-\(index + 1)")
        }
        .accessibilityIdentifier("exercise-list")
      }
      .navigationTitle("List")
    }
  }
}

/// Native alert flow for tapLabel: system alert buttons frequently never
/// appear in describe-ui, so the label-tap escape hatch is the only way to
/// press them.
private struct AlertsView: View {
  @State private var showAlert = false
  @State private var choice = "none"

  var body: some View {
    NavigationStack {
      VStack(spacing: 16) {
        Button("Show Alert") { showAlert = true }
          .accessibilityIdentifier("show-alert")

        Text("Alert choice: \(choice)")
          .accessibilityLabel("Alert choice: \(choice)")
          .accessibilityIdentifier("alert-choice")
      }
      .alert("Proceed?", isPresented: $showAlert) {
        Button("Confirm") { choice = "confirmed" }
        Button("Cancel", role: .cancel) { choice = "cancelled" }
      } message: {
        Text("This exercises native alert buttons.")
      }
      .navigationTitle("Alerts")
    }
  }
}

/// A plain tappable surface for tapPoint: raw coordinate taps carry no
/// locator, so the canvas just reports that a touch landed.
private struct CanvasView: View {
  @State private var tapped = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 16) {
        Text("Tap status: \(tapped ? "recorded" : "none")")
          .accessibilityLabel("Tap status: \(tapped ? "recorded" : "none")")
          .accessibilityIdentifier("canvas-status")

        Rectangle()
          .fill(Color.blue.opacity(0.2))
          .frame(height: 260)
          .overlay(Text("Tap target"))
          .contentShape(Rectangle())
          .onTapGesture { tapped = true }
          .accessibilityLabel("Tap target")
          .accessibilityIdentifier("canvas-target")
          .padding()
      }
      .navigationTitle("Canvas")
    }
  }
}
