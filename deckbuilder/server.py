#!/usr/bin/env python3
"""Static file server, cached EDHREC proxy (EDHREC sends no CORS headers), and owned-card
lookup against Scryfall's oracle bulk data, re-downloaded when over a week old."""
import datetime
import gzip
import http.server
import json
import pathlib
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
HERE = pathlib.Path(__file__).parent
DB = HERE / "cards-db-v2.json"  # bump the name when slim() gains fields to force a fresh download
DECKS = HERE / "decks.json"
COLLECTION = HERE / "Cards.txt"
ADDITIONS = HERE / "additions.json"
CACHE = HERE / "edhrec-cache"
EDHREC_PATH = re.compile(r"/edhrec/((?:commanders|cards|average-decks)/[a-z0-9-]+(?:/[a-z0-9-]+)?)")
decks_lock = threading.Lock()
MAX_AGE = 7 * 86400
HEADERS = {"User-Agent": "deckbuilder/1.0", "Accept": "application/json"}
db, db_mtime, db_lock = [], 0, threading.Lock()


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=120)


def write_atomic(path, text):
    tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
    tmp.write_text(text)
    tmp.replace(path)


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


def slim(c, commanders):
    faces = c.get("card_faces") or [c]
    f = lambda k: c.get(k) or faces[0].get(k)
    stat = lambda k: [x[k] for x in [c, *faces] if x.get(k) is not None]
    return {
        "name": c["name"],
        "cmc": c.get("cmc", 0),
        "mana_cost": f("mana_cost") or "",
        "type_line": c.get("type_line", ""),
        "oracle_text": c.get("oracle_text") or "\n".join(x.get("oracle_text", "") for x in faces),
        "colors": c.get("colors") or sorted({col for x in faces for col in x.get("colors", [])}),
        "color_identity": c["color_identity"],
        "produced_mana": c.get("produced_mana", []),
        "power": stat("power"), "toughness": stat("toughness"), "loyalty": stat("loyalty"),
        "commander": c["name"] in commanders,
        "game_changer": c.get("game_changer", False),
        "hidden": hidden(c),
        "legalities": c["legalities"],
        "edhrec_rank": c.get("edhrec_rank"),
        "usd": c.get("prices", {}).get("usd"),
        "image_uris": {"small": (f("image_uris") or {}).get("small")},
    }


def download_db():
    print("downloading Scryfall oracle bulk data...", flush=True)
    commanders = search_names("is:commander")
    meta = json.load(get("https://api.scryfall.com/bulk-data/oracle-cards"))
    with get(meta["jsonl_download_uri"]) as r, gzip.open(r, "rt", encoding="utf-8") as lines:
        cards = [slim(c, commanders) for c in map(json.loads, lines) if c["layout"] != "art_series"]
    write_atomic(DB, json.dumps(cards))
    (HERE / "cards-db.json").unlink(missing_ok=True)  # previous format


def load_db():
    global db, db_mtime
    with db_lock:  # requests run in threads; only one should download
        if not DB.exists() or time.time() - DB.stat().st_mtime > MAX_AGE:
            try:
                download_db()
            except Exception as e:
                if not DB.exists():
                    raise
                print(f"download failed, using existing copy: {e}", flush=True)
        if DB.stat().st_mtime != db_mtime:
            db, db_mtime = json.loads(DB.read_text()), DB.stat().st_mtime


def find_cards(names):
    """Database entries for card names, ignoring case; a double-faced card also matches its front name."""
    want = {n.lower() for n in names}
    return [c for c in db if c["name"].lower() in want or c["name"].split(" // ")[0].lower() in want]


def parse_collection(text):
    """{lowercase name: [name, copies]} from a "count name (SET) number" list."""
    counts = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(\d+)\s+(.+?)\s+\([^)]+\)", line) or re.match(r"^\s*(\d+)\s+(.+?)\s*$", line)
        if m:
            name = m.group(2).strip()
            counts.setdefault(name.lower(), [name, 0])[1] += int(m.group(1))
    return counts


