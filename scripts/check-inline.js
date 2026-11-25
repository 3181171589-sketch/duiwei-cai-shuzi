const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
if (!html.includes('<script src="/app.js"></script>')) throw new Error('Expected the browser app bundle to be loaded');
if (/<script>/.test(html)) throw new Error('Inline application scripts are no longer expected');
new vm.Script(app, { filename: 'public/app.js' });
console.log('Browser application script syntax OK');
