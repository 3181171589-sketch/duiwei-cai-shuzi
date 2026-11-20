const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
if (scripts.length !== 1) throw new Error(`Expected exactly one inline application script; found ${scripts.length}`);
new vm.Script(scripts[0][1], { filename: 'public/index.html:inline-script' });
console.log('Inline browser script syntax OK');
