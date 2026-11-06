/**
 * Reads data/speakers-source.html and writes data/speakers.json
 * (array of { Name, Bio, BioParagraphHtml } for Airtable "Speakers" table).
 * Bio = inner HTML of the paragraph; BioParagraphHtml = full <p>...</p> fragment.
 *
 * Run: node scripts/parse-speakers-html.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const htmlPath = path.join(root, 'data', 'speakers-source.html');
const outPath = path.join(root, 'data', 'speakers.json');

const html = fs.readFileSync(htmlPath, 'utf8');

function parseCards(htmlText) {
    const parts = htmlText.split(/<div\s+class="card"[^>]*>/gi).slice(1);
    const records = [];
    for (const part of parts) {
        const h3m = part.match(/<h3>\s*([\s\S]*?)\s*<\/h3>/i);
        if (!h3m) continue;
        const Name = h3m[1].replace(/<[^>]+>/g, '').trim().replace(/\s+/g, ' ');
        const afterH3 = part.slice(part.indexOf(h3m[0]) + h3m[0].length);
        const pOpen = afterH3.search(/<p\b[^>]*>/i);
        if (pOpen === -1) continue;
        const pTag = afterH3.match(/<p\b[^>]*>/i)[0];
        const rest = afterH3.slice(pOpen + pTag.length);
        const lastDiv = rest.lastIndexOf('</div>');
        if (lastDiv < 0) continue;
        let bio = rest.slice(0, lastDiv).trim();
        if (/<\/p>\s*$/i.test(bio)) bio = bio.replace(/<\/p>\s*$/i, '').trim();
        const BioParagraphHtml = `${pTag}${bio}</p>`;
        if (Name && bio) records.push({ Name, Bio: bio, BioParagraphHtml });
    }
    return records;
}

const records = parseCards(html);

if (!records.length) {
    console.error('No cards parsed. Check data/speakers-source.html structure.');
    process.exit(1);
}

fs.writeFileSync(outPath, JSON.stringify(records, null, 2), 'utf8');
console.log(`Wrote ${records.length} speakers to ${path.relative(root, outPath)}`);
