import SwiftUI

@main
struct PokePredictorApp: App {
    @StateObject private var db = CardDatabase()
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(db)
                .environmentObject(model)
                .tint(.accentYellow)
                .preferredColorScheme(.dark)   // dark is the house default
        }
    }
}

extension Color {
    /// Set literally rather than via an asset accent: the web app's --accent is
    /// red on this theme and collides with its "above budget" tag.
    static let accentYellow = Color(red: 0.910, green: 0.714, blue: 0.204)   // #e8b634
}

struct RootView: View {
    @EnvironmentObject var db: CardDatabase

    var body: some View {
        TabView {
            CardSearchView()
                .tabItem { Label("Cards", systemImage: "magnifyingglass") }
            CollectionView()
                .tabItem { Label("Collection", systemImage: "square.stack") }
            SettingsView()
                .tabItem { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
        }
        .overlay {
            if db.isLoading {
                ZStack {
                    Color.black.opacity(0.85).ignoresSafeArea()
                    VStack(spacing: 12) {
                        ProgressView().tint(.accentYellow)
                        Text("Loading 27,085 cards…")
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}
