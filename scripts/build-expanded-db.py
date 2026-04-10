"""
Build expanded card database from raw API data + existing mycollectrics data.
Creates compact JSON optimized for the web app.
"""
import json
import os
import re
import time

# Explicit mapping from mycollectrics set codes to pokemontcg.io set IDs
# This avoids fuzzy name-matching bugs (e.g. "Evolutions" vs "Prismatic Evolutions")
MC_TO_API_SET = {
    "ASC": "me2pt5",    # Ascended Heroes
    "BLK": "zsv10pt5",  # Black Bolt
    "DRI": "sv10",       # Destined Rivals
    "JTG": "sv9",        # Journey Together
    "MEG": "me1",        # Mega Evolution
    "OBF": "sv3",        # Obsidian Flames
    "PAL": "sv2",        # Paldea Evolved
    "PAF": "sv4pt5",     # Paldean Fates
    "PAR": "sv4",        # Paradox Rift
    "PFL": "me2",        # Phantasmal Flames
    "PRE": "sv8pt5",     # Prismatic Evolutions (NOT xy12 "Evolutions")
    "SVI": "sv1",        # Scarlet & Violet base
    "MEW": "sv3pt5",     # Scarlet & Violet 151 (NOT sv1)
    "SFA": "sv6pt5",     # Shrouded Fable
    "SCR": "sv7",        # Stellar Crown
    "SSP": "sv8",        # Surging Sparks
    "TEF": "sv5",        # Temporal Forces
    "TWM": "sv6",        # Twilight Masquerade
    "WHT": "rsv10pt5",   # White Flare
}

# Reverse: API set ID -> MC set code
API_TO_MC_SET = {v: k for k, v in MC_TO_API_SET.items()}


def get_market_price(card):
    """Extract best market price from TCGPlayer data"""
    tcg = card.get("tcgplayer", {})
    prices = tcg.get("prices", {})
    best = 0
    for variant in ["holofoil", "reverseHolofoil", "normal", "1stEditionHolofoil",
                     "unlimitedHolofoil", "unlimited", "1stEditionNormal", "1stEdition"]:
        if variant in prices:
            mkt = prices[variant].get("market") or prices[variant].get("mid") or 0
            if mkt > best:
                best = mkt
    return best


def rarity_to_code(rarity, subtypes=None):
    """Convert rarity string to compact code"""
    r = (rarity or "").lower()
    st = [s.lower() for s in (subtypes or [])]
    
    if "special illustration" in r or "special art" in r:
        return "SIR"
    if "hyper" in r and ("shiny" in r or "mega" in r):
        return "MHR"
    if "hyper" in r:
        return "HR"
    if "illustration" in r:
        return "IR"
    if "rainbow" in r:
        return "HR"
    if "secret" in r or "gold" in r:
        return "HR"
    if "shiny" in r and "ultra" in r:
        return "SHUR"
    if "shiny" in r and "rare" in r:
        return "SHR"
    if "ace spec" in r:
        return "AS"
    if "amazing" in r:
        return "AR"
    if "ultra" in r:
        return "UR"
    if "full art" in r:
        return "UR"
    if "double" in r:
        return "DR"
    if "rare holo" in r:
        if "vmax" in st or "vstar" in st or "v" in st or "ex" in st or "gx" in st:
            return "UR"
        return "HR"
    if "rare" in r and "uncommon" not in r:
        return "R"
    if "uncommon" in r:
        return "U"
    if "common" in r:
        return "C"
    if "promo" in r:
        return "PR"
    if "legend" in r:
        return "UR"
    if "radiant" in r:
        return "UR"
    return ""


def parse_card_number(num_str):
    """Parse card number from string like '174/172' or 'SWSH262'"""
    if not num_str:
        return 0, num_str
    try:
        if "/" in num_str:
            return int(num_str.split("/")[0]), num_str
        return int(num_str), num_str
    except (ValueError, IndexError):
        return 0, num_str


def clean_name(name):
    """Normalize card name for matching: strip #number, [brackets], lowercase"""
    n = name.lower().strip()
    n = re.sub(r'\s*#\d+$', '', n)       # Remove trailing #number
    n = re.sub(r'\s*\[.*?\]', '', n)      # Remove [bracket text]
    n = re.sub(r'\s+', ' ', n)            # Collapse whitespace
    return n.strip()


