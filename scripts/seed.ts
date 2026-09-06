// Seed a store with the fixture plays and the library, as demo content.
//
//   bun scripts/seed.ts [--db path]
//
// Idempotent: a fixture whose title already exists as a play by `author` is
// skipped, and the `author` admin user is created only once (secret from
// PUPPET_ADMIN_SECRET when set, so a fixed secret can be scripted). Each
// fixtures/plays/*.json becomes a closed play owned by `author` — except one
// whose `meta.harnessOnly` is true, a renderer diagnostic that is not a play to
// show anyone — embedding
// cast entries given as paths the way test/helpers.ts does; 00-showcase is
// marked featured. If the library has a `heron`, also seeds one open play
// whose cast is an import of `lib.heron`, via applyEdits and the same
// resolver the server would use — this is what exercises the import path
// end to end, not a shortcut around it.

import { readdirSync } from "node:fs";
import path from "node:path";
import { applyAndValidate } from "../src/doc/edit";
import { createImportResolver } from "../src/doc/library";
import { loadLibrary } from "../src/library";
import { PlaySchema, formatIssues, type Play } from "../src/model/types";
import { openStore } from "../src/store/db";

const root = path.resolve(import.meta.dir, "..");
const baseUrl = process.env.PUPPET_BASE_URL ?? `http://localhost:${process.env.PORT ?? 4300}`;
const urlFor = (id: string) => `${baseUrl}/p/${id}`;

const args = process.argv.slice(2);
let dbPath: string | undefined;
for (let i = 0; i < args.length; i++) if (args[i] === "--db") dbPath = args[++i];

const store = openStore(dbPath);

// ---------- admin user ----------

if (!store.getUser("author")) {
  const created = store.createUser({ id: "author", name: "author", role: "admin", secret: process.env.PUPPET_ADMIN_SECRET });
  console.log(`user 'author' created (secret: ${created.secret})`);
} else {
  console.log("user 'author' already exists");
}

// ---------- fixture plays ----------

async function loadFixturePlay(file: string): Promise<Play> {
  const raw = JSON.parse(await Bun.file(path.join(root, file)).text());
  for (const [id, v] of Object.entries(raw.cast ?? {})) {
    if (typeof v === "string") {
      const p = JSON.parse(await Bun.file(path.join(root, "fixtures", v)).text());
      p.id = id;
      raw.cast[id] = p;
    }
  }
  const parsed = PlaySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${formatIssues(parsed.error).join("; ")}`);
  return parsed.data;
}

const existingTitles = new Set(store.listPlays({ creator: "author", limit: 1000 }).map((p) => p.title));

const fixtureFiles = readdirSync(path.join(root, "fixtures/plays"))
  .filter((n) => n.endsWith(".json"))
  .sort()
  .map((n) => `fixtures/plays/${n}`);

for (const file of fixtureFiles) {
  const doc = await loadFixturePlay(file);
  const title = doc.title ?? doc.id;
  if (doc.meta?.harnessOnly === true) {
    console.log(`skip '${title}' (harness only)`); // a diagnostic, not a play to show
    continue;
  }
  if (existingTitles.has(title)) {
    console.log(`skip '${title}' (already seeded)`);
    continue;
  }
  const row = store.createPlay({ creator: "author", mode: "closed", doc });
  existingTitles.add(title);
  if (path.basename(file) === "00-showcase.json") store.setFeatured(row.id, true);
  console.log(`${row.id}  ${title}  ${urlFor(row.id)}`);
}

// ---------- a play seeded via import, to exercise the library path ----------

const library = loadLibrary(path.join(root, "library"));
const heronTitle = "Heron's Cove";

if (!library.puppets.some((p) => p.id === "heron")) {
  console.log("no 'heron' in the library, skipping Heron's Cove");
} else if (existingTitles.has(heronTitle)) {
  console.log(`skip '${heronTitle}' (already seeded)`);
} else {
  const resolver = createImportResolver({
    puppets: library.puppets,
    parts: library.parts,
    play: (playId) => {
      const got = store.getPlay(playId);
      return got ? { doc: got.doc, version: got.version } : null;
    },
  });
  const seed: Play = { id: "", schemaVersion: 1, title: heronTitle, meta: {}, stage: { tempo: 96 }, cast: {}, scenes: [] };
  const row = store.createPlay({ creator: "author", mode: "open", doc: seed });
  const head = store.getPlay(row.id)!;
  const edits = [{ op: "import" as const, src: "lib.heron" }];
  const applied = applyAndValidate(head.doc, edits, { kind: "cast" }, { imports: resolver });
  if (!applied.ok) throw new Error(`seeding '${heronTitle}': ${applied.message}`);
  store.commit({ playId: row.id, doc: applied.doc, edits, touched: applied.touched, author: "author", base: head.version });
  console.log(`${row.id}  ${heronTitle}  ${urlFor(row.id)}`);
}

store.close();
