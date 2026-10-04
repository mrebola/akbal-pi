/* app/doom/engine/i_akbal_sound.c
 * Sound effects for Akbal Pi. DoomGeneric has no mixer of its own: this file
 * mixes up to 8 DMX samples (11025 Hz, 8-bit unsigned, 8-byte header) into a
 * 16-bit mono stream and writes it to AKBAL_AUDIO_FD (fd 3), where Node plays it.
 * Replaces upstream i_sound.c and i_cdmus.c (duplicate I_* symbols). Music is a
 * no-op here until a music backend exists. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include "doomtype.h"
#include "sounds.h"
#include "i_sound.h"
#include "z_zone.h"
#include "w_wad.h"

#define AKBAL_AUDIO_FD 3
#define MIX_BLOCK 256
#define MAX_CHANNELS 8

typedef struct {
  const uint8_t *data;   /* 8-bit unsigned samples, after the 8-byte DMX header */
  int length;
  int pos;
  int vol;               /* 0..127 */
  int active;
} voice_t;

static voice_t voices[MAX_CHANNELS];
static int16_t out_block[MIX_BLOCK];
static int audio_volume = 100;   /* 0..100, set from stdin "volume <n>" */

/* Config variables read by m_config.c and d_main.c (defined upstream in i_sound.c). */
int snd_samplerate = 11025;
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

/* Called once per game tic (s_sound.c). Mixes one block and writes it to fd 3. */
void I_UpdateSound(void) {
  for (int i = 0; i < MIX_BLOCK; i++) {
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
  /* Raw PCM, little-endian on the Pi. A write failure is not fatal: the game
   * keeps running silently if Node closed the audio pipe. */
  ssize_t n = write(AKBAL_AUDIO_FD, out_block, sizeof out_block);
  (void)n;
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
