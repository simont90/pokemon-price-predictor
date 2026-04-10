"""
Fetch ALL Pokemon TCG cards from pokemontcg.io API
and merge with existing mycollectrics data.
Outputs a compact JSON file for the web app.
"""
import json
import requests
import time
import os
import sys

API_URL = "https://api.pokemontcg.io/v2/cards"
SETS_URL = "https://api.pokemontcg.io/v2/sets"
PAGE_SIZE = 250

def fetch_all_sets():
    """Fetch all set data"""
    print("Fetching sets...")
    sets = []
    page = 1
    while True:
        r = requests.get(SETS_URL, params={"pageSize": 250, "page": page})
        data = r.json()
        sets.extend(data.get("data", []))
        if len(sets) >= data.get("totalCount", 0):
            break
        page += 1
        time.sleep(0.3)
    print(f"  Got {len(sets)} sets")
    return sets

def fetch_all_cards():
    """Fetch all cards with pagination"""
    print("Fetching cards...")
    cards = []
    page = 1
    total = None
    while True:
        r = requests.get(API_URL, params={
            "pageSize": PAGE_SIZE,
            "page": page,
            "select": "id,name,number,rarity,set,images,tcgplayer,subtypes,supertype"
        })
        if r.status_code == 429:
            print("  Rate limited, waiting 10s...")
            time.sleep(10)
            continue
        data = r.json()
        if total is None:
            total = data.get("totalCount", 0)
            print(f"  Total cards to fetch: {total}")
        
        batch = data.get("data", [])
        cards.extend(batch)
        print(f"  Page {page}: got {len(batch)} cards (total: {len(cards)}/{total})")
        
        if len(cards) >= total or not batch:
            break
        page += 1
        time.sleep(0.5)  # Be nice to the API
    
    print(f"  Fetched {len(cards)} cards total")
    return cards

def get_market_price(card):
    """Extract the best market price from TCGPlayer data"""
    tcg = card.get("tcgplayer", {})
    prices = tcg.get("prices", {})
    
    # Priority: holofoil > reverseHolofoil > normal > 1stEditionHolofoil > unlimited
    best = 0
    for variant in ["holofoil", "reverseHolofoil", "normal", "1stEditionHolofoil", 
                     "unlimitedHolofoil", "unlimited", "1stEditionNormal", "1stEdition"]:
        if variant in prices:
            mkt = prices[variant].get("market") or prices[variant].get("mid") or 0
            if mkt > best:
                best = mkt
    return best

def build_compact_card(card, existing_map):
    """Build a compact card record merging API + existing data"""
    set_info = card.get("set", {})
    card_id = card["id"]
    
    # Parse card number
    num_str = card.get("number", "")
    try:
        cn = int(num_str.split("/")[0]) if "/" in num_str else int(num_str)
    except (ValueError, IndexError):
        cn = 0
    
    price = get_market_price(card)
    
    # Check if we have existing mycollectrics data for this card
    # Match by name + set code
    existing = existing_map.get(card_id)
    
    # Build rarity code from rarity string
    rarity = card.get("rarity", "") or ""
    rc = rarity_to_code(rarity, card.get("subtypes", []))
    
    compact = {
        "i": card_id,                          # API ID (e.g., "swsh9-174")
        "n": card["name"],                     # Name
        "s": set_info.get("name", ""),         # Set name
        "sc": set_info.get("id", ""),          # Set code (API format)
        "sr": set_info.get("series", ""),      # Series (e.g., "Sword & Shield")
        "r": rarity,                           # Rarity string
        "rc": rc,                              # Rarity code
        "cn": cn,                              # Card number
        "ct": set_info.get("printedTotal", 0), # Cards in set
        "ns": num_str,                         # Number string (original, e.g. "174/172")
        "p": round(price, 2),                  # Market price USD
        "img": card.get("images", {}).get("small", ""),
    }
    
    # Merge mycollectrics data if available
    if existing:
        if existing.get("p10", 0) > 0:
            compact["p10"] = existing["p10"]
        if existing.get("g", 0) > 0:
            compact["g"] = existing["g"]
        # Use mycollectrics price if API price is 0
        if compact["p"] == 0 and existing.get("p", 0) > 0:
            compact["p"] = existing["p"]
        # Keep mycollectrics ID for market data API calls
        compact["mi"] = existing["i"]
    
    return compact

