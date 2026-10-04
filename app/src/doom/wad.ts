// The only game: the original DOOM. Its WAD is the commercial file the owner
// copies into data/doom by hand (Doom1.WAD).
export type DoomGame = "doom1";

export const DOOM_GAMES: readonly DoomGame[] = ["doom1"];

export const DEFAULT_GAME: DoomGame = "doom1";

const WAD_FILES: Record<DoomGame, string> = {
  doom1: "Doom1.WAD",
};

export function wadFileName(game: DoomGame): string {
  return WAD_FILES[game];
}
