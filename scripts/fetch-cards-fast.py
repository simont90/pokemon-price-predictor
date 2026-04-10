"""
Fast parallel fetch of ALL Pokemon TCG cards from pokemontcg.io API
Uses concurrent requests for speed.
"""
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.request import urlopen, Request
from urllib.error import HTTPError

API_URL = "https://api.pokemontcg.io/v2/cards"
SETS_URL = "https://api.pokemontcg.io/v2/sets"
PAGE_SIZE = 250

def fetch_json(url, retries=3):
    for i in range(retries):
        try:
            req = Request(url, headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0 PokemonPricePredictor/1.0"})
            with urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except HTTPError as e:
            if e.code == 429:
                wait = 5 * (i + 1)
                print(f"  Rate limited, waiting {wait}s...")
                time.sleep(wait)
            else:
                print(f"  HTTP {e.code} for {url}, retry {i+1}")
                time.sleep(2)
        except Exception as e:
            print(f"  Error: {e}, retry {i+1}")
            time.sleep(2)
    return None

def fetch_page(page):
    url = f"{API_URL}?pageSize={PAGE_SIZE}&page={page}&select=id,name,number,rarity,set,images,tcgplayer,subtypes,supertype"
    data = fetch_json(url)
    if data:
        cards = data.get("data", [])
        print(f"  Page {page}: {len(cards)} cards")
        return cards
    return []

def main():
    # First get total count
    print("Getting total card count...")
    data = fetch_json(f"{API_URL}?pageSize=1")
    total = data["totalCount"]
    total_pages = (total + PAGE_SIZE - 1) // PAGE_SIZE
    print(f"Total: {total} cards across {total_pages} pages")
    
    # Fetch sets
    print("Fetching sets...")
    sets_data = fetch_json(f"{SETS_URL}?pageSize=250")
    all_sets = sets_data.get("data", [])
    # Check if more pages
    if len(all_sets) < sets_data.get("totalCount", 0):
        page2 = fetch_json(f"{SETS_URL}?pageSize=250&page=2")
        if page2:
            all_sets.extend(page2.get("data", []))
    print(f"  Got {len(all_sets)} sets")
    
    # Fetch all cards with controlled concurrency (3 at a time to avoid rate limits)
    all_cards = []
    print(f"Fetching {total_pages} pages (3 concurrent)...")
    
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {}
        for page in range(1, total_pages + 1):
            futures[executor.submit(fetch_page, page)] = page
        
        for future in as_completed(futures):
            page_num = futures[future]
            try:
                cards = future.result()
                all_cards.extend(cards)
            except Exception as e:
                print(f"  Page {page_num} failed: {e}")
    
    print(f"\nFetched {len(all_cards)} cards total")
    
    # Save raw data for processing
    raw_path = os.path.join(os.path.dirname(__file__), "..", "data", "raw-api-cards.json")
    with open(raw_path, "w") as f:
        json.dump({"cards": all_cards, "sets": all_sets}, f, separators=(",", ":"))
    
    size_mb = os.path.getsize(raw_path) / 1024 / 1024
    print(f"Saved raw data: {size_mb:.1f} MB")
    
    # Quick stats
    with_price = sum(1 for c in all_cards if c.get("tcgplayer", {}).get("prices"))
    print(f"Cards with TCGPlayer prices: {with_price}")
    
    # Check for the specific card user asked about
    for c in all_cards:
        if "charizard" in c["name"].lower() and "vstar" in c["name"].lower():
            print(f"  Found: {c['name']} #{c['number']} ({c['set']['name']})")

if __name__ == "__main__":
    main()
