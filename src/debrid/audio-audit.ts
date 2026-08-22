import { dubbedLieVerdict } from '../utils/format.js';
import { DubLieError, VIDEO_EXT, SAMPLE } from './common.js';
import type { DebridFile } from './common.js';

/**
 * O adaptador já recebeu estes arquivos para resolver o play; só então existe
 * prova suficiente para confrontar a promessa `_dubbed` da listagem.
 */
function assertDubbedFiles(files: DebridFile[], promisedDubbed = false) {
  if (!promisedDubbed) return;
  const paths = files
    .map((file) => String(file.path || ''))
    .filter((path) => VIDEO_EXT.test(path) && !SAMPLE.test(path));
  const verdict = dubbedLieVerdict(paths, promisedDubbed);
  if (verdict.lie) {
    throw new DubLieError({
      matchedGroup: verdict.matchedGroup,
      videoCount: verdict.videoCount,
      sample: paths[0],
    });
  }
}

export { assertDubbedFiles };
