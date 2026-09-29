#!/usr/bin/env node
// Kontrola zdraví řetězce bezplatných LLM z providers.json.
//
// PROČ: free modely se ruší a padají ve vlnách (naměřeno: gemini-2.5-flash a
// 2.0-flash → 404, flash-latest → 503, mistral-large na free tieru → 403).
// Bez téhle kontroly se mrtvý model odhalí až uprostřed běhu agenta a spálí
// celý pokus. Tahle kontrola řekne "tento model už nejede" PŘED dalším během.
//
// CO DĚLÁ (bez sazení na jeden zdroj pravdy):
//   1) GET {baseUrl}/models  – zadarmo, odhalí modely, které zmizely z katalogu
//   2) POST chat/completions s max_tokens=1 – autoritativní "odpoví teď?"
//      a odhalí 404 (model pryč), 429 (kvóta), 503 (nedostupný), 401/403 (klíč/tier)
//
// SPUŠTĚNÍ:
//   node providers-check.mjs                # providers.json vedle skriptu
//   node providers-check.mjs cesta.json     # jiný soubor
//   node providers-check.mjs --no-ping      # jen seznam modelů, žádný dotaz
//
// Klíče se berou z prostředí (názvy z keyEnv). V GitHub Actions je dej do
// Secrets; lokálně do prostředí. Hodnoty se nikdy netisknou.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

// První poziční argument = cesta k providers.json; jinak výchozí vedle skriptu.
const argFile = process.argv.slice(2).find((a) => !a.startsWith('--'))
const FILE = resolve(argFile || join(HERE, '..', 'providers.json'))
const NO_PING = process.argv.includes('--no-ping')

if (!existsSync(FILE)) {
  console.error(`Soubor nenalezen: ${FILE}`)
  process.exit(2)
}

let providers
try {
  const raw = JSON.parse(readFileSync(FILE, 'utf8'))
  providers = raw.providers || []
} catch (e) {
  console.error(`providers.json nelze přečíst: ${e.message}`)
  process.exit(2)
}

// GET /models → seznam id modelů (null = endpoint nepodporuje nebo selhal).
async function listModels(baseUrl, key) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) return { error: res.status }
    const data = await res.json()
    const ids = data?.data?.map((m) => m.id) ?? data?.models ?? null
    return { ids }
  } catch (e) {
    return { error: String(e).slice(0, 80) }
  }
}

// Jeden skutečný dotaz: "odpovíš teď?" s minimálním nákladem (max_tokens=1).
async function ping(baseUrl, key, model) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    })
    const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180)
    return { status: res.status, text }
  } catch (e) {
    return { status: 0, text: String(e).slice(0, 120) }
  }
}

// Různí poskytovatelé listují id modelů různě: OpenAI-kompatibilní holé id
// ("codestral-latest"), Google přes "models/" prefix ("models/gemini-3.8-flash").
// Porovnání musí sedět na obojí, jinak hlásí "pryč" model, který tam je.
function hasModel(ids, m) {
  return ids.includes(m) || ids.includes(`models/${m}`)
    || ids.some((id) => id.endsWith(`/${m}`))
}

function classify(status) {
  if (status === 200) return { ok: true, label: 'OK' }
  if (status === 429) return { ok: false, label: '429 kvóta/rate-limit' }
  if (status === 503) return { ok: false, label: '503 nedostupný' }
  if (status === 404) return { ok: false, label: '404 model pryč' }
  if (status === 401) return { ok: false, label: '401 špatný klíč' }
  if (status === 403) return { ok: false, label: '403 zakázáno (tier)' }
  if (status === 400) return { ok: false, label: '400 odmítl' }
  if (status === 0) return { ok: false, label: 'síťová chyba' }
  return { ok: false, label: `HTTP ${status}` }
}

let dead = 0
let skipped = 0
let okProviders = 0

for (const p of providers) {
  const key = process.env[p.keyEnv] || ''
  const scarce = p.skromny ? ' [SKROMNÝ]' : ''

  console.log(`\n== ${p.name}${scarce} (${p.baseUrl}) ==`)

  if (!key) {
    console.log(`   SKIP: chybí klíč ${p.keyEnv}`)
    skipped++
    continue
  }

  // 1) katalog modelů (zdarma) – co zmizelo, je hned vidět
  const catalog = await listModels(p.baseUrl, key)
  const ids = catalog?.ids
  if (ids) {
    for (const m of p.models) {
      if (!hasModel(ids, m)) {
        console.log(`   MODEL PRYČ z katalogu: ${m}`)
        dead++
      }
    }
  } else if (catalog?.error === 401 || catalog?.error === 403) {
    console.log(`   katalog nedostupný: HTTP ${catalog.error} (klíč/tier)`)
  } else {
    console.log('   (katalog modelů neodpověděl – spolehnu se na ping)')
  }

  // 2) skutečný ping prvního modelu (autoritativní signál)
  if (!NO_PING) {
    const m = p.models[0]
    const r = await ping(p.baseUrl, key, m)
    const c = classify(r.status)
    if (c.ok) {
      okProviders++
      console.log(`   PING ${m}: OK`)
    } else {
      dead++
      console.log(`   PING ${m}: ${c.label}${r.text ? ` — ${r.text}` : ''}`)
    }
  }
}

console.log('\n=== Organizace (pořadí zkoušení: štědré → skromné na konci) ===')
// Pořadí v souboru ≠ pořadí zkoušení: skromné (gemini, malý denní limit) jde
// vždy na konec, rotace pořadí štědrých podle run_key je v provider-choice.mjs.
const stedre = providers.filter((p) => !p.skromny)
const skromne = providers.filter((p) => p.skromny)
;[...stedre, ...skromne].forEach((p, i) => {
  const klic = process.env[p.keyEnv] ? '' : '  [bez klíče]'
  console.log(`  ${String(i + 1).padStart(2)}. ${p.skromny ? 'SKROMNÝ' : 'štědrý '}  ${p.name} (${p.models.length} modelů)${klic}`)
})

console.log('\n-----------------------------')
console.log(`shrnutí: ${okProviders} poskytovatelů OK, ${dead} mrtvých signálů, ${skipped} bez klíče`)
if (dead > 0) {
  console.log('→ Vypni/vyměň mrtvé modely v providers.json PŘED dalším během.')
  process.exit(1)
}
process.exit(0)
