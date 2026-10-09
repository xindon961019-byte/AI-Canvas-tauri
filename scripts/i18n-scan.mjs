/**
 * 临时扫描工具：统计源码中的中文文案与 i18n 覆盖情况。
 * 用法：node scripts/i18n-scan.mjs [--json] [--dir src]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dirArg = args.find((a) => a.startsWith('--dir='));
const START = join(ROOT, dirArg ? dirArg.slice(6) : 'src');

const CJK = /[一-鿿]/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'locales' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = walk(START);
const wrapped = new Map(); // t('中文') 出现位置
const bare = new Map(); // 未包裹中文

const RE_STRING = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const RE_T_CALL = /\bt\(\s*$/;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  let m;
  RE_STRING.lastIndex = 0;
  while ((m = RE_STRING.exec(src))) {
    const text = m[2];
    if (!CJK.test(text)) continue;
    if (/[{}<>]/.test(text)) continue; // 跳过含占位符/标签片段的复杂串
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    const isWrapped = RE_T_CALL.test(before.trimEnd()) || before.includes('t(');
    const bucket = isWrapped ? wrapped : bare;
    if (!bucket.has(text)) bucket.set(text, new Set());
    bucket.get(text).add(rel);
  }
}

/** 解析词条文件里的 'key': 'value' 对 */
function readDict(dir) {
  const dict = {};
  for (const f of (statSync(dir).isDirectory() ? walk(dir) : [dir])) {
    const src = readFileSync(f, 'utf8');
    const re = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1\s*:\s*(['"])((?:\\.|(?!\3)[^\\\n])*)\3/g;
    let m;
    while ((m = re.exec(src))) dict[m[2]] = m[4];
  }
  return dict;
}

const enUS = readDict(join(ROOT, 'src/i18n/locales/en-US'));
const jaJP = readDict(join(ROOT, 'src/i18n/locales/ja-JP'));
const koKR = readDict(join(ROOT, 'src/i18n/locales/ko-KR'));

const missingEn = [...wrapped.keys()].filter((k) => !(k in enUS));
const missingJa = [...wrapped.keys()].filter((k) => !(k in jaJP));
const missingKo = [...wrapped.keys()].filter((k) => !(k in koKR));

const out = {
  files: files.length,
  wrappedCount: wrapped.size,
  bareCount: bare.size,
  dictSizes: { enUS: Object.keys(enUS).length, jaJP: Object.keys(jaJP).length, koKR: Object.keys(koKR).length },
  missing: { enUS: missingEn.length, jaJP: missingJa.length, koKR: missingKo.length },
  wrapped: [...wrapped].map(([k, v]) => ({ text: k, files: [...v] })),
  bare: [...bare].map(([k, v]) => ({ text: k, files: [...v] })),
};

/** 按域文件列出某语言相对 en-US 缺失的词条，供逐域补齐 */
const todoArg = args.find((a) => a.startsWith('--todo='));
if (todoArg) {
  const lang = todoArg.slice(7);
  const dir = lang === 'ja-JP' ? 'ja-JP' : 'ko-KR';
  const target = readDict(join(ROOT, 'src/i18n/locales', dir));
  const rows = [];
  for (const f of walk(join(ROOT, 'src/i18n/locales/en-US'))) {
    const domain = f.split(/[\\/]/).pop().replace(/\.ts$/, '');
    if (domain === 'index') continue;
    const only = args.find((a) => a.startsWith('--domain='))?.slice(9);
    if (only && domain !== only) continue;
    for (const [k, v] of Object.entries(readDict(f))) {
      if (!(k in target)) rows.push(`${domain}\t${k}\t${v}`);
    }
  }
  const off = Number(args.find((a) => a.startsWith('--offset='))?.slice(9) ?? 0);
  const lim = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? rows.length);
  const { writeFileSync } = await import('node:fs');
  writeFileSync('scripts/.i18n-todo.tsv', rows.slice(off, off + lim).join('\n'), 'utf8');
  console.log(`${lang} 待补: ${rows.length}，本次导出 ${Math.min(lim, rows.length - off)}`);
}

const missingOut = args.find((a) => a.startsWith('--missing-out='));
if (missingOut) {
  const prefixArg = args.find((a) => a.startsWith('--prefix='));
  const offsetArg = args.find((a) => a.startsWith('--offset='));
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const skipped = missingEn.filter((k) => k.includes('\\') || k.includes('\n'));
  if (skipped.length) console.log('跳过（含转义/换行）:', JSON.stringify(skipped));
  let list = missingEn
    .filter((k) => !k.includes('\\') && !k.includes('\n'))
    .map((k) => ({ text: k, files: [...wrapped.get(k)] }));
  if (prefixArg) {
    const p = prefixArg.slice(9);
    list = list.filter((i) => i.files.some((f) => f.includes(p)));
  }
  if (offsetArg) list = list.slice(Number(offsetArg.slice(9)));
  if (limitArg) list = list.slice(0, Number(limitArg.slice(8)));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    missingOut.slice(14),
    list.map((i) => `${i.text}\t${i.files.join(',')}`).join('\n'),
    'utf8',
  );
  const groups = new Map();
  for (const item of list) {
    const g = item.files[0].split('/').slice(0, 3).join('/');
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  console.log('缺失词条分组统计:');
  for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${g}`);
  console.log(`总缺失: ${list.length}`);
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('字典规模:', JSON.stringify(out.dictSizes));
  console.log('t() 已包裹但缺词条:', JSON.stringify(out.missing));
  console.log(`文件数: ${files.length}`);
  console.log(`t() 包裹的中文串(去重): ${wrapped.size}`);
  console.log(`未包裹的中文串(去重): ${bare.size}`);
  console.log('\n--- 未包裹 TOP 50 ---');
  for (const item of out.bare.slice(0, 50)) console.log(`${item.text}   [${item.files.slice(0, 2).join(', ')}]`);
}
