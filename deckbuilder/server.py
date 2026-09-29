#!/usr/bin/env python3
"""Static file server, cached EDHREC proxy (EDHREC sends no CORS headers), and owned-card
lookup against Scryfall's oracle bulk data, re-downloaded when over a week old, and a
cached Commander Spellbook proxy for combos."""
import datetime
import hashlib
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
DB = HERE / "cards-db-v5.json"  # bump the name when slim() gains fields to force a fresh download
OLD_DBS = ["cards-db.json", "cards-db-v2.json", "cards-db-v3.json", "cards-db-v4.json"]
DECKS = HERE / "decks.json"
COLLECTION = HERE / "Cards.txt"
ADDITIONS = HERE / "additions.json"
STATE = HERE / "state.json"
CACHE = HERE / "edhrec-cache"
EDHREC_PATH = re.compile(r"/edhrec/((?:commanders|cards|average-decks)/[a-z0-9-]+(?:/[a-z0-9-]+)?)")
decks_lock, state_lock = threading.Lock(), threading.Lock()
MAX_AGE = 7 * 86400
HEADERS = {"User-Agent": "deckbuilder/1.0", "Accept": "application/json"}
# Scryfall Tagger oracle tags (curated by hand, child tags included), from their bulk file:
# roles drive the deck template, playtest odds and cut suggestions; strategies group the deck list.
ROLE_TAGS = {"ramp": "ramp", "draw": "draw", "removal": "spot-removal", "wipe": "sweeper", "tutor": "tutor"}
# label -> tag slug(s). Staples are what most decks run; themes are what a deck is built around.
STAPLES = {
    "Ramp": "ramp", "Card draw": "draw", "Removal": "removal", "Board wipe": "sweeper",
    "Counterspell": "counterspell", "Tutor": "tutor", "Protection": "protection", "Recursion": "recursion",
}
THEMES = {
    "Lifegain": "lifegain", "Lifegain payoff": "lifegain-matters", "Drain": "drain-life",
    "Landfall & lands": "lands-matter", "Extra land drops": "extra-land",
    "+1/+1 counters": "gives-pp-counters", "Counters matter": "counters-matter",
    "Tokens": "repeatable-token-generator", "Token payoff": "synergy-token", "Treasure": "repeatable-treasures",
    "Sacrifice outlet": "sacrifice-outlet", "Death triggers": "death-trigger",
    "Reanimation": "reanimate", "Self-mill": "mill-self", "Graveyard payoff": "cards-in-graveyard-matter",
    "Cast from graveyard": "castable-from-graveyard", "Mill": "mill",
    "Spellslinger": ["synergy-instant", "synergy-sorcery", "synergy-noncreature"], "Spell copy": "copy-spell",
    "Artifacts matter": "synergy-artifact", "Enchantments matter": "synergy-enchantment",
    "Equipment": ["synergy-equipment", "quick-equip"], "Auras": "synergy-aura", "Vehicles": "synergy-vehicle",
    "Legends matter": "synergy-legendary", "Flicker": "flicker", "Copy & clones": "copy",
    "Anthem": "anthem", "Evasion": "gives-evasion", "Haste": "gives-haste", "Extra combat": "extra-combat-phase",
    "Attack triggers": "attack-trigger", "Loot & discard": ["loot", "rummage", "discard-outlet"],
    "Discard payoff": "discard-matters", "Wheels": "wheel", "Impulse draw": "impulse",
    "Cost reduction": "cost-reducer", "Untap": "untapper", "Theft": "theft", "Bounce": "bounce",
    "Burn": "burn", "Group slug": "group-slug", "Group hug": "group-hug", "Tax": "tax", "Fog": "fog",
    "Extra turns": "extra-turn", "Poison": "poison-mechanics", "Energy": "energy-generator",
    "Typal": "typal", "Trigger doubling": "trigger-doubler",
}
STRATEGIES = {**STAPLES, **THEMES}
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


def oracle_tags(*mappings):
    """For each {label: tag slug} mapping, {oracle_id: [labels]} from Scryfall's Oracle Tags bulk file."""
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

    out = []
    for mapping in mappings:
        index = {}
        for label, slugs in mapping.items():
            ids = set().union(*(oracle_ids(by_slug[s], set()) for s in ([slugs] if isinstance(slugs, str) else slugs) if s in by_slug))
            for oid in ids:
                index.setdefault(oid, []).append(label)
        out.append(index)
    return out


strategies_cache = [None, None]  # [db_mtime, body]


def strategies_json():
    """Each strategy's kind, Scryfall query and share of Commander-legal cards that have it."""
    load_db()
    if strategies_cache[0] != db_mtime:
        pool = [c for c in db if not c["hidden"] and c["legalities"].get("commander") == "legal" and "Land" not in c["type_line"]]
        counts = {}
        for c in pool:
            for t in c["tags"]:
                counts[t] = counts.get(t, 0) + 1
        slugs = lambda v: [v] if isinstance(v, str) else v
        body = {label: {"kind": "staple" if label in STAPLES else "theme",
                        "query": " or ".join(f"otag:{x}" for x in slugs(v)),
                        "rate": counts.get(label, 0) / len(pool)} for label, v in STRATEGIES.items()}
        strategies_cache[:] = [db_mtime, json.dumps(body).encode()]
    return strategies_cache[1]