def rarity_to_code(rarity, subtypes):
    """Convert rarity string to our compact code"""
    r = rarity.lower()
    if "special illustration" in r or "special art" in r:
        return "SIR"
    if "hyper" in r and "shiny" in r:
        return "SHR"
    if "hyper" in r:
        return "HR"
    if "illustration" in r:
        return "IR"
    if "rainbow" in r:
        return "HR"  # Rainbow = Hyper Rare equivalent
    if "secret" in r:
        return "HR"
    if "ultra" in r and "shiny" in r:
        return "SHUR"
    if "ultra" in r:
        return "UR"
    if "full art" in r:
        return "UR"
    if "double" in r:
        return "DR"
    if "ace spec" in r:
        return "AS"
    if "amazing" in r:
        return "AR"
    if "shiny" in r:
        return "SHR"
    if "rare holo" in r and ("v " in r or "vmax" in r or "vstar" in r or subtypes):
        st = [s.lower() for s in (subtypes or [])]
        if "vmax" in st:
            return "UR"
        if "vstar" in st:
            return "UR"
        if "v" in st:
            return "UR"
        if "ex" in st:
            return "UR"
        if "gx" in st:
            return "UR"
        return "HR"
    if "rare" in r:
        return "R"
    if "uncommon" in r:
        return "U"
    if "common" in r:
        return "C"
    if "promo" in r:
        return "PR"
    return ""

