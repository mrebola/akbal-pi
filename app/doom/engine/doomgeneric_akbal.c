/* app/doom/engine/doomgeneric_akbal.c
 * Platform layer for DoomGeneric on Akbal Pi. Frames go to stdout for the
 * Node side; key events come in on stdin. Scaled to 280x175 RGB565 so the
 * Node process and the LCD never scale. */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/select.h>
#include "doomgeneric.h"
#include "doomkeys.h"

#define OUT_W 280
#define OUT_H 175
#define OUT_BYTES (OUT_W * OUT_H * 2)

static uint8_t out_frame[OUT_BYTES];
static FILE *frame_out;            /* solo cuadros; stdout del motor va a stderr */
static struct timespec start_ts;
static uint8_t key_queue[64][2];   /* [pressed, key] */
static int key_head = 0, key_tail = 0;

void akbal_set_volume(int v);      /* i_akbal_sound.c */

static void queue_key(int pressed, unsigned char key) {
  int next = (key_tail + 1) % 64;
  if (next == key_head) return;    /* drop if full */
  key_queue[key_tail][0] = (uint8_t)pressed;
  key_queue[key_tail][1] = key;
  key_tail = next;
}

/* Reads every pending "down N" / "up N" line without blocking. */
static void pump_stdin(void) {
  static char line[64];
  static int len = 0;
  fd_set rfds;
  struct timeval tv = {0, 0};
  FD_ZERO(&rfds);
  FD_SET(STDIN_FILENO, &rfds);
  while (select(STDIN_FILENO + 1, &rfds, NULL, NULL, &tv) > 0) {
    char c;
    if (read(STDIN_FILENO, &c, 1) != 1) return;
    if (c == '\n') {
      line[len] = 0;
      int code = 0;
      if (strncmp(line, "down ", 5) == 0) { code = atoi(line + 5); queue_key(1, (unsigned char)code); }
      else if (strncmp(line, "up ", 3) == 0) { code = atoi(line + 3); queue_key(0, (unsigned char)code); }
      else if (strncmp(line, "volume ", 7) == 0) { akbal_set_volume(atoi(line + 7)); }
      len = 0;
    } else if (len < 63) {
      line[len++] = c;
    }
    FD_ZERO(&rfds);
    FD_SET(STDIN_FILENO, &rfds);
  }
}

void DG_Init(void) {
  clock_gettime(CLOCK_MONOTONIC, &start_ts);
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
}

void DG_DrawFrame(void) {
  /* Nearest-neighbour from 320x200 to 280x175, RGB565 little-endian. */
  for (int y = 0; y < OUT_H; y++) {
    int sy = y * DOOMGENERIC_RESY / OUT_H;
    for (int x = 0; x < OUT_W; x++) {
      int sx = x * DOOMGENERIC_RESX / OUT_W;
      uint32_t p = DG_ScreenBuffer[sy * DOOMGENERIC_RESX + sx];
      uint8_t r = (p >> 16) & 0xF8, g = (p >> 8) & 0xFC, b = p & 0xF8;
      uint16_t v = (uint16_t)((r << 8) | (g << 3) | (b >> 3));
      int i = (y * OUT_W + x) * 2;
      out_frame[i] = (uint8_t)(v & 0xFF);
      out_frame[i + 1] = (uint8_t)(v >> 8);
    }
  }
  /* Cabecera little-endian explicita, independiente del endian del host. */
  uint8_t hdr[4] = {
    OUT_BYTES & 0xff, (OUT_BYTES >> 8) & 0xff,
    (OUT_BYTES >> 16) & 0xff, (OUT_BYTES >> 24) & 0xff,
  };
  fwrite(hdr, 1, 4, frame_out);
  fwrite(out_frame, 1, OUT_BYTES, frame_out);
  fflush(frame_out);
}

void DG_SleepMs(uint32_t ms) { usleep(ms * 1000); }

uint32_t DG_GetTicksMs(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (uint32_t)((now.tv_sec - start_ts.tv_sec) * 1000 + (now.tv_nsec - start_ts.tv_nsec) / 1000000);
}

int DG_GetKey(int *pressed, unsigned char *key) {
  pump_stdin();
  if (key_head == key_tail) return 0;
  *pressed = key_queue[key_head][0];
  *key = key_queue[key_head][1];
  key_head = (key_head + 1) % 64;
  return 1;
}

void DG_SetWindowTitle(const char *title) { (void)title; }

#define AUDIO_FD 3

/* Si Node no pasó fd 3, el siguiente dup() tomaría 3 y los cuadros de video
 * compartirían descriptor con el PCM. Reservamos 3 con /dev/null. Si Node sí
 * lo pasó, no se toca. Si falla, se sigue sin guardia (el audio se pierde,
 * el video no). */
static void reserve_audio_fd(void) {
  if (fcntl(AUDIO_FD, F_GETFD) >= 0) return;
  int nul = open("/dev/null", O_WRONLY);
  if (nul < 0) { fprintf(stderr, "[DOOM] open(/dev/null) falló: fd 3 sin reservar\n"); return; }
  if (nul != AUDIO_FD) {
    if (dup2(nul, AUDIO_FD) < 0) fprintf(stderr, "[DOOM] dup2 a fd 3 falló: fd 3 sin reservar\n");
    close(nul);
  }
}

int main(int argc, char **argv) {
  /* Antes de dup(stdout): el dup de los cuadros no debe tomar fd 3. */
  reserve_audio_fd();

  /* El motor imprime logs con printf/puts a stdout. Guardamos el descriptor
   * original para los cuadros y mandamos stdout a stderr antes de iniciar. */
  int frame_fd = dup(STDOUT_FILENO);
  if (frame_fd < 0) { fprintf(stderr, "[DOOM] dup(stdout) falló\n"); return 1; }
  if (dup2(STDERR_FILENO, STDOUT_FILENO) < 0) { fprintf(stderr, "[DOOM] dup2 falló\n"); return 1; }
  frame_out = fdopen(frame_fd, "wb");
  if (!frame_out) { fprintf(stderr, "[DOOM] fdopen falló\n"); return 1; }

  doomgeneric_Create(argc, argv);
  for (;;) doomgeneric_Tick();
  return 0;
}
