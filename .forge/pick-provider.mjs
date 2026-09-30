#!/usr/bin/env node
// Vybere prvního bezplatného poskytovatele LLM, který opravdu odpovídá, a předá
// jeho nastavení dalším krokům workflow (přes GITHUB_ENV) i nástroji aider.
//
// Proč: free tiery padají na 429 a jednotlivé služby mají výpadky. Místo aby
// agent spadl, zkusí se řetězec providerů popořadě a použije se první funkční.
//
// ROTACE (od 25. 9. 2026): pořadí se posouvá podle `run_key`, takže opakované
// pokusy téže úlohy neběží pořád se stejným modelem. Naměřeno: tři pokusy
// o úlohu #40 selhaly stejně („nochange"), protože všechny tři vybraly
// codestral-latest. Když model na úloze selže, další pokus se stejným modelem
// selže skoro jistě – rotace tu korelaci rozbije.
//
// Použití v Actions:
//   node .forge/pick-provider.mjs                 # první pokus (rotace z run_key)
//   node .forge/pick-provider.mjs --next          # další pokus v témže běhu
//   node .forge/pick-provider.mjs --seed abc      # ruční seed (testování)
// a dál už stačí jen $OPENAI_API_BASE, $OPENAI_API_KEY, $FORGE_MODEL.

import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { orderProviders, startIndex, probeOrder, strongProviders } from './node/provider-choice.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// providers.json je jediný zdroj pravdy v repu orchestra. Tady se stáhne čerstvá
// verze (raw.githubusercontent) a lokální kopie v repu hry je jen ZÁLOHA pro
// případ, že by raw nebyl dostupný. Díky tomu se mrtvý model opraví jednou
// (v orchestra) a všechny hry ho uvidí při dalším běhu – žádné kopie v repoch her.
const ORCHESTRA_RAW = "https://raw.githubusercontent.com/ssevcikm-spec/forge-orchestra/main/repo/.forge/providers.json";
let config;
try {
  const r = await fetch(ORCHESTRA_RAW);
  if (r.ok) {
    config = await r.json();
    console.log("providers.json: čerstvá verze z orchestra");
  }
} catch { /* offline – spadni na lokální kopii */ }
if (!config) {
  config = JSON.parse(readFileSync(join(HERE, 'providers.json'), 'utf8'));
  console.log("providers.json: lokální kopie (orchestra nedostupná)");
}

const arg = (jmeno) => {
  const i = process.argv.indexOf(jmeno);
  return i >= 0 ? process.argv[i + 1] : '';
};
const chciDalsiho = process.argv.includes('--next');
const seed = arg('--seed') || process.env.FORGE_RUN_KEY || '';

// GRANULE model: strong – workflow nastaví FORGE_MIN_STRONG=strong a řetězec se
// zúží jen na silné modely (strongModels v providers.json). Slabý model velkou
// granuli nikdy nedostane: když žádný silný model neodpoví, běh skončí chybou
// a conductor granuli vrátí do fronty na další pokus (s cooldownem).
const minStrong = process.env.FORGE_MIN_STRONG === 'strong';
let providers = config.providers || [];
if (minStrong) {
  providers = strongProviders(providers);
  console.log(`granule vyžaduje silný model – zužuji na: ${
    providers.map((p) => p.name).join(', ') || 'žádný (chybí strongModels)'}`);
  if (!providers.length) {
    console.error('CHYBA: granule má model=strong, ale v providers.json není žádný strongModels.');
    process.exit(1);
  }
}

async function probe(baseUrl, apiKey, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        // OpenRouter si potrpí na identifikaci aplikace
        'HTTP-Referer': 'https://github.com/',
        'X-Title': 'forge-agent',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    return { ok: true, answer: text.slice(0, 80) };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

// Poslední použitý poskytovatel se čte z provider.json – díky tomu umí `--next`
// přeskočit na dalšího i v rámci jednoho běhu (GITHUB_ENV platí až pro další krok).
// POZOR na BOM: PowerShell (a potažmo ruční zápis v Windows) umí přidat značku
// na začátek souboru a JSON.parse by na ní spadl – přesně to zlobilo u .env.
let posledni = '';
try {
  const raw = readFileSync(join(HERE, 'provider.json'), 'utf8').replace(/^\uFEFF/, '');
  posledni = JSON.parse(raw).provider || '';
} catch { /* první běh – žádný záznam není */ }

const order = orderProviders(providers, seed);
const start = startIndex(order, posledni, chciDalsiho);
const poradi = probeOrder(order, start);
if (seed) {
  console.log(`pořadí posunuto podle run_key (${String(seed).slice(0, 8)}…): ` +
    `${order.map((p) => p.name).join(' → ')}`);
}
if (chciDalsiho && posledni) {
  console.log(`předchozí pokus: ${posledni} – hledám jiného poskytovatele`);
}
console.log(`zkouším v pořadí: ${poradi.map((p) => p.name).join(' → ')}`);

let chosen = null;
for (const p of poradi) {
  const apiKey = process.env[p.keyEnv];
  if (!apiKey) {
    console.log(`- ${p.name}: přeskočeno (chybí ${p.keyEnv})`);
    continue;
  }
  for (const model of p.models) {
    const r = await probe(p.baseUrl, apiKey, model);
    if (r.ok) {
      console.log(`✓ ${p.name} / ${model} odpovídá – použiji tento model`);
      chosen = { provider: p.name, baseUrl: p.baseUrl, model, keyEnv: p.keyEnv, apiKey };
      break;
    }
    console.log(`✗ ${p.name} / ${model}: ${r.reason}`);
  }
  if (chosen) break;
}

if (!chosen) {
  console.error('CHYBA: žádný z bezplatných poskytovatelů neodpověděl.');
  console.error('Zkontroluj, že jsou v GitHub Secrets GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY.');
  process.exit(1);
}

const envFile = process.env.GITHUB_ENV;
const lines = [
  `OPENAI_API_BASE=${chosen.baseUrl}`,
  `OPENAI_API_KEY=${chosen.apiKey}`,
  `FORGE_MODEL=${chosen.model}`,
  `FORGE_PROVIDER=${chosen.provider}`,
];
if (envFile) appendFileSync(envFile, lines.join('\n') + '\n');

// Druhá kopie pro SHELL v témže kroku: GITHUB_ENV se projeví až v dalším kroku,
// ale „druhý pokus s jiným modelem" chceme hned, ne za 15 minut.
const shellFile = join(HERE, 'provider.env');
writeFileSync(shellFile, lines.map((l) => `export ${l.split('=')[0]}='${l.slice(l.indexOf('=') + 1)}'`).join('\n') + '\n');

writeFileSync(join(HERE, 'provider.json'), JSON.stringify({
  provider: chosen.provider, base_url: chosen.baseUrl, model: chosen.model,
  run_key: String(seed), start, picked_at: new Date().toISOString(),
}, null, 2));

console.log(`\nVybráno: ${chosen.provider} → ${chosen.model}`);
if (!envFile) console.log('(GITHUB_ENV není nastaven – běžím mimo CI, hodnoty výše se nikam nezapsaly)');
