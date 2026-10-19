const fs = require('fs');
const [file, id, last] = process.argv.slice(2);
const txt = fs.readFileSync(file, 'utf8');
const body = txt.split(`===BEGIN ${id}===`)[1].split(`===END ${id}===`)[0];
const run = JSON.parse(body.slice(body.indexOf('{')));
const rd = run.data.resultData;
console.log(`[${id}] estado: ${run.status} | error: ${rd.error?.message ?? 'ninguno'}`);
for (const [name, runs] of Object.entries(rd.runData)) {
  const r = runs[0];
  const outs = (r.data?.main ?? []).map((o) => (o ? o.length : 0)).join('/');
  console.log(`  - ${name}: ${r.executionStatus} (items: ${outs})${r.error ? ' ERROR ' + r.error.message : ''}`);
}
const out = rd.runData[last][0].data.main[0][0].json;
fs.writeFileSync(file.replace(/\.log$/, `-${id}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2).slice(0, Number(process.argv[5] ?? 4000)));
