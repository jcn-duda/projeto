import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixture = (name: any) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

import nerd from '../nerdfilmes-resolver/server.js';
