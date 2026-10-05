
// On phones the deck sidebar is its own "Deck" tab.
const phone = matchMedia('(max-width: 820px)');
let currentView = 'search';
function showView(v) {
  if (v === 'deck' && !phone.matches) v = 'search';
  currentView = v;
  document.body.classList.toggle('deckview', v === 'deck');
  localStorage.setItem('view', v);
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.view === v);
  for (const s of document.querySelectorAll('.view')) s.classList.toggle('on', s.id === 'v-' + v);
  if (v === 'tune' && deck) renderTune();
  if (v === 'coll' && deck) renderShop(false);
  if (v === 'fit' && fitRows.length) renderFit();
  if (v === 'play' && deck) renderPlay();
  if (v === 'dash' && deck) renderDash();
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showView(b.dataset.view);
phone.onchange = () => { if (!phone.matches && currentView === 'deck') showView('search'); };

$('form').oninput = $('querybar').oninput = searchSoon;
$('dgroup').onchange = $('dsort').onchange = () => { localStorage.setItem('deckView', $('dgroup').value + ' ' + $('dsort').value); renderDeck(); };
[$('dgroup').value, $('dsort').value] = (localStorage.getItem('deckView') || 'type cmc').split(' ');
const decklist = names => names.map(n => `${isCmdr(deck, n) ? 1 : qty(deck, n)} ${n}`).join('\n');
$('export').onclick = () => navigator.clipboard.writeText(decklist([...cmdrs(deck), ...[...deck.cards].sort()]));
// cards you don't own (e.g. to print proxies); basic lands left out
$('exportmissing').onclick = () => {
  const names = [...cmdrs(deck), ...[...deck.cards].sort()].filter(n => !isOwned(n) && !deck.info[n]?.any);
  navigator.clipboard.writeText(decklist(names));
  $('status').textContent = `copied ${names.length} cards you don't own`;
};

const sets = fetch('https://api.scryfall.com/sets').then(r => r.json()).then(r => {
  for (const x of r.data) { const o = document.createElement('option'); o.value = x.code; o.label = x.name; $('sets').appendChild(o); }
  return r.data;
});
showView(localStorage.getItem('view') || 'dash');
Promise.all([loadCollection().then(loadDecks), loadState()]).then(async () => checkNewSets(await sets));
