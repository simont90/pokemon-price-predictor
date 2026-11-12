import BackgroundTasks
import SwiftUI

@main
struct PricePredictorApp: App {
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            // Ask each time the app leaves the screen; iOS keeps one pending
            // request per identifier and decides when to honour it.
            if phase == .background { BackgroundRefresh.schedule() }
        }
        .backgroundTask(.appRefresh(BackgroundRefresh.taskID)) {
            BackgroundRefresh.schedule()   // chain the next one first
            await BackgroundRefresh.run()
        }
    }
}

/// Background App Refresh: iOS wakes the app for about 30 seconds, at times
/// of its own choosing, so prices are already current when it is opened.
///
/// The app is a shell, so the work is the site's own: `pkmBackgroundRefresh()`
/// in app.js pulls the prices the worker fetched overnight and starts the
/// daily refresh if it is due. This only reaches a web view that is still in
/// memory. If iOS has terminated the app there is no page to call, and the
/// same hydration simply runs on the next launch.
enum BackgroundRefresh {
    /// Must match BGTaskSchedulerPermittedIdentifiers in the Info.plist.
    static let taskID = "com.simontariq.pokepredictor.refresh"

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskID)
        // A floor, not a schedule: iOS picks the moment from usage, battery
        // and network. Prices move daily, so hourly would be wasted wake-ups.
        request.earliestBeginDate = Date(timeIntervalSinceNow: 4 * 60 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // Thrown when Background App Refresh is off in Settings, and
            // always in the Simulator.
            print("PricePredictor: background refresh not scheduled — \(error.localizedDescription)")
        }
    }

    static func run() async {
        guard let model = await WebViewModel.current else {
            print("PricePredictor: background refresh — no page in memory, skipped")
            return
        }
        let result = await model.backgroundRefresh()
        print("PricePredictor: background refresh — \(result)")
    }
}
