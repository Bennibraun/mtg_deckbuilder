
function slug(name) {
  return front(name).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/[\s-]+/g, '-');
}

const pages = {};  // EDHREC page promises by path (the server caches them for a week)
const edhPage = path => pages[path] ??= fetch('edhrec/' + path).then(r => r.ok ? r.json() : null).catch(() => null);
const pairSlug = d => cmdrs(d).map(slug).sort().join('-');
async function deckPage(d, kind = 'commanders', theme = d.theme) {
  const t = theme ? '/' + theme : '';
  const p = await edhPage(`${kind}/${pairSlug(d)}${t}`);
  return d.partner && (!p || p.missing || !p.lists.length) ? edhPage(`${kind}/${slug(d.commander)}${t}`) : p;
}

// {name: {syn, inc}} for a page, built once
function statsOf(page) {
  if (!page) return {};
  if (!page.stats) {
    page.stats = {};
    for (const l of page.lists) for (const [name, syn, inc] of l.cards) {
      page.stats[name] ??= { syn, inc };
      page.stats[front(name)] ??= page.stats[name];
    }
  }
  return page.stats;
}
const statFor = (stats, name) => stats[name] || stats[front(name)];
const score = s => s ? s.inc + s.syn : 0;
const describe = s => s ? `${s.syn >= 0 ? '+' : ''}${Math.round(s.syn * 100)}% syn · ${pct(s.inc)}` : 'not on EDHREC';

async function loadEdh() {
  const d = deck;
  edh = {}; edhCards = []; edhPageNow = null;
  if (!d.commander) return searchSoon();
  $('status').textContent = 'loading EDHREC...';
  const page = await deckPage(d);
  if (d !== deck) return;
  if (!page || page.missing) $('status').textContent = 'EDHREC has no page for this commander' + (d.theme ? ' and theme' : '');
  edhPageNow = page; edh = statsOf(page);
  edhCards = (await lookup(Object.keys(edh))).filter(Boolean);
  edhCards = [...new Map(edhCards.map(c => [c.name, c])).values()];
  searchSoon(); renderStats();
  if (currentView === 'tune') renderTune();
}
