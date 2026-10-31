// MCP tool surface: collection tools were removed with My Collection.
import { readFileSync } from 'node:fs';
const src = readFileSync('worker-paste-this.js', 'utf8');
const toolsBlock = src.slice(src.indexOf('const MCP_TOOLS = ['), src.indexOf('\n];', src.indexOf('const MCP_TOOLS = [')));
const tools = [...toolsBlock.matchAll(/^    name: '([a-z_]+)'/gm)].map(m => m[1]);
const cases = [...src.matchAll(/^    case '([a-z_]+)': \{/gm)].map(m => m[1]);
let pass = 0, fail = 0;
const t = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };
t('get_collection is gone', !tools.includes('get_collection') && !cases.includes('get_collection'));
t('get_collection_stats is gone', !tools.includes('get_collection_stats') && !cases.includes('get_collection_stats'));
for (const n of tools) t(`tool ${n} has a dispatch case`, cases.includes(n));
t('find_card_in_collection no longer searches a portfolio', !/portfolio: snapKey\(snap, 'pkm-portfolio'/.test(src));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