def main():
    # Load existing mycollectrics data
    existing_path = os.path.join(os.path.dirname(__file__), "..", "data", "cards.json")
    existing_map = {}
    if os.path.exists(existing_path):
        with open(existing_path) as f:
            existing_data = json.load(f)
        # Build lookup by collectrics ID
        for c in existing_data.get("cards", []):
            existing_map[c["i"]] = c
        print(f"Loaded {len(existing_map)} existing mycollectrics cards")
    
    # Fetch all data from API
    all_sets = fetch_all_sets()
    all_cards = fetch_all_cards()
    
    # Build set lookup from mycollectrics data (sc -> set code mapping)
    # First build the set data from the API
    sets_output = {}
    for s in all_sets:
        sets_output[s["id"]] = {
            "name": s["name"],
            "series": s.get("series", ""),
            "printedTotal": s.get("printedTotal", 0),
            "total": s.get("total", 0),
            "releaseDate": s.get("releaseDate", ""),
            "images": s.get("images", {}),
        }
    
    # Map mycollectrics set codes to API set codes
    mc_to_api = {}
    existing_sets_path = os.path.join(os.path.dirname(__file__), "..", "data", "sets.json")
    if os.path.exists(existing_sets_path):
        with open(existing_sets_path) as f:
            existing_sets = json.load(f)
        # Try to match by name
        api_name_map = {s["name"].lower(): s["id"] for s in all_sets}
        for mc_code, mc_set in existing_sets.items():
            mc_name = mc_set.get("name", "").lower()
            for api_name, api_id in api_name_map.items():
                if mc_name in api_name or api_name in mc_name:
                    mc_to_api[mc_code] = api_id
                    break
        print(f"Mapped {len(mc_to_api)} mycollectrics sets to API sets")
    
    # Build name+number based lookup for matching existing cards
    existing_nn_map = {}
    for c in existing_map.values():
        key = f"{c['n'].lower()}|{c.get('cn',0)}"
        existing_nn_map[key] = c
    
    # Build compact cards, matching existing data
    compact_cards = []
    matched = 0
    for card in all_cards:
        # Try to find matching existing card by name + number
        num_str = card.get("number", "")
        try:
            cn = int(num_str.split("/")[0]) if "/" in num_str else int(num_str)
        except (ValueError, IndexError):
            cn = 0
        
        match_key = f"{card['name'].lower()}|{cn}"
        existing = existing_nn_map.get(match_key)
        
        if existing:
            matched += 1
        
        compact = build_compact_card(card, {card["id"]: existing} if existing else {})
        if existing:
            compact["mi"] = existing["i"]  # Mycollectrics ID for market data
        
        compact_cards.append(compact)
    
    print(f"\nMatched {matched} cards with existing mycollectrics data")
    
    # Also add mycollectrics cards that weren't in the API
    api_names = {f"{c['name'].lower()}|{c.get('number','').split('/')[0] if '/' in c.get('number','') else c.get('number','')}" for c in all_cards}
    extra = 0
    for c in existing_map.values():
        key = f"{c['n'].lower()}|{c.get('cn',0)}"
        if key not in api_names:
            compact_cards.append({
                "i": c["i"],
                "n": c["n"],
                "s": c.get("s", ""),
                "sc": c.get("sc", ""),
                "sr": "",
                "r": c.get("r", ""),
                "rc": c.get("rc", ""),
                "cn": c.get("cn", 0),
                "ct": c.get("ct", 0),
                "ns": f"{c.get('cn',0)}/{c.get('ct',0)}" if c.get("cn") else "",
                "p": c.get("p", 0),
                "p10": c.get("p10", 0),
                "g": c.get("g", 0),
                "img": c.get("img", ""),
                "mi": c["i"],
            })
            extra += 1
    
    print(f"Added {extra} extra cards from mycollectrics not in API")
    
    # Sort by price descending
    compact_cards.sort(key=lambda c: c.get("p", 0), reverse=True)
    
    # Output
    output = {
        "count": len(compact_cards),
        "source": "pokemontcg.io + mycollectrics.com",
        "updated": time.strftime("%Y-%m-%d"),
        "cards": compact_cards,
    }
    
    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "cards-expanded.json")
    with open(out_path, "w") as f:
        json.dump(output, f, separators=(",", ":"))
    
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"\nWrote {len(compact_cards)} cards to {out_path}")
    print(f"File size: {size_mb:.1f} MB")
    
    # Also save expanded sets
    sets_out_path = os.path.join(os.path.dirname(__file__), "..", "data", "sets-expanded.json")
    
    # Merge existing set data (pack costs, rarity breakdowns) with API data
    if os.path.exists(existing_sets_path):
        with open(existing_sets_path) as f:
            existing_sets = json.load(f)
        for mc_code, api_code in mc_to_api.items():
            if api_code in sets_output and mc_code in existing_sets:
                mc = existing_sets[mc_code]
                sets_output[api_code]["packCost"] = mc.get("packCost")
                sets_output[api_code]["evPerPack"] = mc.get("evPerPack")
                sets_output[api_code]["rarities"] = mc.get("rarities")
    
    with open(sets_out_path, "w") as f:
        json.dump(sets_output, f, separators=(",", ":"))
    
    sets_size = os.path.getsize(sets_out_path) / 1024 / 1024
    print(f"Wrote {len(sets_output)} sets to {sets_out_path}")
    print(f"Sets file size: {sets_size:.1f} MB")
    
    # Stats
    with_price = sum(1 for c in compact_cards if c.get("p", 0) > 0)
    with_psa10 = sum(1 for c in compact_cards if c.get("p10", 0) > 0)
    with_img = sum(1 for c in compact_cards if c.get("img"))
    series = set(c.get("sr", "") for c in compact_cards)
    print(f"\nStats:")
    print(f"  Cards with price: {with_price}")
    print(f"  Cards with PSA 10: {with_psa10}")
    print(f"  Cards with image: {with_img}")
    print(f"  Series: {sorted(s for s in series if s)}")

if __name__ == "__main__":
    main()
