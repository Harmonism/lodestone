#!/usr/bin/env node
// export-catalog.js — write the desktop app's model catalog as data.
//
//   node tools/export-catalog.js <out.json>
//
// Called by harmonia-astro/post-build.sh on every full deploy, which publishes
// the result as /lodestone-app/models/catalog.json. The source stays
// src/models.js (the models and the defaults) and src/remote.js (the rented
// models recommended, kept in step with llm-models.php): editing those and
// deploying reaches every installed app on its next "Check" — no new installer.
const fs = require("fs");
const path = require("path");
const models = require("../src/models.js");
const remote = require("../src/remote.js");
const out = process.argv[2];
if (!out) { console.error("usage: export-catalog.js <out.json>"); process.exit(2); }
const data = models.validateCatalog({ schema: 1, ...models.bundledData(remote.BUNDLED_RECOMMENDED) });
const doc = { schema: 1, built_at: new Date().toISOString(), catalog_hash: models.catalogHash(data), ...data };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 1));
console.log(`  Lodestone desktop: model catalog exported (${data.models.length} models, ${data.recommended.length} recommended, hash ${doc.catalog_hash.slice(0, 12)})`);
