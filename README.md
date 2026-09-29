# mtg_deckbuilder

## Deckbuilder hosting (Docker Compose + nginx)

Serves `deckbuilder/` on `127.0.0.1:8000` behind nginx. `Cards.txt`, `decks.json` and `cards-db.json` live in the mounted folder and are gitignored, so pulls never touch them.

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
