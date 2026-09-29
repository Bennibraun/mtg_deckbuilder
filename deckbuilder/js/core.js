const $ = id => document.getElementById(id);
const norm = s => s.toLowerCase().trim();
const front = name => name.split(' // ')[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pct = x => Math.round(x * 100) + '%';

let ownedCards = [], ownedN = new Map();  // owned copies by lowercase name (full and front face)
// Decks live on the server in decks.json; every change is saved right away.
let decks = {}, deck = null;
let edh = {}, edhCards = [], edhPageNow = null;  // EDHREC stats by name for the current deck, their database entries, and the page
const cardData = {}, byNorm = new Map();  // database entries by name and by lowercase name, filled as cards are looked up
function keep(c) { cardData[c.name] = c; for (const n of [c.name, front(c.name)]) byNorm.set(norm(n), c); }

const ownedCount = name => ownedN.get(norm(name)) ?? ownedN.get(norm(front(name))) ?? 0;
const isOwned = name => ownedCount(name) > 0;

// Database entries for names; Scryfall search results kept earlier lack roles and get replaced.
async function lookup(names) {
  const get = n => n && (cardData[n] || byNorm.get(norm(n)));
  const want = [...new Set(names)].filter(n => n && !get(n)?.roles);
  if (want.length) (await (await fetch('cards.json', { method: 'POST', body: JSON.stringify(want) })).json()).forEach(keep);
  return names.map(get);
}

async function loadCollection() {
  $('status').textContent = 'loading card database...';
  ownedCards = await (await fetch('owned.json')).json();
  ownedN = new Map();
  for (const c of ownedCards) { keep(c); ownedN.set(norm(c.name), c.owned); ownedN.set(norm(front(c.name)), c.owned); }
  $('status').textContent = `${ownedCards.length} owned cards loaded`;
}

$('upload').onchange = async () => {
  const file = $('upload').files[0];
  if (!file || !confirm(`Replace your collection with ${file.name}?`)) return ($('upload').value = '');
  const added = await (await fetch('Cards.txt', { method: 'POST', body: file })).json();
  $('upload').value = '';
  await loadCollection();
  renderDeck(); searchSoon();
  const names = Object.keys(added);
  if (names.length && confirm(`${names.length} new cards since the last upload. Check which decks they fit?`)) { showView('fit'); runFit(names, 'new since last upload'); }
};