def slim(c, commanders, roles, strategies):
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
        "roles": roles.get(c.get("oracle_id") or faces[0].get("oracle_id"), []),
        "tags": strategies.get(c.get("oracle_id") or faces[0].get("oracle_id"), []),
        "hidden": hidden(c),
        "legalities": c["legalities"],
        "edhrec_rank": c.get("edhrec_rank"),
        "usd": c.get("prices", {}).get("usd"),
        "image_uris": {"small": (f("image_uris") or {}).get("small")},
    }


def download_db():
    print("downloading Scryfall oracle bulk data...", flush=True)
    commanders = search_names("is:commander")
    roles, strategies = oracle_tags(ROLE_TAGS, STRATEGIES)
    meta = json.load(get("https://api.scryfall.com/bulk-data/oracle-cards"))
    with get(meta["jsonl_download_uri"]) as r, gzip.open(r, "rt", encoding="utf-8") as lines:
        cards = [slim(c, commanders, roles, strategies) for c in map(json.loads, lines) if c["layout"] != "art_series"]
    write_atomic(DB, json.dumps(cards))
    for old in OLD_DBS:  # previous formats
        (HERE / old).unlink(missing_ok=True)


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


def one_per_name(cards):
    """Tokens and other hidden cards can share a name with a real card (Llanowar Elves); keep the real one."""
    best = {}
    for c in cards:
        if c["name"] not in best or best[c["name"]]["hidden"] and not c["hidden"]:
            best[c["name"]] = c
    return list(best.values())


def find_cards(names):
    """Database entries for card names, ignoring case; a double-faced card also matches its front name."""
    want = {n.lower() for n in names}
    return one_per_name(c for c in db if c["name"].lower() in want or c["name"].split(" // ")[0].lower() in want)


def parse_collection(text):
    """{lowercase name: [name, copies]} from lines like "Sol Ring", "1 Sol Ring" or "1 Sol Ring (C21) 263"."""
    counts = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(?:(\d+)x?\s+)?(.+?)(?:\s+\([^)]+\).*)?\s*$", line)
        if m and m.group(2).strip():
            name = m.group(2).strip()
            counts.setdefault(name.lower(), [name, 0])[1] += int(m.group(1) or 1)
    return counts


def owned_cards():
    load_db()
    counts = parse_collection(COLLECTION.read_text() if COLLECTION.exists() else "")
    out = []
    for c in db:
        n = counts.get(c["name"].lower()) or counts.get(c["name"].split(" // ")[0].lower())
        if n:
            out.append({**c, "owned": n[1]})
    return one_per_name(out)


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


def combos(req):
    """Commander Spellbook combos in a deck and one card away, cached for a day.
    req: {"commanders": [names], "main": [names]}"""
    body = json.dumps({"commanders": [{"card": n} for n in sorted(req["commanders"])],
                       "main": [{"card": n} for n in sorted(req["main"])]}).encode()
    file = CACHE / f"spellbook__{hashlib.sha1(body).hexdigest()}.json"
    if file.exists() and time.time() - file.stat().st_mtime < 86400:
        return file.read_bytes()
    out, url = {"included": [], "almostIncluded": []}, "https://backend.commanderspellbook.com/find-my-combos"
    while url:
        r = urllib.request.Request(url, data=body, headers={**HEADERS, "Content-Type": "application/json"})
        with urllib.request.urlopen(r, timeout=60) as resp:
            page = json.load(resp)
        for key in out:
            out[key] += [{
                "id": c["id"],
                "cards": [u["card"]["name"] for u in c["uses"]],
                "produces": [p["feature"]["name"] for p in c["produces"]],
                "mv": c.get("manaValueNeeded"),
                "popularity": c.get("popularity") or 0,
                "prereq": "\n".join(x for x in (c.get("easyPrerequisites"), c.get("notablePrerequisites")) if x),
                "steps": c.get("description", ""),
            } for c in page["results"].get(key, [])]
        url = page.get("next")
    text = json.dumps(out)
    CACHE.mkdir(exist_ok=True)
    write_atomic(file, text)
    return text.encode()


def update_json(path, lock, key, value):
    """Set (or with value None, delete) one key of a JSON object file."""
    with lock:
        data = json.loads(path.read_text()) if path.exists() else {}
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
        write_atomic(path, json.dumps(data))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)  # not the working directory

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # revalidate so updates show up without a hard reload
        super().end_headers()

    def do_GET(self):
        if self.path == "/owned.json":
            return self.send(200, json.dumps(owned_cards()).encode())
        if self.path == "/decks.json":
            return self.send(200, DECKS.read_bytes() if DECKS.exists() else b"{}")
        if self.path == "/additions.json":
            return self.send(200, ADDITIONS.read_bytes() if ADDITIONS.exists() else b"{}")
        if self.path == "/state.json":
            return self.send(200, STATE.read_bytes() if STATE.exists() else b"{}")
        if self.path == "/strategies.json":
            return self.send(200, strategies_json())
        if self.path == "/commanders.json":  # names Scryfall's is:commander matches
            load_db()
            return self.send(200, json.dumps([c["name"] for c in db if c["commander"]]).encode())
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
            update_json(DECKS, decks_lock, req["name"], req["deck"])
            return self.send(200, b"{}")
        if self.path == "/state.json":  # {"key": ..., "value": ...} app settings shared across devices
            req = json.loads(body)
            update_json(STATE, state_lock, req["key"], req["value"])
            return self.send(200, b"{}")
        if self.path == "/combos.json":
            try:
                return self.send(200, combos(json.loads(body)))
            except Exception as e:
                return self.send(502, json.dumps(str(e)).encode())
        self.send(404, b"{}")

    def send(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


load_db()
http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
