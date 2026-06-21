// One-off: import Brandon's Tokyo restaurant list into the japan-2026 trip.
// Merges the 3 PDF tables into clean records, geocodes via OSM Nominatim,
// tags source "Brandon's List", dedupes vs existing base_places + manual,
// and appends to the trip's base_places. Run: node scripts/import-brandon.js
const API = 'https://japan-trip-production-3cf4.up.railway.app';

// [name, neighborhood, why, kidFriendly, booking, topPick, city]
const R = [
  ['Koffee Mameya Kakeru','Omotesando','Specialty café',false,'',false],
  ['Andaz Bar','Toranomon','Hotel bar',true,'',false],
  ['High Five','Ginza','Classic Ginza cocktail bar',false,'',false],
  ['New York Bar','Shinjuku','Famous Park Hyatt hotel bar',false,'',false],
  ['Star Bar','Ginza','Famous Ginza cocktail bar',false,'',false],
  ['Memento Mori','Shibuya','Top 50 bar — cacao cocktails',true,'',false],
  ['Tokyo Whisky Library','Aoyama','Whisky specialty bar',false,'',false],
  ['Coffee Wrights Omotesando','Omotesando','Specialty coffee',true,'',false],
  ['Glitch Coffee Ginza','Ginza',"B's favorite coffee",false,'',false],
  ['Koffee Mameya','Omotesando','Specialty coffee',true,'',false],
  ['Parklet','Daikanyama',"Diffley's favorite coffee shop",true,'',false],
  ['Sarutahiko Coffee The Bridge','Ebisu',"B's favorite coffee",true,'',false],
  ['Sense','Nihonbashi','Michelin Cantonese at Mandarin Oriental',false,'',true],
  ['Lawsonstore100','Shinjuku','Konbini — known for karaage chicken',true,'',false],
  ['Ete','Shibuya','Unique dessert',true,'',false],
  ['Kanadaya','Shibuya','Dessert',true,'',false],
  ['Snowy Village','Harajuku','Matcha bingsoo',true,'',false],
  ['Higuma Doughnuts x Coffee Wrights','Omotesando','Honey donut with mascarpone',true,'',false],
  ['Quintessence','Shinagawa','French — 3 Michelin stars',false,'',false],
  ['Florilege','Aoyama',"French/Japanese — Brian Kim's top pick",false,'',true],
  ['Asahina Gastronome','Nihonbashi','French/Japanese fusion — Michelin 2-star',true,'',false],
  ['Cycle Restaurant','Ebisu',"French/Japanese fusion — B's top 10 pick",true,'',true],
  ["L'Effervescence",'Minami-Aoyama',"French/Japanese fusion — Brian Kim's top pick",false,'',true],
  ['Hikiniku','Shibuya','Hamburger patty, casual',true,'',false],
  ["Mark's",'Omotesando',"Italian — Diffley's pick",true,'Have res',false],
  ['Ristorante Honda','Aoyama','Italian, casual',true,'',false],
  ['Jomon','Roppongi',"Izakaya — Brian Kim's casual pick",true,'',false],
  ['Kien','Ginza',"Kaiseki fine dining — Brian Kim's top pick",true,'',true],
  ['Narisawa','Aoyama','Modern Japanese/French — Michelin 2-star',false,'',false],
  ['Ryugin','Roppongi',"Modern kaiseki — Michelin 3-star, Brian Kim's top pick",false,'No dinner res avail',true],
  ['Heichan','Asakusa','Specialty oden',false,'would go here',true],
  ['Pizza Marumo','Shibuya','Pizza, casual',true,'',false],
  ['Pizza Studio Tamaki','Azabu-Juban','Pizza, casual',true,'',false],
  ['Savoy','Azabu-Juban','Pizza, casual',true,'',false],
  ['The Pizza Bar on 38th','Marunouchi','Pizza at Mandarin Oriental — Michelin-star',true,'',false],
  ['PST Studio','Omotesando',"Pizza — Perry's pick",true,'',false],
  ['Chuka Soba Ginza Hachigou','Ginza','Michelin ramen',true,'',false],
  ['Fuunji','Shinjuku','Tsukemen specialty ramen',true,'',false],
  ['Nakiryu','Otsuka','Michelin-star ramen',false,'',false],
  ['Tsuta','Yoyogi-Uehara','Michelin-star ramen',true,'',false],
  ['Azukitokouri','Kichijoji','Shaved ice',true,'',false],
  ['Tamawarai','Harajuku','Soba',true,'',false],
  ['Shima Steak','Nihonbashi','Steakhouse — famous wagyu & steak sando',false,'',false],
  ['Daiwa Sushi','Tsukiji','Casual sushi at Tsukiji',true,'',false],
  ['Jiro','Ginza','Michelin-star sushi (Sukiyabashi Jiro)',false,'',false],
  ['Kobikicho Tomiko','Ginza','Michelin-star sushi',true,'',false],
  ['Sushi Dai','Tsukiji','Casual sushi at Tsukiji',true,'checking',false],
  ['Sushi Ishiyama','Ginza',"Takao Ishiyama's omakase sushi",false,'no mondays / call andy',true],
  ['Sushi Masuda','Aoyama',"Michelin 2-star sushi — Brian Kim's pick",false,'no mondays',false],
  ['Sushi Saito','Akasaka','Michelin-star sushi',false,'',false],
  ['Sushi Sawada','Ginza','Michelin-star sushi',false,'',false],
  ['Tachigui-sushi Akita','Shibuya','Standing sushi, casual',false,'no avails',false],
  ['Gem Yamamoto','Ginza','Sushi omakase',false,'',false],
  ['Hakkoku','Ginza',"Sushi omakase — Diffley's pick",false,'Have res',true],
  ['Tempura Kondo','Ginza','Michelin-star tempura',false,'',false],
  ['Tofuya Ukai','Shiba',"Tofu kaiseki fine dining — Brian Kim's pick",true,'',false],
  ['Butagumi','Nishi-Azabu',"Tonkatsu — Perry's favorite",true,'',false],
  ['Ginza Bairin','Ginza','Tonkatsu',true,'',false],
  ['Katsukichi','Shibuya','Tonkatsu — Michelin-star',true,'',false],
  ['Tonki','Meguro','Famous tonkatsu',true,'',false],
  ['Shin Udon','Shinjuku','Casual udon',true,'',false],
  ['Obana','Minami-Senju','Unagi',true,'',false],
  ['Tsujihan','Nihonbashi','Uni roe rice bowl',true,'',false],
  ['Sumini Yakiniku Nakahara','Akasaka','Wagyu yakiniku',true,'',false],
  ['Ushigoro S','Roppongi','Wagyu yakiniku',true,'',false],
  ['Yakitori Masakichi','Roppongi',"Yakitori — David Chang's best yakitori pick",true,'',false],
  ['Cokuun','Ginza','Matcha oat coffee omakase',true,'',false],
  ['Kisaburo Nojo','Shibuya','Rice buffet',true,'',false],
  ["I'm Donut?",'Shibuya','Doughnuts',true,'',false],
  ['Bongen Coffee','Ginza','Café',true,'',false],
  ['Omoide Yokocho','Shinjuku','Retro food alley',true,'',false],
  ['Hajime','Osaka',"French/Japanese fusion — Michelin 3-star, Osaka's best meal",true,'',true,'Osaka'],
  ['Gion Matayoshi','Gion','Kyoto kaiseki',true,'',false,'Kyoto'],
];

