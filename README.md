# mtg_deckbuilder

## Deckbuilder hosting (Docker Compose + nginx)

Serves `deckbuilder/` on `127.0.0.1:8000` behind nginx. `Cards.txt` and `cards-db.json` live in the mounted folder and are gitignored, so pulls never touch them.

1. Clone and add your collection:
   ```bash
   git clone https://github.com/Bennibraun/mtg_deckbuilder.git ~/mtg_deckbuilder
   cp /path/to/Cards.txt ~/mtg_deckbuilder/deckbuilder/
   ```
2. Start on boot:
   ```bash
   sudo systemctl enable docker
   cd ~/mtg_deckbuilder/deckbuilder && docker compose up -d
   docker compose logs -f   # first start downloads the card database
   ```
3. nginx site at `/etc/nginx/sites-available/deckbuilder`:
   ```nginx
   server {
       listen 80;
       server_name deck.example.com;
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
4. Auto-update every 15 minutes (`sudo crontab -e`, replace `/home/you`):
   ```
   */15 * * * * cd /home/you/mtg_deckbuilder && git fetch -q && [ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ] && git pull -q && docker restart deckbuilder
   ```
   If git refuses with "dubious ownership", put the line in your own crontab instead and add yourself to the docker group (`sudo usermod -aG docker you`, then log in again).

There is no login; anyone who can reach the URL sees your collection.
