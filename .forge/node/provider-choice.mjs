#!/usr/bin/env node
// Čistá logika výběru bezplatného poskytovatele LLM – bez sítě, aby se dala
// testovat (viz provider-choice.test.mjs).
//
// PROČ ROTACE: naměřeno na úloze #40 („level-transition-cleanup") – tři pokusy
// agenta, všechny skončily „nochange" (model navrhl patch, ale neaplikoval ho).
// Příčina není smůla: všechny tři pokusy vybíraly poskytovatele stejně, takže
// běžely se STEJNÝM modelem (codestral-latest) a selhaly stejně. Když se pořadí
// poskytovatelů posune podle `run_key` (každý dispatch má jiný), potkají se
// opakované pokusy téže úlohy s jiným modelem – a to je přesně to, co u
// slabšího modelu rozhoduje.

/** FNV-1a – malý, deterministický hash (jen na rozhození pořadí, ne na bezpečnost). */
export function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Rozdělí poskytovatele na „štědré" a „skromné" (malý denní limit, např. Gemini
 * free ~20 dotazů/den).
 *
 * PROČ: naměřeno v běhu #61 – rotace poslala úlohu #43 na gemini a ten vrátil
 * 429 „exceeded your current quota" uprostřed práce; aider na tom spálil celý
 * pokus a nezměnil ani řádek. Poskytovatel, který odpoví na „ping", ještě
 * nemusí mít kvótu na dvacetitisícový kontext. Skromné poskytovatele proto
 * řadíme na konec: použijí se, jen když ostatní selžou.
 */
export function splitScarce(items, jeSkromny = (p) => Boolean(p.skromny)) {
  return {
    stedre: items.filter((p) => !jeSkromny(p)),
    skromne: items.filter((p) => jeSkromny(p)),
  };
}

/** Posune pořadí poskytovatelů podle seedu (run_key). Bez seedu nic nemění. */
export function rotateOrder(items, seed) {
  if (!seed || items.length < 2) return [...items];
  const offset = fnv1a(String(seed)) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** Pořadí pro zkoušení: rotace mezi štědrými, skromné vždy na konci. */
export function orderProviders(items, seed) {
  const { stedre, skromne } = splitScarce(items);
  return [...rotateOrder(stedre, seed), ...skromne];
}

/**
 * Zúží řetězec na poskytovatele se SILNÝMI modely (granule `model: strong`).
 *
 * PROČ: velká granule (size_lines > 60) smí podle pravidel zpracovat jen
 * dostatečně silný model. Slabé modely ji nedostanou, i kdyby fronta stála –
 * jinak by ji roztrhaly na polovičaté API. Poskytovatelé bez `strongModels`
 * (gemini flash, openrouter :free) ze seznamu vypadnou a z těh, co zbudou,
 * se zkoušejí jen strongModels.
 *
 * @param providers konfigurace z providers.json
 * @returns zúžený seznam [{ ...provider, models: strongModels }]
 */
export function strongProviders(providers) {
  return providers
    .filter((p) => Array.isArray(p.strongModels) && p.strongModels.length > 0)
    .map((p) => ({ ...p, models: p.strongModels }));
}

/**
 * Od kterého poskytovatele začít hledat.
 * `next` = „chci jiného než minule" – použije se při druhém pokusu v témže běhu,
 * kdy už první model kód nezměnil.
 */
export function startIndex(order, lastName, next) {
  if (!next || !lastName) return 0;
  const i = order.findIndex((p) => p.name === lastName);
  return i < 0 ? 0 : (i + 1) % order.length;
}

/** Pořadí, ve kterém se má zkoušet: od `start` dokola přes všechny. */
export function probeOrder(order, start) {
  const n = order.length;
  if (!n) return [];
  return Array.from({ length: n }, (_, step) => order[(start + step) % n]);
}
