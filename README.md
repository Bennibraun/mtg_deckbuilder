# mtg_deckbuilder

Commander deckbuilder over your own collection:

- **Search**: Scryfall search with owned cards first, sortable by EDHREC synergy for the deck's commander.
- **Fit check**: paste cards, review a whole set, check what the last Cards.txt upload added, or press "Fit?" on any card. Every card is scored against each of your decks (color identity, EDHREC synergy and inclusion, EDHREC's top commanders for the card, creature types the deck is built around, Commander Spellbook combos it completes, partners and backgrounds), with one-click add, swap for a suggested cut (same role first: ramp for ramp, removal for removal), or maybeboard.
- **New sets**: sets released in the last 60 days or being previewed show up as alerts with how many cards fit your decks, and again a few weeks later once EDHREC has data on them.
- **Tune deck**: cut candidates, owned upgrades, a diff against EDHREC's average deck, EDHREC themes, and combos in the deck or one card away.
- **Playtest**: exact opening hand and land drop odds, and sample hands with mulligans.
- **Collection**: shopping list with prices, cards used by more decks than you own copies of, and which of your commanders your collection already covers best.
- **Sidebar**: decklist import (Moxfield, Archidekt, MTGA, plain text), add with autocomplete (`/`, Shift+Enter for a fit check), partner / background commanders, quantities for basics, maybeboard, stats (curve, lands/ramp/draw/removal/wipes from Scryfall's role tags, color sources, Game Changers and two-card combos for brackets, value), a per-deck history with undo, and "Copy unowned" for proxies.
- **Phones**: the deck sidebar becomes a "Deck" tab.

Code: `deckbuilder/server.py` (static files, card database, EDHREC and Commander Spellbook proxies with caches), `deckbuilder/index.html` + `style.css`, and `deckbuilder/js/` (plain scripts sharing globals, loaded in order by `index.html`).

Test: `tests/run.sh` serves a copy of the app with a small fixture collection and drives every feature in headless Chromium (needs Node 18+).

## Deckbuilder hosting (Docker Compose + nginx)

Serves `deckbuilder/` on `127.0.0.1:8000` behind nginx. `Cards.txt`, `decks.json`, `additions.json` (cards gained in the last Cards.txt upload), `state.json` (shared settings such as reviewed sets), `cards-db-v3.json` and the `edhrec-cache/` folder (EDHREC pages refreshed weekly, combos daily) live in the mounted folder and are gitignored, so pulls never touch them.

1. Clone and add your collection:
   ```bash
   git clone https://github.com/Bennibraun/mtg_deckbuilder.git ~/mtg_deckbuilder
   cp /path/to/Cards.txt ~/mtg_deckbuilder/deckbuilder/   # or use "Upload Cards.txt" on the page
   ```
2. Start on boot:
   ```bash
   sudo systemctl enable docker
   cd ~/mtg_deckbuilder/deckbuilder && docker compose up -d
   docker compose logs -f   # first start downloads the card database
   ```
3. Create a login (prompts for a password):
   ```bash
   sudo apt install apache2-utils
   sudo htpasswd -c /etc/nginx/.htpasswd you
   ```
4. nginx site at `/etc/nginx/sites-available/deckbuilder`:
   ```nginx
   server {
       listen 80;
       server_name deck.example.com;
       auth_basic "Deckbuilder";
       auth_basic_user_file /etc/nginx/.htpasswd;
       client_max_body_size 10m;  # Cards.txt uploads
       location / {
           proxy_pass http://127.0.0.1:8000;
           proxy_read_timeout 300s;  # weekly database download on first request
       }
   }
   ```
   ```bash
   sudo ln -s /etc/nginx/sites-available/deckbuilder /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. HTTPS, required because basic auth sends the password in plain text over HTTP:
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d deck.example.com
   ```
6. Auto-update every 15 minutes (`sudo crontab -e`, replace `/home/you`):
   ```
   */15 * * * * cd /home/you/mtg_deckbuilder && git fetch -q && [ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ] && git pull -q && docker restart deckbuilder
   ```
   If git refuses with "dubious ownership", put the line in your own crontab instead and add yourself to the docker group (`sudo usermod -aG docker you`, then log in again).