def main():
    script_dir = os.path.dirname(__file__)
    data_dir = os.path.join(script_dir, "..", "data")
    
    # Load raw API data
    print("Loading raw API data...")
    with open(os.path.join(data_dir, "raw-api-cards.json")) as f:
        raw = json.load(f)
    api_cards = raw["cards"]
    api_sets = raw["sets"]
    print(f"  {len(api_cards)} API cards, {len(api_sets)} sets")
    
    # Load existing mycollectrics data
    print("Loading existing mycollectrics data...")
    with open(os.path.join(data_dir, "cards.json")) as f:
        mc_data = json.load(f)
    mc_cards = {c["i"]: c for c in mc_data["cards"]}
    print(f"  {len(mc_cards)} mycollectrics cards")
    
    # Load existing sets
    with open(os.path.join(data_dir, "sets.json")) as f:
        mc_sets = json.load(f)
    
    # Build mycollectrics lookup: (clean_name, card_number, api_set_id) -> mc card
    # We use api_set_id to ensure we match within the correct set
    mc_lookup = {}
    for c in mc_cards.values():
        mc_set_code = c.get("sc", "")
        api_set_id = MC_TO_API_SET.get(mc_set_code, "")
        if not api_set_id:
            continue
        
        cname = clean_name(c["n"])
        cn = c.get("cn", 0)
        
        # Primary key: name + number + set
        key = f"{cname}|{cn}|{api_set_id}"
        mc_lookup[key] = c
        
        # Secondary key: name + number (cross-set fallback)
        key2 = f"{cname}|{cn}"
        if key2 not in mc_lookup:
            mc_lookup[key2] = c
    
    print(f"  Built MC lookup with {len(mc_lookup)} entries")
    
    # Build API set ID to set info mapping
    api_set_map = {s["id"]: s for s in api_sets}
    
    # Process API cards
    print("\nBuilding expanded card database...")
    compact_cards = []
    matched = 0
    
    for card in api_cards:
        set_info = card.get("set", {})
        set_id = set_info.get("id", "")
        num_str = card.get("number", "")
        cn, ns = parse_card_number(num_str)
        price = get_market_price(card)
        rarity = card.get("rarity", "") or ""
        rc = rarity_to_code(rarity, card.get("subtypes", []))
        
        # Try to match with mycollectrics data
        cname = clean_name(card["name"])
        
        # Try: name + number + set (most specific)
        mc = mc_lookup.get(f"{cname}|{cn}|{set_id}")
        
        # Fallback: name + number only
        if not mc:
            mc = mc_lookup.get(f"{cname}|{cn}")
        
        compact = {
            "i": card["id"],
            "n": card["name"],
            "s": set_info.get("name", ""),
            "sc": set_id,
            "sr": set_info.get("series", ""),
            "r": rarity,
            "rc": rc,
            "cn": cn,
            "ct": set_info.get("printedTotal", 0),
            "ns": ns,
            "p": round(price, 2),
            "img": card.get("images", {}).get("small", ""),
        }
        
        if mc:
            matched += 1
            compact["mi"] = mc["i"]  # mycollectrics ID for market data
            if (mc.get("p10") or 0) > 0:
                compact["p10"] = mc["p10"]
            if (mc.get("g") or 0) > 0:
                compact["g"] = mc["g"]
            # Use mycollectrics price if it's higher (more accurate for newer cards)
            if (mc.get("p") or 0) > compact["p"]:
                compact["p"] = mc["p"]
        
        compact_cards.append(compact)
    
    # Add mycollectrics-only cards (not found in API)
    # Build set of API card keys we already processed
    api_processed = set()
    for card in api_cards:
        set_id = card.get("set", {}).get("id", "")
        cn_str = card.get("number", "")
        cn_val, _ = parse_card_number(cn_str)
        cname = clean_name(card["name"])
        api_processed.add(f"{cname}|{cn_val}|{set_id}")
    
    extra = 0
    for c in mc_cards.values():
        mc_set_code = c.get("sc", "")
        api_set_id = MC_TO_API_SET.get(mc_set_code, mc_set_code)
        cname = clean_name(c["n"])
        cn = c.get("cn", 0)
        
        if f"{cname}|{cn}|{api_set_id}" not in api_processed:
            api_set = api_set_map.get(api_set_id, {})
            
            compact_cards.append({
                "i": f"mc-{c['i']}",
                "n": c["n"],
                "s": c.get("s", ""),
                "sc": api_set_id,
                "sr": api_set.get("series", "Scarlet & Violet"),
                "r": c.get("r", ""),
                "rc": c.get("rc", ""),
                "cn": cn,
                "ct": c.get("ct", 0),
                "ns": f"{cn}/{c.get('ct',0)}" if cn else "",
                "p": c.get("p", 0),
                "p10": c.get("p10", 0),
                "g": c.get("g", 0),
                "img": c.get("img", ""),
                "mi": c["i"],
            })
            extra += 1
    
    print(f"  Matched {matched} cards with mycollectrics data")
    print(f"  Added {extra} mycollectrics-only cards")
    
    # Remove cards with 0 price and no image (junk entries)
    before = len(compact_cards)
    compact_cards = [c for c in compact_cards if c.get("p", 0) > 0 or c.get("img")]
    print(f"  Filtered out {before - len(compact_cards)} cards with no price and no image")
    
    # Sort by price descending
    compact_cards.sort(key=lambda c: c.get("p", 0), reverse=True)
    
    # Output
    output = {
        "count": len(compact_cards),
        "source": "pokemontcg.io + mycollectrics.com",
        "updated": time.strftime("%Y-%m-%d"),
        "cards": compact_cards,
    }
    
    out_path = os.path.join(data_dir, "cards-expanded.json")
    with open(out_path, "w") as f:
        json.dump(output, f, separators=(",", ":"))
    
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"\nWrote {len(compact_cards)} cards to cards-expanded.json ({size_mb:.1f} MB)")
    
    # Build expanded sets data
    sets_output = {}
    for s in api_sets:
        sid = s["id"]
        sets_output[sid] = {
            "name": s["name"],
            "series": s.get("series", ""),
            "printedTotal": s.get("printedTotal", 0),
            "total": s.get("total", 0),
            "releaseDate": s.get("releaseDate", ""),
        }
    
    # Merge mycollectrics set data (pack costs, pull rates, rarity breakdowns)
    for mc_code, api_id in MC_TO_API_SET.items():
        if api_id in sets_output and mc_code in mc_sets:
            mc = mc_sets[mc_code]
            sets_output[api_id]["packCost"] = mc.get("packCost")
            sets_output[api_id]["evPerPack"] = mc.get("evPerPack")
            sets_output[api_id]["rarities"] = mc.get("rarities")
            sets_output[api_id]["mcCode"] = mc_code  # preserve for easy cross-reference
    
    sets_out_path = os.path.join(data_dir, "sets-expanded.json")
    with open(sets_out_path, "w") as f:
        json.dump(sets_output, f, separators=(",", ":"))
    
    print(f"Wrote {len(sets_output)} sets to sets-expanded.json")
    
    # Print stats
    with_price = sum(1 for c in compact_cards if c.get("p", 0) > 0)
    with_psa10 = sum(1 for c in compact_cards if c.get("p10", 0) > 0)
    with_img = sum(1 for c in compact_cards if c.get("img"))
    with_mi = sum(1 for c in compact_cards if c.get("mi"))
    series = sorted(set(c.get("sr", "") for c in compact_cards if c.get("sr")))
    
    print(f"\n=== Final Stats ===")
    print(f"Total cards: {len(compact_cards)}")
    print(f"With market price: {with_price}")
    print(f"With PSA 10 price: {with_psa10}")
    print(f"With image: {with_img}")
    print(f"With mycollectrics ID (live market data): {with_mi}")
    print(f"Series: {series}")
    
    # Check for user's specific requests
    print(f"\n=== Spot Checks ===")
    for c in compact_cards:
        name_lower = c["n"].lower()
        if "charizard" in name_lower and "vstar" in name_lower:
            print(f"  Charizard VSTAR: {c['n']} #{c['ns']} ({c['s']}) sc={c['sc']} - ${c['p']} {'[MC]' if c.get('mi') else ''}")
    
    # Check Prismatic Evolutions cards
    pre_cards = [c for c in compact_cards if c["sc"] == "sv8pt5"]
    print(f"\n  Prismatic Evolutions cards: {len(pre_cards)}")
    if pre_cards:
        pre_with_mi = sum(1 for c in pre_cards if c.get("mi"))
        print(f"  With MC match: {pre_with_mi}")
        # Show a few
        for c in pre_cards[:3]:
            print(f"    {c['n']} #{c['ns']} - ${c['p']} {'[MC]' if c.get('mi') else ''}")


if __name__ == "__main__":
    main()