def owned_cards():
    load_db()
    counts = parse_collection(COLLECTION.read_text() if COLLECTION.exists() else "")
    out = []
    for c in db:
        n = counts.get(c["name"].lower()) or counts.get(c["name"].split(" // ")[0].lower())
        if n:
            out.append({**c, "owned": n[1]})
    return out


def replace_collection(body):
    """Save a new Cards.txt and record which cards gained copies since the previous one."""
    new = parse_collection(body.decode("utf-8", "replace"))
    added = {}
    if COLLECTION.exists():
        old = parse_collection(COLLECTION.read_text())
        added = {name: n - old.get(k, [0, 0])[1] for k, (name, n) in new.items() if n > old.get(k, [0, 0])[1]}
        write_atomic(ADDITIONS, json.dumps({"date": datetime.date.today().isoformat(), "cards": added}))
    COLLECTION.write_bytes(body)
    return added


def slim_edhrec(page):
    """The parts of an EDHREC page the client uses: card lists as [name, synergy, inclusion]."""
    lists = []
    for cl in page.get("container", {}).get("json_dict", {}).get("cardlists", []):
        cards = [[c["name"], round(c.get("synergy") or 0, 3),
                  round(c["num_decks"] / c["potential_decks"], 3) if c.get("potential_decks") else 0]
                 for c in cl.get("cardviews", [])]
        lists.append({"header": cl.get("header"), "cards": cards})
    panels = page.get("panels") or {}
    deck = [c for cs in ((page.get("deck") or {}).get("cards") or {}).values() for c in cs]
    return {"lists": lists, "themes": panels.get("taglinks") or [], "curve": panels.get("mana_curve"), "deck": deck}


def edhrec(path):
    """A slimmed EDHREC page, cached on disk for a week; pages EDHREC doesn't have are cached as empty."""
    file = CACHE / (path.replace("/", "__") + ".json")
    if file.exists() and time.time() - file.stat().st_mtime < MAX_AGE:
        return file.read_bytes()
    try:
        with get(f"https://json.edhrec.com/pages/{path}.json") as r:
            body = json.dumps(slim_edhrec(json.load(r)))
    except urllib.error.HTTPError as e:
        if e.code not in (403, 404):
            raise
        body = json.dumps({"lists": [], "themes": [], "curve": None, "deck": [], "missing": True})
    except Exception:
        if file.exists():
            return file.read_bytes()  # stale beats nothing
        raise
    CACHE.mkdir(exist_ok=True)
    write_atomic(file, body)
    return body.encode()


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/owned.json":
            return self.send(200, json.dumps(owned_cards()).encode())
        if self.path == "/decks.json":
            return self.send(200, DECKS.read_bytes() if DECKS.exists() else b"{}")
        if self.path == "/additions.json":
            return self.send(200, ADDITIONS.read_bytes() if ADDITIONS.exists() else b"{}")
        m = EDHREC_PATH.fullmatch(self.path)
        if not m:
            return super().do_GET()
        try:
            self.send(200, edhrec(m.group(1)))
        except Exception as e:
            self.send(502, str(e).encode())

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/Cards.txt":  # replace the collection, returns {name: copies gained}
            return self.send(200, json.dumps(replace_collection(body)).encode())
        if self.path == "/cards.json":  # database entries for a JSON list of names
            load_db()
            return self.send(200, json.dumps(find_cards(json.loads(body))).encode())
        if self.path == "/decks.json":  # {"name": ..., "deck": {...}} saves one deck, "deck": null deletes it
            req = json.loads(body)
            with decks_lock:
                decks = json.loads(DECKS.read_text()) if DECKS.exists() else {}
                if req["deck"] is None:
                    decks.pop(req["name"], None)
                else:
                    decks[req["name"]] = req["deck"]
                write_atomic(DECKS, json.dumps(decks))
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
