import {copyFileSync} from 'node:fs';
for(const file of ['domain.mjs','attendance-store.mjs'])copyFileSync(new URL(`../js/${file}`,import.meta.url),new URL(`../functions/${file}`,import.meta.url));
