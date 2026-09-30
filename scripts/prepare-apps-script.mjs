import {readFile,writeFile,mkdir} from 'node:fs/promises';
const source=await readFile(new URL('../js/domain.mjs',import.meta.url),'utf8');
const names=[...source.matchAll(/export (?:function|const) (\w+)/g)].map(m=>m[1]);
let code=source.replace(/export /g,'');
code=code.replace(/function clock\(now = new Date\(\)\) \{[\s\S]*?\n\}/,`function clock(now = new Date()) {
 return {date:Utilities.formatDate(now,TIME_ZONE,'yyyy-MM-dd'),time:Utilities.formatDate(now,TIME_ZONE,'HH:mm')};
}`);
await mkdir(new URL('../apps-script/',import.meta.url),{recursive:true});
await writeFile(new URL('../apps-script/Domain.gs',import.meta.url),`// Generado desde js/domain.mjs; ejecutar npm run prepare:apps-script.\nvar CPDomain = (function(){\n${code}\nreturn {${names.join(',')}};\n})();\n`);
