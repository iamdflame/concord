#!/usr/bin/env node
// Does the demo fit in three minutes?
//
// The one rule that disqualifies you is a length limit, and both halves of the
// video -- the pictures and the words -- are written down in RECORDING.md. So
// both are counted here rather than estimated, and the estimate in the guide
// is the output of this rather than a guess somebody typed.

import { readFileSync, existsSync } from 'node:fs';

const md = readFileSync(new URL('./RECORDING.md', import.meta.url), 'utf8');
const LIMIT = 180;
let bad = 0;
const say = (ok, line) => { console.log(`  ${ok ? '✓' : '✗'} ${line}`); if (!ok) bad++; };

// The picture, from the edit table.
const shots = [...md.matchAll(/\| `([^`]+)` \| \d:\d\d \| (\d+)s \|/g)]
  .map(([, name, secs]) => ({ name, secs: Number(secs) }));
const picture = shots.reduce((t, s) => t + s.secs, 0);
say(shots.length >= 6, `${shots.length} shots in the edit`);
say(picture < LIMIT, `picture runs ${Math.floor(picture / 60)}:${String(picture % 60).padStart(2, '0')} `
  + `(limit 3:00, ${LIMIT - picture}s spare)`);

// The words, from the narration block.
const part3 = md.slice(md.indexOf('## Part 3'), md.indexOf('## Part 4'));
const words = part3.split('\n')
  .filter((l) => l.startsWith('> ') && !l.startsWith('> **['))
  .join(' ').split(/\s+/).filter(Boolean).length;
const slow = Math.round((words / 130) * 60);
say(words > 200, `${words} words of narration`);
say(slow <= picture, `at a slow 130 wpm that is ${Math.floor(slow / 60)}:`
  + `${String(slow % 60).padStart(2, '0')} of speech, inside the ${picture}s cut`);

// The video must say how WebMCP was used. These are the words that do that.
for (const term of ['registerTool', 'AbortController', 'getTools']) {
  say(part3.includes(term), `the narration names ${term}`);
}

// Every card the edit names has to exist. Renaming the card set is exactly the
// kind of change that leaves a guide pointing at files nobody has, and it is
// discovered at midnight in a video editor rather than here.
const cards = shots.map((s) => s.name).filter((n) => n.endsWith('.png'));
const missing = cards.filter((n) => !existsSync(new URL(`./cards/${n}`, import.meta.url)));
say(missing.length === 0, `every card in the edit exists${missing.length ? `: missing ${missing}` : ''}`);

// And the lower thirds, from their own table.
const lowers = [...md.matchAll(/\| `(lt-[^`]+\.png)` \|/g)].map(([, n]) => n);
const lostLowers = lowers.filter((n) => !existsSync(new URL(`./cards/${n}`, import.meta.url)));
say(lowers.length >= 5 && lostLowers.length === 0,
  `${lowers.length} lower thirds, all present${lostLowers.length ? `: missing ${lostLowers}` : ''}`);

// The narration cues and the edit table must describe the same film. A cue
// with no shot, or a shot no cue introduces, is a cut nobody has planned.
const cues = [...part3.matchAll(/\*\*\[(Card: [^\]]+|Clip \d+)[^\]]*\]\*\*/g)].length;
say(cues === shots.length,
  `${cues} narration cues for ${shots.length} shots`);

console.log(bad ? `\nDEMO FAILED — ${bad}` : '\nDEMO FITS');
process.exit(bad ? 1 : 0);
