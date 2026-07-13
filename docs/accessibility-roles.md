# Accessibility roles

`findByRole()` matches AXe's semantic `role_description`, normalized only by
lowercasing it. The library deliberately does not invent a cross-framework role
taxonomy: a test should describe the accessibility contract actually exposed to
iOS users.

The public integration captures currently exercise these roles:

| AXe role | Typical selector | Notes |
| --- | --- | --- |
| `button` | `findByRole("button", { name: "Send" })` | Includes ordinary buttons. SwiftUI `NavigationLink` is currently also exposed as a button. |
| `link` | `findByRole("link", { name: "Details" })` | React Native `Pressable` exposes this when `accessibilityRole="link"` is set. |
| `text field` | `findByRole("text field", { name: "Message" })` | Give fields explicit accessible names; a placeholder/value is not a durable substitute. |
| `switch` | `findByRole("switch", { name: "Notifications" })` | Use `check()`/`uncheck()` and `toBeChecked()`/`toBeUnchecked()` for state. |
| `text` | `findByText("Delivered")` | Prefer text or a descriptive accessible label for status content. |
| `group` | `findByTestId("composer")` | A visual group is not guaranteed to retain descendant relationships in AXe. |

Roles are exact, case-normalized strings. If AXe changes its role descriptions,
the captured public fixtures and opt-in end-to-end suite should reveal that
before an application suite silently changes behavior.
