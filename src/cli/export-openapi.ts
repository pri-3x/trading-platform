import { writeFile } from 'node:fs/promises';
import { bootstrap } from '../bootstrap.js';
import { buildApp } from '../http/app.js';

/** Writes the generated OpenAPI document to docs/openapi.json (no database access needed). */
const c = bootstrap();
const app = await buildApp(c);
await app.ready();
await writeFile('docs/openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
await c.database.close();
console.log('wrote docs/openapi.json');
