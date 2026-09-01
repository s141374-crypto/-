import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { unzipSync } from "fflate";

const OFFICIAL_SOURCES = [
  { key: "law", label: "中央法律", url: "https://law.moj.gov.tw/api/ch/law/json", file: "ChLaw.json" },
  { key: "order", label: "中央命令", url: "https://law.moj.gov.tw/api/ch/order/json", file: "ChOrder.json" }
];
const targetBytes = 2_500_000;
const args = new Map(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value, all[index + 1]] : ["", ""]));
const outputDir = resolve("law-data");

function normalize(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

async function loadArchive(source) {
  const argName = source.key === "law" ? "--law-zip" : "--order-zip";
  const localPath = args.get(argName);
  const archive = localPath
    ? await readFile(resolve(localPath))
    : Buffer.from(await (await fetch(source.url)).arrayBuffer());
  const entries = unzipSync(new Uint8Array(archive));
  const jsonBytes = entries[source.file];
  if (!jsonBytes) throw new Error(`${source.file} not found in official archive`);
  return JSON.parse(new TextDecoder().decode(jsonBytes));
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provider: "法務部全國法規資料庫 Open API",
  providerUrl: "https://law.moj.gov.tw/api/swagger/index.html",
  sources: [],
  shards: [],
  totals: { laws: 0, articles: 0, currentLaws: 0, currentArticles: 0 }
};

let shardNumber = 0;
for (const source of OFFICIAL_SOURCES) {
  const payload = await loadArchive(source);
  const laws = Array.isArray(payload.Laws) ? payload.Laws : [];
  const sourceStats = { key: source.key, label: source.label, url: source.url, updateDate: payload.UpdateDate, laws: 0, articles: 0, currentLaws: 0, currentArticles: 0 };
  let shard = [];
  let shardSize = 2;

  async function flushShard() {
    if (!shard.length) return;
    shardNumber += 1;
    const file = `shard-${String(shardNumber).padStart(3, "0")}.json`;
    const json = JSON.stringify(shard);
    const currentArticles = shard.reduce((sum, law) => sum + (law.d ? 0 : law.a.length), 0);
    const totalArticles = shard.reduce((sum, law) => sum + law.a.length, 0);
    await writeFile(resolve(outputDir, file), json);
    manifest.shards.push({ file, source: source.key, laws: shard.length, articles: totalArticles, currentArticles, bytes: Buffer.byteLength(json) });
    shard = [];
    shardSize = 2;
  }

  for (const law of laws) {
    const articles = (Array.isArray(law.LawArticles) ? law.LawArticles : [])
      .filter((article) => article.ArticleType === "A")
      .map((article) => [normalize(article.ArticleNo), normalize(article.ArticleContent)])
      .filter((article) => article[1]);
    const compact = {
      n: normalize(law.LawName),
      u: normalize(law.LawURL),
      l: normalize(law.LawLevel),
      c: normalize(law.LawCategory),
      m: normalize(law.LawModifiedDate),
      d: Boolean(normalize(law.LawAbandonNote)),
      a: articles
    };
    const encoded = JSON.stringify(compact);
    if (shard.length && shardSize + Buffer.byteLength(encoded) > targetBytes) await flushShard();
    shard.push(compact);
    shardSize += Buffer.byteLength(encoded) + 1;

    sourceStats.laws += 1;
    sourceStats.articles += articles.length;
    if (!compact.d) {
      sourceStats.currentLaws += 1;
      sourceStats.currentArticles += articles.length;
    }
  }
  await flushShard();
  manifest.sources.push(sourceStats);
  manifest.totals.laws += sourceStats.laws;
  manifest.totals.articles += sourceStats.articles;
  manifest.totals.currentLaws += sourceStats.currentLaws;
  manifest.totals.currentArticles += sourceStats.currentArticles;
}

await writeFile(resolve(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.totals));
console.log(`Generated ${manifest.shards.length} shards in ${outputDir}`);
