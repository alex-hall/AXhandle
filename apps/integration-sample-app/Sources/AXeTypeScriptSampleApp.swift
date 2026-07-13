import Foundation
import SwiftUI

@main
struct AXeTypeScriptSampleApp: App {
  var body: some Scene {
    WindowGroup {
      ContentView()
    }
  }
}

private struct ContentView: View {
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