const CITY_FALLBACK = { Tokyo:[35.68,139.77], Osaka:[34.69,135.50], Kyoto:[35.01,135.77] };
let seed = 7;
function jitter(){ seed = (seed*9301+49297)%233280; return (seed/233280 - 0.5)*0.01; }

async function geocode(q){
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q='+encodeURIComponent(q),
      { headers:{'User-Agent':'DrazinFamilyTripPlanner/1.0 (personal)'} });
    if(!r.ok) return null;
    const a = await r.json();
    return (Array.isArray(a)&&a.length) ? { lat:parseFloat(a[0].lat), lng:parseFloat(a[0].lon) } : null;
  } catch(e){ return null; }
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

(async () => {
  const trip = await (await fetch(API+'/api/trips/japan-2026')).json();
  const state = await (await fetch(API+'/api/state?trip=japan-2026')).json();
  const existing = new Set([...(trip.base_places||[]), ...(state.manual||[])].map(p => (p.name||'').toLowerCase().trim()));

  const toAdd = []; let geo=0, fell=0, dup=0;
  for (const rec of R) {
    const [name, hood, why, kid, booking, top, city='Tokyo'] = rec;
    if (existing.has(name.toLowerCase().trim())) { dup++; console.log('  dup, skip:', name); continue; }
    let g = await geocode(`${name}, ${hood}, ${city}, Japan`); await sleep(1200);
    if (!g) { g = await geocode(`${hood}, ${city}, Japan`); await sleep(1200); if (g) fell++; }
    let lat, lng;
    if (g) { lat = g.lat; lng = g.lng; geo++; }
    else { const b = CITY_FALLBACK[city]||CITY_FALLBACK.Tokyo; lat=b[0]+jitter(); lng=b[1]+jitter(); }
    toAdd.push({ name, city, neighborhood: hood, category:'Food', why,
      family_fit: kid ? 'Kid-friendly' : 'Not especially kid-friendly',
      booking: booking||'', priority: top?4:3, heat:'Indoor', days:'',
      source:"Brandon's List", lat, lng, url:'' });
    console.log(`  + ${name} (${city}/${hood}) ${g?'geo':'fallback'}`);
  }
  console.log(`\nNew: ${toAdd.length} | geocoded: ${geo} | area-fallback included | dups skipped: ${dup}`);

  const merged = [...(trip.base_places||[]), ...toAdd];
  const res = await fetch(API+'/api/trips/japan-2026', { method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ basePlaces: merged }) });
  console.log('PUT base_places ('+merged.length+'):', res.status, await res.text());
})();
