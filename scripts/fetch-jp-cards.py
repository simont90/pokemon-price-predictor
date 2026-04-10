#!/usr/bin/env python3
"""
Fetch all Japanese Pokemon TCG cards from TCGdex API.
Phase 1: Quick fetch of all set listings (fast - just set endpoints).
Phase 2: Batch fetch pricing from individual card endpoints for modern sets.
"""
import json, time, urllib.request, sys, os
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://api.tcgdex.net/v2"

def fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Pokemon-Price-Model/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except Exception as e:
            if attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
            else:
                print(f"  FAIL: {url} -> {e}", file=sys.stderr)
                return None

def fetch_card_detail(jp_id):
    """Fetch individual card detail for pricing + rarity."""
    url = f"{BASE}/ja/cards/{jp_id}"
    data = fetch_json(url, retries=2)
    if not data:
        return jp_id, None, None, None
    
    rarity = data.get("rarity", "")
    pricing = data.get("pricing", {})
    price_usd = None
    price_trend = None
    
    if pricing:
        cm = pricing.get("cardmarket", {})
        if cm and cm.get("avg"):
            price_usd = round(cm["avg"] * 1.09, 2)  # EUR -> USD
            price_trend = cm.get("trend")
            if price_trend:
                price_trend = round(price_trend * 1.09, 2)
    
    return jp_id, rarity, price_usd, price_trend

def main():
    # ===== PHASE 1: Fetch all JP set listings =====
    print("=" * 60)
    print("PHASE 1: Fetching all JP set card listings")
    print("=" * 60)
    
    # Get all JP sets
    print("Fetching JP sets...")
    sets = fetch_json(f"{BASE}/ja/sets")
    if not sets:
        print("Failed to fetch sets"); return
    print(f"  Found {len(sets)} JP sets")
    
    # EN name mapping
    print("Fetching EN card + set names for cross-reference...")
    en_cards = fetch_json(f"{BASE}/en/cards") or []
    en_name_map = {c["id"]: c.get("name", "") for c in en_cards}
    en_sets = fetch_json(f"{BASE}/en/sets") or []
    en_set_map = {s["id"]: s.get("name", "") for s in en_sets}
    print(f"  {len(en_name_map)} EN cards, {len(en_set_map)} EN sets mapped")
    
    # Fetch each set's card listing
    all_cards = []
    for idx, s in enumerate(sets):
        set_id = s["id"]
        set_name = s.get("name", "Unknown")
        en_set_name = en_set_map.get(set_id, "")
        
        set_data = fetch_json(f"{BASE}/ja/sets/{set_id}")
        if not set_data or "cards" not in set_data:
            continue
        
        cards = set_data["cards"]
        series = set_data.get("serie", {}).get("name", "")
        official = set_data.get("cardCount", {}).get("official", 0)
        
        for c in cards:
            cid = c.get("id", "")
            lid = c.get("localId", "")
            jp_name = c.get("name", "")
            en_name = en_name_map.get(cid, "")
            image = c.get("image", "")
            
            all_cards.append({
                "jp_id": cid,
                "name_jp": jp_name,
                "name_en": en_name,
                "set_jp": set_name,
                "set_en": en_set_name,
                "set_code": set_id,
                "series": series,
                "card_number": lid,
                "card_total": str(official),
                "image": f"{image}/high.png" if image else "",
            })
        
        if (idx + 1) % 25 == 0:
            print(f"  [{idx+1}/{len(sets)}] {len(all_cards)} cards so far...")
        time.sleep(0.25)
    
    en_mapped = sum(1 for c in all_cards if c["name_en"])
    print(f"\nPhase 1 complete: {len(all_cards)} JP cards ({en_mapped} with EN names)")
    
    # Save checkpoint
    with open("data/jp-cards-raw.json", "w") as f:
        json.dump({"count": len(all_cards), "cards": all_cards}, f)
    print("Checkpoint saved to data/jp-cards-raw.json")
    
    # ===== PHASE 2: Fetch pricing for modern sets =====
    print("\n" + "=" * 60)
    print("PHASE 2: Fetching pricing for modern sets")
    print("=" * 60)
    
    # Modern sets = SV era + S era (Sword & Shield)
    modern_codes = set()
    for c in all_cards:
        sc = c["set_code"]
        if (sc.startswith("SV") or sc.startswith("sv") or 
            sc.startswith("S") and not sc.startswith("SM")):
            modern_codes.add(sc)
    
    modern_cards = [c for c in all_cards if c["set_code"] in modern_codes]
    print(f"  {len(modern_cards)} cards in {len(modern_codes)} modern sets to price")
    
    # Use thread pool for parallel fetching (4 threads to be polite)
    priced = 0
    batch_size = 50
    
    for batch_start in range(0, len(modern_cards), batch_size):
        batch = modern_cards[batch_start:batch_start + batch_size]
        
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {executor.submit(fetch_card_detail, c["jp_id"]): c for c in batch}
            for future in as_completed(futures):
                card = futures[future]
                try:
                    jp_id, rarity, price_usd, price_trend = future.result()
                    if rarity:
                        card["rarity"] = rarity
                    if price_usd is not None:
                        card["price_usd"] = price_usd
                        card["price_trend"] = price_trend
                        priced += 1
                except Exception as e:
                    pass
        
        done = min(batch_start + batch_size, len(modern_cards))
        if done % 200 == 0 or done == len(modern_cards):
            print(f"  [{done}/{len(modern_cards)}] {priced} priced")
        
        time.sleep(0.5)
    
    print(f"\nPhase 2 complete: {priced} cards priced")
    
    # Save final data
    with open("data/jp-cards-raw.json", "w") as f:
        json.dump({
            "count": len(all_cards),
            "priced": priced,
            "source": "tcgdex.net (Japanese)",
            "updated": time.strftime("%Y-%m-%d"),
            "cards": all_cards,
        }, f)
    
    print(f"\nSaved {len(all_cards)} JP cards ({priced} with pricing) to data/jp-cards-raw.json")

if __name__ == "__main__":
    main()
