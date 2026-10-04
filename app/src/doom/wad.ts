// The games the player can choose. doom1 is the commercial WAD the owner puts
// in data/doom by hand; freedoom1 is the free one fetched by the script.
export type DoomGame = "doom1" | "freedoom1";

export const DOOM_GAMES: readonly DoomGame[] = ["doom1", "freedoom1"];

const WAD_FILES: Record<DoomGame, string> = {
  doom1: "Doom1.WAD",
  freedoom1: "freedoom1.wad",
};

export function wadFileName(game: DoomGame): string {
  return WAD_FILES[game];
}

// doom1 when the owner has it, otherwise the free WAD that the script fetches.
export function pickDefaultGame(exists: (game: DoomGame) => boolean): DoomGame {
  return exists("doom1") ? "doom1" : "freedoom1";
}
