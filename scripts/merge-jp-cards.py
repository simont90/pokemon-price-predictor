#!/usr/bin/env python3
"""
Merge Japanese cards from TCGdex into the main cards-expanded.json database.
JP cards get a unique ID prefix 'jp-' and are tagged with lang='JP'.
"""
import json, re, sys

# Rarity mapping from TCGdex labels to our rarity codes
RARITY_MAP = {
    'Special Illustration Rare': 'SIR',
    'Special Art Rare': 'SAR',
    'Ultra Rare': 'UR',
    'Hyper Rare': 'HR',
    'Secret Rare': 'SR',
    'Double rare': 'RR',
    'Double Rare': 'RR',
    'Illustration Rare': 'IR',
    'Art Rare': 'AR',
    'Character Super Rare': 'CSR',
    'Character Rare': 'CHR',
    'Rare': 'R',
    'Uncommon': 'U',
    'Common': 'C',
    'PROMO': 'P',
    'Amazing Rare': 'AR',
    'Radiant Rare': 'RR',
    'Shiny rare': 'SR',
    'Shiny Super Rare': 'SSR',
    'Shiny Ultra Rare': 'SUR',
    '': '',
}

def main():
    # Load existing database
    print("Loading existing cards database...")
    with open("data/cards-expanded.json") as f:
        db = json.load(f)
    existing_cards = db["cards"]
    print(f"  Existing cards: {len(existing_cards)}")
    
    # Load JP cards
    print("Loading JP cards...")
    with open("data/jp-cards-raw.json") as f:
        jp_data = json.load(f)
    jp_cards = jp_data["cards"]
    print(f"  JP cards: {len(jp_cards)}")
    
    # Remove any previously added JP cards
    existing_cards = [c for c in existing_cards if not c.get("i", "").startswith("jp-")]
    print(f"  After removing old JP entries: {len(existing_cards)}")
    
    # Build set of existing card IDs to avoid duplicates
    existing_ids = {c["i"] for c in existing_cards}
    
    # Convert JP cards to our compact format
    new_jp = []
    skipped = 0
    
    for c in jp_cards:
        card_id = f"jp-{c['jp_id']}"
        if card_id in existing_ids:
            skipped += 1
            continue
        
        # Build display name: "EN Name (JP: JP Name)" or just JP name
        en_name = c.get("name_en", "")
        jp_name = c.get("name_jp", "")
        
        if en_name and en_name != jp_name:
            display_name = f"{en_name} (JP)"
        elif en_name:
            display_name = f"{en_name} (JP)"
        else:
            display_name = f"{jp_name} (JP)"
        
        # Map rarity
        rarity_label = c.get("rarity", "")
        rarity_code = RARITY_MAP.get(rarity_label, "")
        
        # Parse card number
        cn = c.get("card_number", "")
        ct = c.get("card_total", "")
        try:
            cn_int = int(cn)
        except:
            cn_int = 0
        try:
            ct_int = int(ct)
        except:
            ct_int = 0
        
        # Build number string for search (e.g., "212/172")
        ns = f"{cn}/{ct}" if cn and ct else cn
        
        # Price (from Cardmarket EUR->USD if available, otherwise 0)
        price = c.get("price_usd", 0) or 0
        
        # Set name: prefer EN set name, fallback to JP
        set_name = c.get("set_en") or c.get("set_jp", "")
        if c.get("set_jp") and set_name != c["set_jp"]:
            set_name = f"{set_name} ({c['set_jp']})"
        elif c.get("set_jp"):
            set_name = c["set_jp"]
        
        entry = {
            "i": card_id,
            "n": display_name,
            "nj": jp_name,  # Japanese name for search
            "s": set_name,
            "sc": c.get("set_code", ""),
            "sr": c.get("series", ""),
            "r": rarity_label,
            "rc": rarity_code,
            "cn": cn_int,
            "ct": ct_int,
            "ns": ns,
            "p": price,
            "img": c.get("image", ""),
            "lang": "JP",
        }
        
        new_jp.append(entry)
        existing_ids.add(card_id)
    
    print(f"  New JP entries to add: {len(new_jp)}")
    print(f"  Skipped (duplicate IDs): {skipped}")
    
    # Stats
    with_en = sum(1 for c in new_jp if not c["n"].startswith(c.get("nj", "?")))
    with_price = sum(1 for c in new_jp if c["p"] > 0)
    print(f"  With EN names: {with_en}")
    print(f"  With pricing: {with_price}")
    
    # Merge
    all_cards = existing_cards + new_jp
    all_cards.sort(key=lambda c: c.get("p", 0), reverse=True)
    
    # Update database
    db["cards"] = all_cards
    db["count"] = len(all_cards)
    db["source"] = "pokemontcg.io + mycollectrics.com + tcgdex.net (JP)"
    
    # Save
    print(f"\nSaving merged database: {len(all_cards)} cards...")
    with open("data/cards-expanded.json", "w") as f:
        json.dump(db, f)
    
    size_mb = len(json.dumps(db)) / 1024 / 1024
    print(f"  File size: {size_mb:.1f} MB")
    print("Done!")

if __name__ == "__main__":
    main()
