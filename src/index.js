import { run } from './main.js';
import { escapeData } from './report.js';

run().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.log(`::error::${escapeData(`fork-keeper crashed: ${err?.stack ?? err}`)}`);
    process.exitCode = 1;
  },
);
