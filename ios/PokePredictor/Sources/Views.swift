import SwiftUI

// MARK: - Card art

/// Art moved host partway through the catalogue: images.pokemontcg.io 404s for
/// every set from Ascended Heroes on, and those are served from scrydex keyed
/// by card id rather than set + number. The set's logo override is the tell.
func cardImageURL(_ card: Card, sets: [String: CardDatabase.SetInfo]) -> URL? {
    if card.isJapanese { return nil }           // most JP cards have no art source
    if sets[card.setCode]?.logo.contains("scrydex") == true {
        return URL(string: "https://images.scrydex.com/pokemon/\(card.id)/large")
    }
    let n = card.numberString.isEmpty ? String(card.number) : card.numberString
    return URL(string: "https://images.pokemontcg.io/\(card.setCode)/\(n)_hires.png")
}

struct CardArt: View {
    let card: Card
    @EnvironmentObject var db: CardDatabase
    var body: some View {
        AsyncImage(url: cardImageURL(card, sets: db.sets)) { phase in
            switch phase {
            case .success(let img): img.resizable().aspectRatio(contentMode: .fit)
            default:
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.secondary.opacity(0.15))
                    .overlay(Image(systemName: "photo").foregroundStyle(.tertiary))
                    .aspectRatio(0.716, contentMode: .fit)   // standard card ratio
            }
        }
    }
}

// MARK: - Search

struct CardSearchView: View {
    @EnvironmentObject var db: CardDatabase
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var results: [Card] = []

    var body: some View {
        NavigationStack {
            Group {
                if query.count < 2 {
                    ContentUnavailableView("Search \(db.cards.count) cards",
                        systemImage: "magnifyingglass",
                        description: Text("Name, set or card number. Japanese names work too."))
                } else if results.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List(results) { card in
                        NavigationLink(value: card) { CardRow(card: card) }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Cards")
            .navigationDestination(for: Card.self) { CardDetailView(card: $0) }
            .searchable(text: $query, prompt: "Charizard, Team Rocket, 5/82")
            .onChange(of: query) { _, q in results = db.search(q) }
        }
    }
}

struct CardRow: View {
    let card: Card
    @EnvironmentObject var model: AppModel
    var body: some View {
        HStack(spacing: 12) {
            CardArt(card: card).frame(width: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(card.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text("\(card.setName) · \(card.numberString)")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if card.priceUSD > 0 {
                    Text(model.formatGBP(model.gbp(card.priceUSD)))
                        .font(.caption.monospaced().weight(.semibold))
                }
                if !card.rarityCode.isEmpty {
                    Text(card.rarityCode)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Color.accentYellow.opacity(0.18))
                        .foregroundStyle(Color.accentYellow)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Detail

struct CardDetailView: View {
    let card: Card
    @EnvironmentObject var db: CardDatabase
    @EnvironmentObject var model: AppModel

    private var ownedCopies: [OwnedCard] { model.owned.filter { $0.id == card.id } }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                CardArt(card: card).frame(maxWidth: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .shadow(radius: 8, y: 4)

                VStack(spacing: 4) {
                    Text(card.name).font(.title2.weight(.bold)).multilineTextAlignment(.center)
                    if !card.japaneseName.isEmpty {
                        Text(card.japaneseName).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text("\(card.setName) · \(card.numberString)\(card.printedTotal > 0 ? "/\(card.printedTotal)" : "")")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                if card.priceUSD > 0 {
                    VStack(spacing: 2) {
                        Text(model.formatGBP(model.gbp(card.priceUSD)))
                            .font(.system(size: 34, weight: .bold, design: .rounded))
                        Text("catalogue price · $\(card.priceUSD, specifier: "%.2f")")
                            .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                } else {
                    Text("No catalogue price for this card")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                if !ownedCopies.isEmpty {
                    GroupBox {
                        ForEach(Array(ownedCopies.enumerated()), id: \.offset) { _, c in
                            HStack {
                                Label(c.grade.map { "PSA \($0)" } ?? "Raw", systemImage: "checkmark.seal.fill")
                                    .foregroundStyle(Color.accentYellow)
                                Spacer()
                                if let q = c.quantity, q > 1 { Text("×\(q)").font(.caption.monospaced()) }
                            }
                            .font(.subheadline)
                        }
                    } label: { Text("In your collection").font(.caption.weight(.semibold)) }
                }

                GroupBox {
                    LabeledContent("Rarity", value: card.rarity.isEmpty ? "—" : card.rarity)
                    LabeledContent("Set code", value: card.setCode)
                    if let s = db.sets[card.setCode], !s.releaseDate.isEmpty {
                        LabeledContent("Released", value: s.releaseDate)
                    }
                    LabeledContent("Language", value: card.isJapanese ? "Japanese" : "English")
                }
                .font(.subheadline)

                Text("Hold Strategy, the grade ladder and the Gold/Silver/Bronze picks are not here yet — they come from the shared valuation model, not a second copy in Swift.")
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding(.horizontal)
            }
            .padding()
        }
        .navigationTitle(card.numberString)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Collection

struct CollectionView: View {
    @EnvironmentObject var db: CardDatabase
    @EnvironmentObject var model: AppModel

    private var resolved: [(OwnedCard, Card?)] {
        model.owned.map { ($0, db.card(id: $0.id)) }
    }
    private var totalGBP: Double {
        resolved.reduce(0) { $0 + model.gbp(($1.1?.priceUSD ?? 0) * Double($1.0.quantity ?? 1)) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.owned.isEmpty {
                    ContentUnavailableView("No collection yet", systemImage: "square.stack",
                        description: Text("Pull it from the Sync tab once you've pressed Sync now on the website."))
                } else {
                    List {
                        Section {
                            LabeledContent("Cards", value: "\(model.owned.count)")
                            LabeledContent("Catalogue value", value: model.formatGBP(totalGBP))
                        }
                        Section("Cards") {
                            ForEach(Array(resolved.enumerated()), id: \.offset) { _, pair in
                                if let c = pair.1 {
                                    NavigationLink(value: c) { CardRow(card: c) }
                                } else {
                                    Text(pair.0.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Collection")
            .navigationDestination(for: Card.self) { CardDetailView(card: $0) }
        }
    }
}

// MARK: - Sync

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @State private var healthy: Bool?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("16–64 characters", text: $model.pairCode)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    if let problem = model.pairCodeProblem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Button {
                        Task { await model.pull() }
                    } label: {
                        HStack {
                            Text("Pull collection")
                            if model.isSyncing { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(!model.canPull)
                } header: {
                    Text("Pair code")
                } footer: {
                    Text("Website → Sync panel. The code is 32 characters; copy all of it.")
                }

                if !model.status.isEmpty {
                    Section { Text(model.status).font(.footnote) }
                }

                Section("Worker") {
                    LabeledContent("Status") {
                        switch healthy {
                        case .some(true):  Label("ok", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        case .some(false): Label("unreachable", systemImage: "xmark.circle.fill").foregroundStyle(.red)
                        case nil:          Text("checking…").foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("FX (GBP per USD)", value: String(format: "%.4f", model.fxRate))
                    if let d = model.lastSynced {
                        LabeledContent("Snapshot", value: d.formatted(date: .abbreviated, time: .shortened))
                    }
                }

                Section {
                    Text("This reads the same blob the website syncs. It never writes, so nothing here can touch your collection.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Sync")
            .task { healthy = await model.checkHealth() }
        }
    }
}
