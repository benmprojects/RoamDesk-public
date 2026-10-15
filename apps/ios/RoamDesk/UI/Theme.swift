import SwiftUI
import UIKit

/// Calm deep neutrals plus one warm accent ("ember"), matching the Android app.
enum Theme {
    private static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    static let background = dyn(0xF7F5F2, 0x0D1015)
    static let surface = dyn(0xEFECE7, 0x181D25)
    static let surfaceHigh = dyn(0xE6E2DC, 0x1F252E)
    static let surfaceHighest = dyn(0xDDD8D1, 0x272E38)
    static let onBackground = dyn(0x1B1F24, 0xE6E8EB)
    static let muted = dyn(0x5C6470, 0x9AA3AF)
    static let line = dyn(0xD9D4CD, 0x353D48)
    static let accent = dyn(0xC2582E, 0xF0936A)
    static let onAccent = dyn(0xFFFFFF, 0x2B1206)
    static let accentContainer = dyn(0xFFDBCB, 0x4A2616)
    static let danger = dyn(0xD12F35, 0xE5484D)

    static func color(_ phase: DrivePhase) -> Color {
        switch phase {
        case .idle: return dyn(0x66707F, 0x8E99AB)
        case .listening: return dyn(0xC2582E, 0xF0936A)
        case .thinking: return dyn(0x6A55E0, 0xA594FF)
        case .speaking: return dyn(0x138C76, 0x45C7AE)
        case .confirming: return dyn(0xB7800C, 0xF5BE4F)
        case .offline: return dyn(0x8A919B, 0x6B7380)
        }
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

struct BigButtonStyle: ButtonStyle {
    var fill: Color = Theme.accent
    var textColor: Color = Theme.onAccent
    var height: CGFloat = 88

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 24, weight: .semibold))
            .foregroundStyle(textColor)
            .frame(maxWidth: .infinity, minHeight: height)
            .background(fill.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
