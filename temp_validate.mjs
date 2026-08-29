// Temp validation: replicate browse.js parse/filter against the real cache
import fs from 'fs';
const cache = JSON.parse(fs.readFileSync('minhajipy/catalog_cache.json', 'utf8'));

function normStream(s) {
  const t = String(s).toUpperCase();
  if (t.includes('ADV')) return 'ADV';
  if (t.includes('ASP')) return 'ASP';
  if (t.includes('APPLIED')) return 'ASP';
  if (t.includes('GEN')) return 'GEN';
  return t;
}

function fileTargets(fn) {
  const tokens = [];
  const add = (num, stream) => {
    const n = parseInt(num, 10);
    if (!(n >= 1 && n <= 12)) return;
    const s = stream ? normStream(stream) : null;
    if (!tokens.some(t => t.num === n && t.s === s)) tokens.push({ num: n, s });
  };
  let m;
  const streamRes = [
    /G(\d{1,2})-(\d{1,2})[-_ ]?(ADV|GEN|ASP|ADVANCED|GENERAL|APPLIED)\b/gi,
    /G(\d{1,2})[-_ ]?(ADV|GEN|ASP|ADVANCED|GENERAL|APPLIED)\b/gi,
    /Integrated[_ ]?([123])(?![0-9])/gi
  ];
  for (let i = 0; i < streamRes.length; i++) {
    while ((m = streamRes[i].exec(fn))) {
      if (i === 0) { add(m[1], m[3]); add(m[2], m[3]); }
      else if (i === 1) add(m[1], m[2]);
      else add(8 + parseInt(m[1], 10), 'ADV');
    }
  }
  const covered = new Set(tokens.filter(t => t.s).map(t => t.num));
  const plainRe = /(?<![A-Za-z0-9])G(\d{1,2})(?!\d)/gi;
  while ((m = plainRe.exec(fn))) {
    const n = parseInt(m[1], 10);
    if (!covered.has(n)) add(n, null);
  }
  const rangeRe = /[_ ](\d{1,2})-(\d{1,2})(?!\d)/g;
  while ((m = rangeRe.exec(fn))) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a <= b && b - a < 12) for (let n = a; n <= b; n++) add(n, null);
  }
  return tokens;
}

function parseBook(raw) {
  const meta = Array.isArray(raw.metadatas) ? raw.metadatas : [];
  const grades = [], baseGrades = [], subjects = [], streams = [], personas = [];
  const gradeStreamMap = {};
  const STREAM_TAIL = /\s*\b(ADVANCED|GENERAL|APPLIED|ADV|GEN|ASP)\b\s*$/i;
  for (const m of meta) {
    const grp = String(m.metadataGroupTitleEn || '').trim();
    const lbl = String(m.titleEn || m.titleAr || m.id || '').trim();
    if (!lbl) continue;
    const g = grp.toLowerCase();
    if (g === 'grades') {
      grades.push(lbl);
      const tail = lbl.match(STREAM_TAIL);
      const base = tail ? lbl.replace(STREAM_TAIL, '').trim() : lbl;
      if (base && !baseGrades.includes(base)) baseGrades.push(base);
      if (tail) {
        const s = normStream(tail[1]);
        if (!streams.includes(s)) streams.push(s);
        (gradeStreamMap[base] ||= new Set()).add(s);
      }
    }
    else if (g === 'subjects') subjects.push(lbl);
    if (/personas?/.test(g)) personas.push(lbl);
  }
  const isStudent = personas.some(p => /student/i.test(p));
  const isTeacherGuide = personas.some(p => /teacher/i.test(p)) && !isStudent;
  const fn = String(raw.fileName || '');
  let fBase = baseGrades.slice(), fStreams = streams.slice();
  const tokens = fileTargets(fn);
  if (tokens.length) {
    fBase = [...new Set(tokens.map(t => 'Grade ' + t.num))];
    const sts = [];
    for (const t of tokens) {
      if (t.s) sts.push(t.s);
      else {
        const ms = gradeStreamMap['Grade ' + t.num];
        if (ms && ms.size) sts.push(...ms);
      }
    }
    fStreams = [...new Set(sts)];
    if (!fStreams.length) fStreams = streams.slice();
  }
  return {
    title: raw.titleEn || fn, fileName: fn,
    baseGrades: fBase, streams: fStreams, isStudent, isTeacherGuide
  };
}

const books = cache.books.map(b => parseBook(b.raw));
console.log('parsed:', books.length);

function query(grade, stream, teacher) {
  return books.filter(b =>
    (!grade || b.baseGrades.some(x => x.toLowerCase() === grade.toLowerCase())) &&
    (!stream || b.streams.some(x => x.toUpperCase() === stream.toUpperCase())) &&
    (teacher ? b.isTeacherGuide : b.isStudent));
}

const show = (label, list) => {
  console.log(`\n=== ${label}: ${list.length} ===`);
  list.slice(0, 12).forEach(b =>
    console.log(`  ${b.title} | ${b.fileName} | ${b.baseGrades.join('/')} · ${b.streams.join('/')}`));
};

show('Grade 10 + ADV + Teacher', query('Grade 10', 'ADV', true));
show('Grade 9 + ADV + Teacher', query('Grade 9', 'ADV', true));
show('Grade 12 + ADV + Teacher', query('Grade 12', 'ADV', true));
show('Grade 12 + General + Student', query('Grade 12', 'GEN', false));
show('Grade 9 + General + Student', query('Grade 9', 'GEN', false));
show('KG1 + Teacher', query('KG1', null, true));
show('Grade 3 + Student (no stream)', query('Grade 3', null, false));
