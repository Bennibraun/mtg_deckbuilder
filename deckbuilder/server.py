#!/usr/bin/env python3
"""Static file server, EDHREC proxy (EDHREC sends no CORS headers), and owned-card
lookup against Scryfall's oracle bulk data, re-downloaded when over a week old."""
import gzip
import http.server
import json
import pathlib
import re
import sys
import threading
import time
import urllib.parse
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HERE = pathlib.Path(__file__).parent
DB = HERE / "cards-db.json"
DECKS = HERE / "decks.json"
decks_lock = threading.Lock()
MAX_AGE = 7 * 86400
HEADERS = {"User-Agent": "deckbuilder/1.0", "Accept": "application/json"}
db, db_mtime, db_lock = [], 0, threading.Lock()


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=120)


def search_names(q):
    """All card names matching a Scryfall search (search endpoint allows 2 requests/s)."""
    names, url = set(), "https://api.scryfall.com/cards/search?q=" + urllib.parse.quote(q)
    while url:
        page = json.load(get(url))
        names.update(c["name"] for c in page["data"])
        url = page.get("next_page")
        time.sleep(0.5)
    return names


def hidden(c):
    """Cards Scryfall search leaves out unless asked (checked against search results)."""
    return c["set_type"] in ("memorabilia", "token", "alchemy") or "playtest" in c.get("promo_types", [])


# Deck strategies shown in the sidebar: label -> Scryfall Tagger tag (child tags included).
STRATEGIES = {
    "Ramp": "ramp", "Card draw": "draw", "Removal": "removal", "Board wipe": "sweeper",
    "Counterspell": "counterspell", "Tutor": "tutor", "Recursion": "recursion", "Protection": "protection",
    "Lifegain": "lifegain", "Lifegain payoff": "lifegain-matters", "Tokens": "repeatable-token-generator",
    "Sacrifice outlet": "sacrifice-outlet", "Burn": "burn", "Mill": "mill", "Discard": "discard",
    "Flicker": "flicker", "Anthem": "anthem", "Copy": "copy", "Landfall": "landfall", "Extra turn": "extra-turn",
}


def strategy_tags():
    """oracle_id -> strategy labels, from Scryfall's Oracle Tags bulk file."""
    meta = json.load(get("https://api.scryfall.com/bulk-data/oracle-tags"))
    with get(meta["jsonl_download_uri"]) as r, gzip.open(r, "rt", encoding="utf-8") as lines:
        tags = {t["id"]: t for t in map(json.loads, lines)}
    by_slug = {t["slug"]: t for t in tags.values()}

    def oracle_ids(t, seen):
        if t["id"] in seen:
            return set()
        seen.add(t["id"])
        ids = {x["oracle_id"] for x in t["taggings"]}
        for child in t["child_ids"]:
            if child in tags:
                ids |= oracle_ids(tags[child], seen)
        return ids

    out = {}
    for label, slug in STRATEGIES.items():
        for oid in oracle_ids(by_slug[slug], set()):
            out.setdefault(oid, []).append(label)
    return out


def slim(c, commanders, tags):
    faces = c.get("card_faces") or [c]
    f = lambda k: c.get(k) or faces[0].get(k)
    stat = lambda k: [x[k] for x in [c, *faces] if x.get(k) is not None]
    return {
        "name": c["name"],
        "cmc": c.get("cmc", 0),
        "type_line": c.get("type_line", ""),
        "oracle_text": c.get("oracle_text") or "\n".join(x.get("oracle_text", "") for x in faces),
        "colors": c.get("colors") or sorted({col for x in faces for col in x.get("colors", [])}),
        "color_identity": c["color_identity"],
        "power": stat("power"), "toughness": stat("toughness"), "loyalty": stat("loyalty"),
        "commander": c["name"] in commanders,
        "hidden": hidden(c),
        "tags": tags.get(c.get("oracle_id") or faces[0].get("oracle_id"), []),
        "legalities": c["legalities"],
        "edhrec_rank": c.get("edhrec_rank"),
        "image_uris": {"small": (f("image_uris") or {}).get("small")},
    }


def download_db():
    print("downloading Scryfall oracle bulk data...", flush=True)
    commanders = search_names("is:commander")
    tags = strategy_tags()
    meta = json.load(get("https://api.scryfall.com/bulk-data/oracle-cards"))
    with get(meta["jsonl_download_uri"]) as r, gzip.open(r, "rt", encoding="utf-8") as lines:
        cards = [slim(c, commanders, tags) for c in map(json.loads, lines) if c["layout"] != "art_series"]
    tmp = DB.with_suffix(".tmp")
    tmp.write_text(json.dumps(cards))
    tmp.replace(DB)


def load_db():
    global db, db_mtime
    with db_lock:  # requests run in threads; only one should download
        if DB.exists() and DB.stat().st_mtime != db_mtime:
            db, db_mtime = json.loads(DB.read_text()), DB.stat().st_mtime
        # also rebuild a database written before cards carried strategy tags
        if not DB.exists() or time.time() - DB.stat().st_mtime > MAX_AGE or (db and "tags" not in db[0]):
            try:
                download_db()
            except Exception as e:
                if not DB.exists():
                    raise
                print(f"download failed, using existing copy: {e}", flush=True)
        if DB.stat().st_mtime != db_mtime:
            db, db_mtime = json.loads(DB.read_text()), DB.stat().st_mtime


def owned_cards():
    load_db()
    names, collection = set(), HERE / "Cards.txt"
    for line in (collection.read_text() if collection.exists() else "").splitlines():
        # "Sol Ring", "1 Sol Ring" or "1 Sol Ring (C21) 263"; any quantity is ignored
        m = re.match(r"^\s*(?:\d+x?\s+)?(.+?)(?:\s+\([^)]+\).*)?\s*$", line)
        if m:
            names.add(m.group(1).lower().strip())
    return [c for c in db if c["name"].lower() in names or c["name"].split(" // ")[0].lower() in names]


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/owned.json":
            return self.send(200, json.dumps(owned_cards()).encode())
        if self.path == "/decks.json":
            return self.send(200, DECKS.read_bytes() if DECKS.exists() else b"{}")
        if self.path == "/commanders.json":  # names Scryfall's is:commander matches
            load_db()
            return self.send(200, json.dumps([c["name"] for c in db if c["commander"]]).encode())
        m = re.fullmatch(r"/edhrec/([a-z0-9-]+)", self.path)
        if not m:
            return super().do_GET()
        url = f"https://json.edhrec.com/pages/commanders/{m.group(1)}.json"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "deckbuilder"})
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read()
        except Exception as e:
            return self.send(502, str(e).encode())
        self.send(200, body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/Cards.txt":  # replace the collection
            (HERE / "Cards.txt").write_bytes(body)
            return self.send(200, b"{}")
        if self.path == "/cards.json":  # database entries for a JSON list of names
            load_db()
            names = set(json.loads(body))
            found = [c for c in db if c["name"] in names or c["name"].split(" // ")[0] in names]
            return self.send(200, json.dumps(found).encode())
        if self.path == "/decks.json":  # {"name": ..., "deck": {...}} saves one deck, "deck": null deletes it
            req = json.loads(body)
            with decks_lock:
                decks = json.loads(DECKS.read_text()) if DECKS.exists() else {}
                if req["deck"] is None:
                    decks.pop(req["name"], None)
                else:
                    decks[req["name"]] = req["deck"]
                tmp = DECKS.with_suffix(".tmp")
                tmp.write_text(json.dumps(decks))
                tmp.replace(DECKS)
            return self.send(200, b"{}")
        self.send(404, b"{}")

    def send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


load_db()
http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
