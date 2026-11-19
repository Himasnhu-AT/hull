// pnpm tsx examples/ironleaf/tools/build-anims.ts : writes config/anim-set/*.json and config/anim-graph/*.json.
import { writeRaiderGraphs } from './graphs.ts';
writeRaiderGraphs();
console.log('graphs written');
