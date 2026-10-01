import { join } from 'node:path';
import { ROOT, storySeasonDirName, storyEpisodeFileName } from '../lib/paths.js';

/**
 * Story のファイル配置を、根を差し替えられる形で持つ。
 * 本番は ROOT（src/lib/paths.ts の storyDir 等と同じ場所）、テストは一時ディレクトリ。
 */
export function storyPaths(characterId: string, season: number, root: string = ROOT) {
  const dir = join(root, 'characters', characterId, 'stories', storySeasonDirName(season));
  return {
    dir,
    manifest: join(dir, 'manifest.yaml'),
    plan: join(dir, 'plan.yaml'),
    episode: (order: number, lang: 'ja' | 'en') => join(dir, storyEpisodeFileName(order, lang)),
    config: join(root, 'world', 'stories.yaml'),
  };
}
