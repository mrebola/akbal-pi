/* app/doom/engine/i_akbal_sound.c
 * Sound effects for Akbal Pi. DoomGeneric has no mixer of its own: this file
 * mixes up to 8 DMX samples (11025 Hz, 8-bit unsigned, 8-byte header) into a
 * 16-bit mono stream and writes it to AKBAL_AUDIO_FD (fd 3), where Node plays it.
 * Replaces upstream i_sound.c and i_cdmus.c (duplicate I_* symbols). Music is a
 * no-op here until a music backend exists.
 *
 * I_UpdateSound runs once per game tic (~35 Hz), so the number of samples per
 * call follows the wall clock, not a fixed block size: the stream stays at
 * 11025 samples per second no matter how often the game calls us. */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include "doomtype.h"
#include "doomgeneric.h"
#include "sounds.h"
#include "i_sound.h"
#include "z_zone.h"
#include "w_wad.h"

#define AKBAL_AUDIO_FD 3
#define MIX_RATE 11025
#define MAX_CHANNELS 8
/* Upper bound per call (~186 ms). After a long pause the backlog is dropped
 * instead of written in one burst. */
#define MAX_CHUNK 2048

typedef struct {
  const uint8_t *data;   /* 8-bit unsigned samples, after the 8-byte DMX header */
  int length;
  int pos;
  int vol;               /* 0..127 */
  int active;
} voice_t;

static voice_t voices[MAX_CHANNELS];
static int16_t out_block[MAX_CHUNK];
static int audio_volume = 100;   /* 0..100, set from stdin "volume <n>" */

/* Sample clock: samples_written should track (now - clock_origin_ms) * MIX_RATE.
 * Counting in samples (not advancing a ms mark by n*1000/MIX_RATE) avoids
 * losing the sub-millisecond part on every call. */
static uint32_t clock_origin_ms;
static uint64_t samples_written;
static int audio_closed = 0;     /* set on EPIPE/EBADF: stop writing, keep the game */

/* Config variables read by m_config.c and d_main.c (defined upstream in i_sound.c). */
int snd_samplerate = MIX_RATE;
int snd_cachesize = 64 * 1024 * 1024;
int snd_maxslicetime_ms = 28;
char *snd_musiccmd = "";
int snd_musicdevice = 0;
int snd_sfxdevice = 0;
int snd_sbport = 0;
int snd_sbirq = 0;
int snd_sbdma = 0;
int snd_mport = 0;
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

void akbal_set_volume(int v) { audio_volume = v < 0 ? 0 : (v > 100 ? 100 : v); }

void I_BindSoundVariables(void) {}

void I_InitSound(boolean use_sfx_prefix) {
  (void)use_sfx_prefix;
  memset(voices, 0, sizeof voices);
  clock_origin_ms = DG_GetTicksMs();
  samples_written = 0;
  audio_closed = 0;
  /* If Node closes its end of fd 3 mid-game, write() must fail with EPIPE
   * instead of killing the engine with SIGPIPE. */
  signal(SIGPIPE, SIG_IGN);
}

void I_ShutdownSound(void) { memset(voices, 0, sizeof voices); }

int I_GetSfxLumpNum(sfxinfo_t *sfx) {
  char name[9];
  snprintf(name, sizeof name, "ds%s", sfx->name);
  return W_GetNumForName(name);
}

void I_PrecacheSounds(sfxinfo_t *sounds, int num_sounds) { (void)sounds; (void)num_sounds; }

int I_StartSound(sfxinfo_t *sfx, int channel, int vol, int sep) {
  (void)sep;   /* mono output: no panning */
  if (channel < 0 || channel >= MAX_CHANNELS) return -1;
  int lump = I_GetSfxLumpNum(sfx);
  const uint8_t *raw = W_CacheLumpNum(lump, PU_STATIC);
  int len = (int)W_LumpLength((unsigned int)lump);
  if (len <= 8) return -1;
  voices[channel].data = raw + 8;   /* skip DMX header */
  voices[channel].length = len - 8;
  voices[channel].pos = 0;
  voices[channel].vol = vol;
  voices[channel].active = 1;
  return channel;
}

void I_StopSound(int channel) { if (channel >= 0 && channel < MAX_CHANNELS) voices[channel].active = 0; }

boolean I_SoundIsPlaying(int channel) {
  return channel >= 0 && channel < MAX_CHANNELS && voices[channel].active;
}

void I_UpdateSoundParams(int channel, int vol, int sep) {
  (void)sep;
  if (channel >= 0 && channel < MAX_CHANNELS) voices[channel].vol = vol;
}

/* Mixes n samples from the active voices into out_block. */
static void mix_samples(int n) {
  for (int i = 0; i < n; i++) {
    int32_t acc = 0;
    for (int c = 0; c < MAX_CHANNELS; c++) {
      voice_t *v = &voices[c];
      if (!v->active) continue;
      if (v->pos >= v->length) { v->active = 0; continue; }
      int s = (int)v->data[v->pos++] - 128;     /* unsigned 8-bit to signed */
      /* 8-bit to 16-bit is <<8; vol 127 * 2 maps full scale to ~32512. */
      acc += s * v->vol * 2;
    }
    acc = (acc * audio_volume) / 100;           /* DOOM volume, from the phone */
    if (acc > 32767) acc = 32767;
    if (acc < -32768) acc = -32768;
    out_block[i] = (int16_t)acc;
  }
}

/* Called from the game loop (s_sound.c, ~35 Hz). Writes the samples that the
 * wall clock says are due, so the stream runs at MIX_RATE. */
void I_UpdateSound(void) {
  if (audio_closed) return;

  uint64_t target = (uint64_t)(DG_GetTicksMs() - clock_origin_ms) * MIX_RATE / 1000;
  if (target <= samples_written) return;

  uint64_t n = target - samples_written;
  if (n > MAX_CHUNK) {
    /* Long pause: drop the backlog so we don't burst it out at once. */
    samples_written = target - MAX_CHUNK;
    n = MAX_CHUNK;
  }
  mix_samples((int)n);
  samples_written += n;

  /* Raw PCM, little-endian on the Pi. A write failure is not fatal: the game
   * keeps running silently when Node has closed the audio pipe. */
  const uint8_t *p = (const uint8_t *)out_block;
  size_t total = (size_t)n * sizeof(int16_t), off = 0;
  while (off < total) {
    ssize_t w = write(AKBAL_AUDIO_FD, p + off, total - off);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EPIPE || errno == EBADF) audio_closed = 1;
      return;
    }
    off += (size_t)w;
  }
}

/* Music: no backend yet. Stubs keep the link working without upstream i_sound.c. */
void I_InitMusic(void) {}
void I_ShutdownMusic(void) {}
void I_SetMusicVolume(int volume) { (void)volume; }
void I_PauseSong(void) {}
void I_ResumeSong(void) {}
void *I_RegisterSong(void *data, int len) { (void)data; (void)len; return NULL; }
void I_UnRegisterSong(void *handle) { (void)handle; }
void I_PlaySong(void *handle, boolean looping) { (void)handle; (void)looping; }
void I_StopSong(void) {}
boolean I_MusicIsPlaying(void) { return false; }
