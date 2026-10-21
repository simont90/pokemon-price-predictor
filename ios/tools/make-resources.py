#!/usr/bin/env python3
"""Generate the app's bundled catalogue from data/cards-db.js and sets-db.js.

Run from build.sh, never committed: the web catalogue is the one source of
truth and a checked-in copy would drift from it silently.
"""
import json, io, os, sys

root = os.path.join(os.path.dirname(__file__), '..', '..')
out  = os.path.join(os.path.dirname(__file__), '..', 'PokePredictor', 'Resources')
os.makedirs(out, exist_ok=True)

def load(path):
    s = io.open(os.path.join(root, path), encoding='utf-8').read()
    return json.loads(s[s.index('{'):].rstrip().rstrip(';'))

d = load('data/cards-db.js')
def ex(r):                       # 303 rows carry no extra dict at all
    return r[9] if len(r) > 9 and isinstance(r[9], dict) else {}

# Column-wise with shared string tables: as 27k JSON objects the file roughly
# triples, and the decode is what the first screen waits on.
cards = {'sets': d['sets'], 'codes': d['codes'], 'rars': d['rars'], 'rcodes': d['rcodes'],
         'cards': [[r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8],
                    ex(r).get('c', 0), ex(r).get('l', ''), ex(r).get('j', '')] for r in d['d']]}
io.open(os.path.join(out, 'cards.json'), 'w', encoding='utf-8').write(
    json.dumps(cards, ensure_ascii=False, separators=(',', ':')))

sd = load('data/sets-db.js')
sets = {k: {'name': v.get('name', ''), 'series': v.get('series', ''),
            'releaseDate': v.get('releaseDate', ''), 'printedTotal': v.get('printedTotal', 0),
            'logo': v.get('logo', '')} for k, v in sd.items()}
io.open(os.path.join(out, 'sets.json'), 'w', encoding='utf-8').write(
    json.dumps(sets, ensure_ascii=False, separators=(',', ':')))

print(f"resources: {len(cards['cards'])} cards, {len(sets)} sets")
