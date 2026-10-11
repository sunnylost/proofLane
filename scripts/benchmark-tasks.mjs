import assert from 'node:assert/strict';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const engine = 'packages/engine/src/';
const locations = engine + 'locations.ts';
const positive = {
  name: 'positive-location-size', category: 'test-failure', expected: 'defect', files: [locations],
  requirement: 'Location size must be a positive integer, with default 1024 and non-finite fallback 1.',
  edits: [[locations, 'return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;', 'return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 1;']],
  visible: `import {normalizeLocationGenerationOptions as normalize} from './${locations}'; test('contract',()=>expect(normalize({charsPerLocation:0}).charsPerLocation).toBe(1));`,
  hidden: `import {normalizeLocationGenerationOptions as normalize} from './${locations}'; test('contract',()=>{ for(const value of [-10,-0,NaN,Infinity,-Infinity]) expect(normalize({charsPerLocation:value}).charsPerLocation).toBe(1); expect(normalize({charsPerLocation:2.9}).charsPerLocation).toBe(2); expect(normalize().charsPerLocation).toBe(1024); });`,
};
const profileTest = (path) => `import {readSessionInspection} from './${engine}${path}'; test('contract',()=>{const result=readSessionInspection({inspectionJson:()=>'{"title":"book"}',bookProfileJson:()=>'{"manifest":[],"spine":[]}',chapterJson:()=>'{"href":"chapter.xhtml"}'}); expect(result.chapter_ir.href).toBe('chapter.xhtml'); expect(result.manifest).toEqual([]);});`;
const chapter = `const chapter={document_id:0,root:0,href:'chapter.xhtml',nodes:[{id:0,text:'one beta two',children:[]}]};`;
export const tasks = [
  { ...positive, name: 'healthy-location-size', category: 'healthy', expected: 'pass', edits: [[locations, 'const LOCATION_CACHE_SCHEMA', '\nconst LOCATION_CACHE_SCHEMA']] },
  positive,
  { name: 'cache-scope-escaping', category: 'test-failure', expected: 'defect', files: [locations], requirement: 'Book location cache key must encode every component, preserve v2 schema, non-negative chapter count and normalized location size.', edits: [[locations, '.map(escapeCacheKeyPart)\n    .join(":")', '.join(":")']],
    visible: `import {bookLocationCacheKey as key} from './${locations}'; test('contract',()=>expect(key('a:b',2)).toBe('foliosmith%3Alocations:v2:a%3Ab:2:1024'));`,
    hidden: `import {bookLocationCacheKey as key} from './${locations}'; test('contract',()=>{expect(key('a/b#中',3,{charsPerLocation:2})).toBe('foliosmith%3Alocations:v2:a%2Fb%23%E4%B8%AD:3:2'); expect(key('',-1)).toBe('foliosmith%3Alocations:v2::0:1024');});` },
  { name: 'search-cfi-cross-file', category: 'cross-file', expected: 'defect', files: [engine + 'cfi.ts', engine + 'search.ts'], requirement: 'Search results must identify the exact matched text in the excerpt, and their CFI must round-trip to the same node and offset.', edits: [[engine + 'cfi.ts', 'const safeOffset = normalizeNonNegativeInteger(offset);', 'const safeOffset = normalizeNonNegativeInteger(offset) + 1;'], [engine + 'search.ts', 'matchEnd: matchStart + matchLength,', 'matchEnd: matchStart + matchLength + 1,']],
    visible: `import {createCfiApi} from './${engine}cfi.ts'; import {searchChapters} from './${engine}search.ts'; ${chapter} test('contract',()=>{const hit=searchChapters([{chapter,spineIndex:0}],'beta')[0]; expect(createCfiApi(chapter).parse(hit.cfi).offset).toBe(4); expect(hit.excerpt.slice(hit.excerptMatchStart,hit.excerptMatchEnd)).toBe('beta');});`,
    hidden: `import {createCfiApi} from './${engine}cfi.ts'; import {searchChapters} from './${engine}search.ts'; ${chapter} test('contract',()=>{for(const query of ['one','two']){const hit=searchChapters([{chapter,spineIndex:0}],query)[0]; expect(createCfiApi(chapter).parse(hit.cfi).offset).toBe(chapter.nodes[0].text.indexOf(query)); expect(hit.excerpt.slice(hit.excerptMatchStart,hit.excerptMatchEnd)).toBe(query);}});` },
  { name: 'healthy-profile-rename', category: 'rename', expected: 'pass', files: [engine + 'profile.ts', engine + 'publication-profile.ts', engine + 'index.ts'], requirement: 'Renaming the profile module must preserve readSessionInspection and update its engine entry-point import.', rename: [engine + 'profile.ts', engine + 'publication-profile.ts'], edits: [[engine + 'index.ts', 'from "./profile"', 'from "./publication-profile"']], visible: profileTest('profile.ts'), afterVisible: profileTest('publication-profile.ts'), hidden: profileTest('profile.ts'), afterHidden: profileTest('publication-profile.ts') },
  { name: 'deleted-profile-module', category: 'deletion', expected: 'defect', files: [engine + 'profile.ts'], requirement: 'The engine entry-point must retain its importable profile module and readSessionInspection API.', remove: engine + 'profile.ts', visible: profileTest('profile.ts'),
    hidden: `import {existsSync} from 'node:fs'; test('contract',async()=>{expect(existsSync('${engine}profile.ts')).toBe(true); const {readSessionInspection}=await import('./${engine}profile.ts'); expect(readSessionInspection({inspectionJson:()=> '{}',bookProfileJson:()=>'{"spine":[],"manifest":[]}',chapterJson:()=>'{"href":"c.xhtml"}'}).chapter_ir.href).toBe('c.xhtml');});` },
  { name: 'wasm-dependency-declaration', category: 'dependency', expected: 'defect', files: ['packages/engine/package.json'], requirement: 'The engine package must declare its runtime @foliosmith/epub-wasm dependency so consumers can resolve the WASM package.', dependency: true,
    visible: "import {readFileSync} from 'node:fs'; test('contract',()=>{const pkg=JSON.parse(readFileSync('packages/engine/package.json','utf8')); expect(typeof pkg.dependencies?.['@foliosmith/epub-wasm']).toBe('string');});",
    hidden: "import {readFileSync} from 'node:fs'; test('contract',()=>{const pkg=JSON.parse(readFileSync('packages/engine/package.json','utf8')); expect(Object.keys(pkg.dependencies??{})).toContain('@foliosmith/epub-wasm'); expect(pkg.dependencies['@foliosmith/epub-wasm']).toBe('workspace:1.0.0');});" },
  { ...positive, name: 'baseline-reintroduced-defect', category: 'baseline-regression', baseline: true },
];

export function testSource(task, hidden = false, seeded = false) {
  const body = hidden ? (seeded ? task.afterHidden ?? task.hidden : task.hidden) : (seeded ? task.afterVisible ?? task.visible : task.visible);
  return `import {test,expect} from 'vitest';\n${body}\n`;
}

export async function seedTask(root, task) {
  for (const [file, from, to] of task.edits ?? []) {
    const original = await readFile(join(root, file), 'utf8');
    assert.ok(original.includes(from), `Mutation no longer matches ${task.name}: ${file}`);
    await writeFile(join(root, file), original.replace(from, to));
  }
  if (task.rename) await rename(join(root, task.rename[0]), join(root, task.rename[1]));
  if (task.remove) await rm(join(root, task.remove));
  if (task.dependency) {
    const file = join(root, 'packages/engine/package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(pkg.dependencies['@foliosmith/epub-wasm'], 'workspace:1.0.0');
    delete pkg.dependencies['@foliosmith/epub-wasm'];
    await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
  }
  await writeFile(join(root, 'prooflane-benchmark.test.ts'), testSource(task, false, true));
}
