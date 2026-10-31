import SwiftUI

struct ContentView: View {
    @StateObject private var vm = WebViewModel()

    var body: some View {
        ZStack {
            // Dark background — prevents white flash on launch
            Color(red: 14/255, green: 15/255, blue: 19/255).ignoresSafeArea()

            if vm.isOffline {
                OfflineView { vm.load() }
            } else {
                WebViewRepresentable(webView: vm.webView)
                    .ignoresSafeArea()
            }

            // Thin accent progress bar at the top while the page loads
            if vm.isLoading {
                VStack {
                    GeometryReader { geo in
                        Rectangle()
                            .fill(Color(red: 232/255, green: 182/255, blue: 52/255))
                            .frame(width: geo.size.width * vm.loadProgress, height: 2)
                            .animation(.linear(duration: 0.1), value: vm.loadProgress)
                    }
                    .frame(height: 2)
                    Spacer()
                }
                .ignoresSafeArea()
            }
        }
    }
}

// MARK: - Offline screen
private struct OfflineView: View {
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "wifi.slash")
                .font(.system(size: 52, weight: .light))
                .foregroundColor(Color(white: 0.4))

            VStack(spacing: 8) {
                Text("No connection")
                    .font(.system(size: 20, weight: .semibold, design: .rounded))
                    .foregroundColor(.white)
                Text("Check your internet and try again.")
                    .font(.subheadline)
                    .foregroundColor(Color(white: 0.5))
                    .multilineTextAlignment(.center)
            }

            Button(action: onRetry) {
                Text("Retry")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(Color(red: 14/255, green: 15/255, blue: 19/255))
                    .frame(width: 120, height: 44)
                    .background(Color(red: 232/255, green: 182/255, blue: 52/255))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(40)
    }
}
