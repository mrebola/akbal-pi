/* app/doom/engine/i_akbal_music.c
 * Music for Akbal Pi. DoomGeneric passes each MUS lump to I_RegisterSong;
 * mus2mid (upstream) turns it into a MIDI file under data/doom/music/, and
 * the engine tells Node what to play over fd 4 (AKBAL_MUSIC_CTL_FD):
 *   song <abs-path> <0|1>   stop   pause   resume
 * Node does the synthesis and the music volume (fluidsynth). Replaces the
 * no-op music stubs that lived in i_akbal_sound.c.
 *
 * Node does not create data/doom/music/: this file does, before writing. */
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "doomtype.h"
#include "i_sound.h"
#include "memio.h"
#include "mus2mid.h"

#define AKBAL_MUSIC_CTL_FD 4
#define MUSIC_SUBDIR "data/doom/music"

static char music_dir[PATH_MAX];   /* absolute; empty if getcwd failed */
static int next_song_id = 0;
static int music_playing = 0;      /* last state written: song=1, stop=0 */

/* Writes one control line to fd 4. Failures are ignored: music is optional
 * and the game must keep running if Node closed its end. */
static void ctl_send(const char *line) {
  size_t len = strlen(line), off = 0;
  while (off < len) {
    ssize_t w = write(AKBAL_MUSIC_CTL_FD, line + off, len - off);
    if (w < 0) {
      if (errno == EINTR) continue;
      return;
    }
    off += (size_t)w;
  }
}

/* mkdir that treats "already exists" as success. */
static int mkdir_ok(const char *path) {
  if (mkdir(path, 0755) == 0 || errno == EEXIST) return 0;
  return -1;
}

static int ensure_music_dir(void) {
  char p[PATH_MAX];
  char cwd[PATH_MAX];
  if (!getcwd(cwd, sizeof cwd)) return -1;
  snprintf(p, sizeof p, "%s/data", cwd);
  if (mkdir_ok(p) != 0) return -1;
  snprintf(p, sizeof p, "%s/data/doom", cwd);
  if (mkdir_ok(p) != 0) return -1;
  snprintf(p, sizeof p, "%s/%s", cwd, MUSIC_SUBDIR);
  if (mkdir_ok(p) != 0) return -1;
  return 0;
}

void I_InitMusic(void) {
  /* A write to a closed fd 4 must fail with EPIPE, not kill the engine. */
  signal(SIGPIPE, SIG_IGN);
  music_dir[0] = '\0';
  char cwd[PATH_MAX];
  if (!getcwd(cwd, sizeof cwd)) return;
  snprintf(music_dir, sizeof music_dir, "%s/%s", cwd, MUSIC_SUBDIR);
  music_playing = 0;
  next_song_id = 0;
}

void I_ShutdownMusic(void) { music_playing = 0; }

void I_SetMusicVolume(int volume) { (void)volume; }

void I_PauseSong(void) { ctl_send("pause\n"); }

void I_ResumeSong(void) { ctl_send("resume\n"); }

/* Converts the MUS lump to MIDI and returns the path (malloc'd) as the
 * handle, or NULL if the conversion or the write failed. */
void *I_RegisterSong(void *data, int len) {
  if (!music_dir[0] || !data || len <= 0) return NULL;
  if (ensure_music_dir() != 0) return NULL;

  MEMFILE *in = mem_fopen_read(data, (size_t)len);
  MEMFILE *out = mem_fopen_write();
  char *handle = NULL;

  if (!mus2mid(in, out)) {
    void *buf = NULL;
    size_t buflen = 0;
    char name[PATH_MAX];
    mem_get_buf(out, &buf, &buflen);
    snprintf(name, sizeof name, "%s/%d.mid", music_dir, next_song_id++);
    FILE *f = fopen(name, "wb");
    if (f) {
      if (fwrite(buf, 1, buflen, f) == buflen) handle = strdup(name);
      fclose(f);
    }
  }

  mem_fclose(in);
  mem_fclose(out);
  return handle;
}

/* The file stays on disk: Node removes the directory contents at startup. */
void I_UnRegisterSong(void *handle) { free(handle); }

void I_PlaySong(void *handle, boolean looping) {
  if (!handle) return;
  char line[PATH_MAX + 64];
  snprintf(line, sizeof line, "song %s %d\n", (const char *)handle, looping ? 1 : 0);
  ctl_send(line);
  music_playing = 1;
}

void I_StopSong(void) {
  ctl_send("stop\n");
  music_playing = 0;
}

boolean I_MusicIsPlaying(void) { return music_playing != 0; }
