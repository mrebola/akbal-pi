from PIL import Image, ImageDraw, ImageFont, ImageSequence
import os
import time
import socket
import json
import sys
import threading
import signal
import re
import math

from camera import CameraThread
from utils import ColorUtils, ImageUtils, TextUtils
from whisplay_client import create_whisplay_hardware

STATUS_ICON_DIR = os.path.join(os.path.dirname(__file__), "status-bar-icon")
if STATUS_ICON_DIR not in sys.path:
    sys.path.append(STATUS_ICON_DIR)

from battery_icon import BatteryStatusIcon
from wifi_icon import WifiStatusIcon

IMG_DIR = os.path.join(os.path.dirname(__file__), "img")

# ==================== Minimalist idle/talking video UI ====================
# A thin top bar shows the wifi/battery icons and a small LOCAL/AGENTE tag.
# Below it, the screen shows a looping GIF (character standing idle, or
# talking while the assistant is answering), and the bottom is a fixed black
# band with up to two lines of text for the current response.
TOP_BAR_HEIGHT = 20
VIDEO_WIDTH = 240
VIDEO_HEIGHT = 196
TEXT_BAND_HEIGHT = 64  # LCD_HEIGHT (280) = TOP_BAR_HEIGHT (20) + VIDEO_HEIGHT (196) + TEXT_BAND_HEIGHT (64)
BOTTOM_TEXT_MAX_LINES = 2
BOTTOM_TEXT_FONT_SIZE = 16
BOTTOM_TEXT_MARGIN_X = 10
TOP_BAR_MARGIN_X = 14
# Extra left offset just for the "AKBAL" brand label (see render_top_bar) —
# the case's left edge clips text closer in than TOP_BAR_MARGIN_X alone
# accounts for, confirmed on the real device.
BRAND_LEFT_PADDING = 5
BRAND_LABEL = "AKBAL"
# The right ~10% of the panel is hidden behind the case bezel. This is the
# one global safe-area value every screen's content (top bar, model/mode/
# quick-menu cards, help) is inset by on the right, so nothing ever drifts
# behind it — see docs/display-ui.md.
SAFE_AREA_RIGHT_INSET_PCT = 0.10
SAFE_AREA_RIGHT_INSET = int(VIDEO_WIDTH * SAFE_AREA_RIGHT_INSET_PCT)
GIF_FPS = 10

# ---- Color palette --------------------------------------------------------
# Dark background throughout; green is an *accent* (active state, the
# confirm/select progress, the "agente" tag), never the default text color —
# see docs/display-ui.md for the reasoning (this used to be all-green
# terminal-style text, which read as a hacker screen rather than a voice
# device).
TEXT_PRIMARY = (235, 235, 235, 255)    # main content: names, labels, replies
TEXT_SECONDARY = (150, 155, 160, 255)  # muted: eyebrow headers, hints, examples
ACCENT_GREEN = (80, 255, 120, 255)     # active/selected/confirm accents only
ACCENT_DIM = (35, 60, 45, 255)         # inactive position dots/ticks
TOOL_PLACEHOLDER_RE = re.compile(r"\{tool:([A-Za-z0-9_-]+)\}")


def apply_tool_placeholders(text):
    def replace(match):
        value = current_tool_placeholders.get(match.group(1), "")
        return value or ""
    return TOOL_PLACEHOLDER_RE.sub(replace, text or "")


def is_answering_status(status):
    return (status or "").strip().lower().startswith("answer")


def load_gif_frames(path, width, height):
    """Pre-decode every frame of a GIF into RGB565 byte buffers once, so
    playback is just a list lookup instead of a per-frame decode/resize."""
    frames = []
    if not os.path.exists(path):
        print(f"[Render] GIF not found: {path}")
        return frames
    try:
        image = Image.open(path)
        for frame in ImageSequence.Iterator(image):
            rgba = frame.convert("RGBA")
            frames.append(ImageUtils.image_to_rgb565(rgba, width, height))
    except Exception as e:
        print(f"[Render] Failed to load GIF {path}: {e}")
    return frames


# Global variables
current_status = "Hello"
current_emoji = "😄"
current_text = "Esperando mensaje..."
current_terminal_text = ""
current_tool_placeholders = {}
current_battery_level = 100
current_battery_color = ColorUtils.get_rgb255_from_any("#55FF00")
current_scroll_top = 0
DEFAULT_SCROLL_SPEED = 0.25
MAX_SCROLL_SPEED = 0.5
current_scroll_speed = DEFAULT_SCROLL_SPEED
current_scroll_sync_char_end = None
current_scroll_sync_duration_ms = None
current_scroll_sync_target_top = None
current_scroll_sync_speed = None
current_scroll_sync_hold_until = 0.0
current_transaction_id = None
current_image_path = ""
current_image = None
current_network_connected = None
current_wifi_signal_level = 0
current_vpn_connected = False
current_rag_icon_visible = False
current_image_icon_visible = False
current_music_progress = None
current_music_duration_ms = None
current_approval_mode = False
current_model_ui = ""
current_model_ui_title = ""
current_model_ui_label = ""
current_model_ui_description = ""
current_model_ui_percent = 0
current_model_ui_index = 0
current_model_ui_total = 0
current_model_ui_active = False
current_help_ui = ""
current_help_ui_body = ""
current_help_ui_page = 0
current_help_ui_total = 0
current_top_bar_mode = ""
camera_mode = False
camera_capture_image_path = ""
camera_thread = None
render_thread = None
clients = {}
shutdown_requested = False


class RenderThread(threading.Thread):
    def __init__(self, whisplay, font_path, fps=30):
        super().__init__()
        self.whisplay = whisplay
        self.font_path = font_path
        self.fps = fps
        self.render_init_screen()
        # render_init_screen already blocks for the animation/logo's own
        # duration — this is just a short buffer before the running loop
        # takes over the screen.
        time.sleep(0.2)
        self.running = True
        self.bottom_text_font = ImageFont.truetype(self.font_path, BOTTOM_TEXT_FONT_SIZE)
        ascent, descent = self.bottom_text_font.getmetrics()
        self.bottom_text_line_height = ascent + descent
        self.top_bar_font_size = 14
        self.battery_font = ImageFont.truetype(self.font_path, 11)
        self.gif_frames = {
            "standing": load_gif_frames(os.path.join(IMG_DIR, "standing.gif"), VIDEO_WIDTH, VIDEO_HEIGHT),
            "talking": load_gif_frames(os.path.join(IMG_DIR, "talking.gif"), VIDEO_WIDTH, VIDEO_HEIGHT),
        }
        self.gif_start_time = time.time()
        self.last_drawn_gif_key = None
        self.last_drawn_frame_index = -1
        self.bottom_text_cache_key = None
        self.top_bar_cache_key = None
        self.pending_auto_scroll_after_hold = False
        self.render_event = threading.Event()
        self.model_ui_title_font = ImageFont.truetype(self.font_path, 12)
        self.model_ui_label_font = ImageFont.truetype(self.font_path, 19)
        self.model_ui_hint_font = ImageFont.truetype(self.font_path, 13)
        self.model_ui_cache_key = None
        self.help_ui_title_font = ImageFont.truetype(self.font_path, 12)
        self.help_ui_label_font = ImageFont.truetype(self.font_path, 15)
        self.help_ui_example_font = ImageFont.truetype(self.font_path, 13)
        self.help_ui_hint_font = ImageFont.truetype(self.font_path, 12)
        self.help_ui_cache_key = None
        self.top_bar_mode_font = ImageFont.truetype(self.font_path, 11)

    def render_init_screen(self):
        # Boot animation, full-screen, played for ~1.2s while services start
        # up (models etc. keep loading in the background — this is purely
        # cosmetic). Falls back to a static logo if boot.gif is missing.
        whisplay.set_backlight(100)
        boot_path = os.path.join(IMG_DIR, "boot.gif")
        boot_frames = load_gif_frames(boot_path, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT)
        if boot_frames:
            deadline = time.time() + 1.2
            frame_index = 0
            while time.time() < deadline:
                whisplay.draw_image(
                    0, 0, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT, boot_frames[frame_index % len(boot_frames)]
                )
                frame_index += 1
                time.sleep(1 / 20)
            return
        logo_path = os.path.join(IMG_DIR, "logo.png")
        if os.path.exists(logo_path):
            logo_image = Image.open(logo_path).convert("RGBA")
            logo_image = logo_image.resize((whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT), Image.LANCZOS)
            rgb565_data = ImageUtils.image_to_rgb565(logo_image, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT)
            whisplay.draw_image(0, 0, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT, rgb565_data)

    def render_frame(self, status, text):
        global current_image_path, current_image, camera_mode
        self.pending_auto_scroll_after_hold = False
        if camera_mode:
            return False  # Skip rendering if in camera mode
        if current_model_ui:
            return self.render_model_ui_screen(apply_tool_placeholders(text))
        if self.model_ui_cache_key is not None:
            # Something else (GIF/image) is about to overwrite the video area
            # the model-ui screen drew into — force a full redraw next time
            # it's shown instead of trusting a stale cache key.
            self.model_ui_cache_key = None
        if current_help_ui:
            return self.render_help_screen(apply_tool_placeholders(text))
        if self.help_ui_cache_key is not None:
            self.help_ui_cache_key = None
        if current_image_path not in [None, ""]:
            # Try to load image from path
            if current_image is not None:
                rgb565_data = ImageUtils.image_to_rgb565(current_image, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT)
                self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT, rgb565_data)
            elif os.path.exists(current_image_path):
                try:
                    image = Image.open(current_image_path).convert("RGBA")  # 1024x1024
                    # crop center and resize to fit screen ratio
                    img_w, img_h = image.size
                    screen_ratio = self.whisplay.LCD_WIDTH / self.whisplay.LCD_HEIGHT
                    img_ratio = img_w / img_h
                    if img_ratio > screen_ratio:
                        # crop width
                        new_w = int(img_h * screen_ratio)
                        left = (img_w - new_w) // 2
                        image = image.crop((left, 0, left + new_w, img_h))
                    else:
                        # crop height
                        new_h = int(img_w / screen_ratio)
                        top = (img_h - new_h) // 2
                        image = image.crop((0, top, img_w, top + new_h))
                    image = image.resize((self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT), Image.LANCZOS)
                    current_image = image
                    rgb565_data = ImageUtils.image_to_rgb565(image, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT)
                    self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, self.whisplay.LCD_HEIGHT, rgb565_data)
                except Exception as e:
                    print(f"[Render] Failed to load image {current_image_path}: {e}")
            return False
        else:
            current_image = None
            return self.render_idle_screen(status, apply_tool_placeholders(text))

    def render_model_ui_screen(self, text):
        """Generic "card" screen shown instead of the character GIF for all
        three button-driven carousels — model (model-select-mode.ts), mode
        (mode-select-mode.ts) and the quick menu (quick-menu-mode.ts) — plus
        the model/mode loading wait. model_ui_title is the only thing that
        visually tells them apart ("MODELO" / "MODO" / "MENÚ"); everything
        else (layout, colors, timing) is shared on purpose so the device has
        one consistent menu feel instead of three bespoke ones.

        "loading" is the one indeterminate case — Ollama has no real
        progress API for loading an already-downloaded model into memory —
        so it animates a spinner from wall-clock time instead of showing a
        invented percentage."""
        self.render_top_bar()

        mode = current_model_ui
        title = current_model_ui_title or "MENÚ"
        label = current_model_ui_label or ""
        description = current_model_ui_description or ""
        percent = max(0, min(100, current_model_ui_percent or 0))
        index = current_model_ui_index or 0
        total = max(current_model_ui_total or 0, 0)
        content_width = VIDEO_WIDTH - SAFE_AREA_RIGHT_INSET - 14
        center_x = (VIDEO_WIDTH - SAFE_AREA_RIGHT_INSET) // 2

        # "loading" redraws every tick (spinner animation); everything else
        # only redraws when its content actually changes.
        spinner_frame = int(time.time() * 4) % 12 if mode == "loading" else 0
        cache_key = (mode, title, label, description, percent, index, total, current_model_ui_active, spinner_frame)
        if cache_key != self.model_ui_cache_key:
            self.model_ui_cache_key = cache_key
            frame = Image.new("RGBA", (VIDEO_WIDTH, VIDEO_HEIGHT), (0, 0, 0, 255))
            draw = ImageDraw.Draw(frame)

            draw.text((14, 8), title, font=self.model_ui_title_font, fill=TEXT_SECONDARY)

            name_lines = [
                line for line in TextUtils.wrap_text(draw, label, self.model_ui_label_font, content_width)
                if line
            ][:2] or [""]
            ascent, descent = self.model_ui_label_font.getmetrics()
            line_height = ascent + descent
            name_y = 40
            for line in name_lines:
                bbox = draw.textbbox((0, 0), line, font=self.model_ui_label_font)
                line_w = bbox[2] - bbox[0]
                draw.text((center_x - line_w // 2, name_y), line, font=self.model_ui_label_font, fill=TEXT_PRIMARY)
                name_y += line_height

            if description:
                self._draw_centered(draw, description, self.model_ui_hint_font, name_y + 4, center_x, TEXT_SECONDARY)
                name_y += 20

            if mode == "select":
                if current_model_ui_active:
                    self._draw_centered(draw, "● Activo", self.model_ui_hint_font, name_y + 8, center_x, ACCENT_GREEN)
                if total:
                    self._draw_centered(draw, f"{index} de {total}", self.model_ui_hint_font, VIDEO_HEIGHT - 24, center_x, TEXT_SECONDARY)
            elif mode == "confirm":
                # Real, measured progress (elapsed hold time / hold threshold)
                # — not the same thing as the "loading" spinner below.
                self._draw_ring(draw, center_x, VIDEO_HEIGHT - 46, 22, percent / 100.0, ACCENT_GREEN)
                self._draw_centered(draw, f"{int(percent)}%", self.model_ui_hint_font, VIDEO_HEIGHT - 54, center_x, ACCENT_GREEN)
            elif mode == "loading":
                self._draw_spinner(draw, center_x, VIDEO_HEIGHT - 46, 16, spinner_frame, ACCENT_GREEN)

            rgb565_data = ImageUtils.image_to_rgb565(frame, VIDEO_WIDTH, VIDEO_HEIGHT)
            self.whisplay.draw_image(0, TOP_BAR_HEIGHT, VIDEO_WIDTH, VIDEO_HEIGHT, rgb565_data)

        self.render_bottom_text(text)
        return mode == "loading"  # only the spinner needs continuous frames

    def render_help_screen(self, text):
        """Voice-command cheat sheet (chat-flow/help-mode.ts), opened by
        saying "ayuda" while holding the button, or from the quick menu.
        Click pages through at most two screens; holding the button or a
        double click exits — no dedicated "SALIR" screen (see help-mode.ts).

        help_ui_body is "label\\nexample\\nlabel\\nexample..." — one pair per
        command, always emitted in that order. Even lines (the label) render
        as primary text and slightly larger; odd lines (the phrase to say)
        render smaller and muted, so each pair reads as one grouped item."""
        self.render_top_bar()

        body = current_help_ui_body or ""
        page = current_help_ui_page or 0
        total = max(current_help_ui_total or 0, 0)
        content_width = VIDEO_WIDTH - SAFE_AREA_RIGHT_INSET - 14

        cache_key = (body, page, total)
        if cache_key != self.help_ui_cache_key:
            self.help_ui_cache_key = cache_key
            frame = Image.new("RGBA", (VIDEO_WIDTH, VIDEO_HEIGHT), (0, 0, 0, 255))
            draw = ImageDraw.Draw(frame)

            draw.text((14, 8), "AYUDA", font=self.help_ui_title_font, fill=TEXT_SECONDARY)

            label_ascent, label_descent = self.help_ui_label_font.getmetrics()
            example_ascent, example_descent = self.help_ui_example_font.getmetrics()
            label_line_height = label_ascent + label_descent + 2
            example_line_height = example_ascent + example_descent
            pair_gap = 10

            y = 34
            raw_lines = body.split("\n")
            for i, raw_line in enumerate(raw_lines):
                is_label = (i % 2) == 0
                font = self.help_ui_label_font if is_label else self.help_ui_example_font
                color = TEXT_PRIMARY if is_label else TEXT_SECONDARY
                # Defensive wrap in case a future entry runs long — normal
                # entries fit on one line at this width/size.
                wrapped = [
                    line for line in TextUtils.wrap_text(draw, raw_line, font, content_width)
                    if line != ""
                ] or [""]
                for line in wrapped:
                    draw.text((14, y), line, font=font, fill=color)
                    y += label_line_height if is_label else example_line_height
                if not is_label:
                    y += pair_gap

            if total:
                center_x = (VIDEO_WIDTH - SAFE_AREA_RIGHT_INSET) // 2
                self._draw_centered(draw, f"{page} de {total}", self.help_ui_hint_font, VIDEO_HEIGHT - 20, center_x, TEXT_SECONDARY)

            rgb565_data = ImageUtils.image_to_rgb565(frame, VIDEO_WIDTH, VIDEO_HEIGHT)
            self.whisplay.draw_image(0, TOP_BAR_HEIGHT, VIDEO_WIDTH, VIDEO_HEIGHT, rgb565_data)

        self.render_bottom_text(text)
        return False  # event-driven: Node pushes a new frame on every change

    def _draw_centered(self, draw, text, font, y, center_x=None, fill=TEXT_PRIMARY):
        cx = center_x if center_x is not None else VIDEO_WIDTH // 2
        bbox = draw.textbbox((0, 0), text, font=font)
        w = bbox[2] - bbox[0]
        draw.text((cx - w // 2, y), text, font=font, fill=fill)

    def _draw_spinner(self, draw, cx, cy, radius, frame_index, color, dot_count=12):
        """Indeterminate loading spinner — a ring of dots fading out behind a
        lit "head", rotating one step per frame_index. Used instead of a
        percentage while there's nothing real to measure (see
        render_model_ui_screen's "loading" mode)."""
        for i in range(dot_count):
            angle = (2 * math.pi * i / dot_count) - (math.pi / 2)
            x = cx + radius * math.cos(angle)
            y = cy + radius * math.sin(angle)
            distance_behind = (i - frame_index) % dot_count
            if distance_behind == 0:
                dot_r, dot_fill = 4, color
            elif distance_behind <= 3:
                dot_r, dot_fill = 3, ACCENT_DIM
            else:
                dot_r, dot_fill = 2, ACCENT_DIM
            draw.ellipse((x - dot_r, y - dot_r, x + dot_r, y + dot_r), fill=dot_fill)

    def _draw_ring(self, draw, cx, cy, radius, fraction, color):
        """Real progress ring (0-1) for the hold-to-confirm gesture — a
        measured elapsed/threshold ratio, unlike the loading spinner above."""
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), outline=ACCENT_DIM, width=3)
        if fraction > 0:
            start = -90
            end = start + 360 * min(1.0, fraction)
            draw.arc((cx - radius, cy - radius, cx + radius, cy + radius), start=start, end=end, fill=color, width=3)

    def render_idle_screen(self, status, text):
        """Thin top bar (wifi/battery + LOCAL/AGENTE tag), full-width
        looping GIF (standing / talking) in the middle, and a two-line
        caption band at the bottom."""
        self.render_top_bar()

        gif_key = "talking" if is_answering_status(status) else "standing"
        frames = self.gif_frames.get(gif_key) or []
        if frames:
            elapsed = time.time() - self.gif_start_time
            frame_index = int(elapsed * GIF_FPS) % len(frames)
            if gif_key != self.last_drawn_gif_key or frame_index != self.last_drawn_frame_index:
                self.whisplay.draw_image(0, TOP_BAR_HEIGHT, VIDEO_WIDTH, VIDEO_HEIGHT, frames[frame_index])
                self.last_drawn_gif_key = gif_key
                self.last_drawn_frame_index = frame_index
        elif self.last_drawn_gif_key != gif_key:
            black = bytes(VIDEO_WIDTH * VIDEO_HEIGHT * 2)
            self.whisplay.draw_image(0, TOP_BAR_HEIGHT, VIDEO_WIDTH, VIDEO_HEIGHT, black)
            self.last_drawn_gif_key = gif_key

        self.render_bottom_text(text)
        return True  # keep looping so the animation keeps playing

    def render_top_bar(self):
        cache_key = (current_wifi_signal_level, current_battery_level, current_battery_color, current_top_bar_mode)
        if cache_key == self.top_bar_cache_key:
            return
        self.top_bar_cache_key = cache_key
        bar = Image.new("RGBA", (self.whisplay.LCD_WIDTH, TOP_BAR_HEIGHT), (0, 0, 0, 255))
        draw = ImageDraw.Draw(bar)

        icons = []
        if current_wifi_signal_level:
            # icon_center_scale=1.0 keeps the wifi icon at its native 15px
            # height so it fits inside the 20px top bar without clipping
            # (the default 1.4x scale renders it taller than the bar).
            icons.append(WifiStatusIcon(self.top_bar_font_size, current_wifi_signal_level, icon_center_scale=1.0))
        if current_battery_level is not None:
            icons.append(BatteryStatusIcon(current_battery_level, current_battery_color, self.battery_font, self.top_bar_font_size))

        right_inset = int(self.whisplay.LCD_WIDTH * SAFE_AREA_RIGHT_INSET_PCT)
        cursor_x = self.whisplay.LCD_WIDTH - TOP_BAR_MARGIN_X - right_inset
        for icon in icons:
            icon_width, icon_height = icon.measure()
            icon_x = cursor_x - icon_width
            icon_y = (TOP_BAR_HEIGHT - icon_height) // 2
            icon.render(draw, icon_x, icon_y)
            cursor_x = icon_x - TOP_BAR_MARGIN_X

        # "AKBAL" always shows on the left — a fixed brand mark, not a status
        # readout, so it never depends on top_bar_mode being set yet. It
        # still picks up a subtle mode tint (green only for the
        # accent-worthy "agente" state; local/unset stay muted) — see
        # chat-flow/states.ts (top_bar_mode) and docs/agent-mode.md.
        # BRAND_LEFT_PADDING is extra vs. TOP_BAR_MARGIN_X: this label sits
        # right at the case's left edge, which clips a bit more than the
        # icons' side ever needed to account for.
        brand_color = ACCENT_GREEN if current_top_bar_mode == "agent" else TEXT_SECONDARY
        bbox = draw.textbbox((0, 0), BRAND_LABEL, font=self.top_bar_mode_font)
        text_h = bbox[3] - bbox[1]
        draw.text((TOP_BAR_MARGIN_X + BRAND_LEFT_PADDING, (TOP_BAR_HEIGHT - text_h) // 2 - bbox[1]), BRAND_LABEL, font=self.top_bar_mode_font, fill=brand_color)

        rgb565_data = ImageUtils.image_to_rgb565(bar, self.whisplay.LCD_WIDTH, TOP_BAR_HEIGHT)
        self.whisplay.draw_image(0, 0, self.whisplay.LCD_WIDTH, TOP_BAR_HEIGHT, rgb565_data)

    def render_bottom_text(self, text):
        if text == self.bottom_text_cache_key:
            return
        self.bottom_text_cache_key = text
        band = Image.new("RGBA", (self.whisplay.LCD_WIDTH, TEXT_BAND_HEIGHT), (0, 0, 0, 255))
        draw = ImageDraw.Draw(band)
        if text:
            font = self.bottom_text_font
            right_inset = int(self.whisplay.LCD_WIDTH * SAFE_AREA_RIGHT_INSET_PCT)
            max_width = self.whisplay.LCD_WIDTH - BOTTOM_TEXT_MARGIN_X - right_inset
            lines = [line for line in TextUtils.wrap_text(draw, text, font, max_width) if line != ""]
            lines = lines[-BOTTOM_TEXT_MAX_LINES:]
            line_height = self.bottom_text_line_height
            block_height = line_height * len(lines)
            y = max(0, (TEXT_BAND_HEIGHT - block_height) // 2)
            for line in lines:
                draw.text((BOTTOM_TEXT_MARGIN_X, y), line, font=font, fill=TEXT_PRIMARY)
                y += line_height
        rgb565_data = ImageUtils.image_to_rgb565(band, self.whisplay.LCD_WIDTH, TEXT_BAND_HEIGHT)
        self.whisplay.draw_image(0, TOP_BAR_HEIGHT + VIDEO_HEIGHT, self.whisplay.LCD_WIDTH, TEXT_BAND_HEIGHT, rgb565_data)

    def request_render(self):
        self.render_event.set()

    def run(self):
        frame_interval = 1 / self.fps
        while self.running:
            animation_active = self.render_frame(current_status, current_text)
            if animation_active:
                time.sleep(frame_interval)
                continue

            wait_timeout = None
            if self.pending_auto_scroll_after_hold:
                wait_timeout = max(0.0, current_scroll_sync_hold_until - time.time())
            self.render_event.wait(wait_timeout)
            self.render_event.clear()

    def stop(self):
        self.running = False
        self.render_event.set()


def update_display_data(status=None, emoji=None, text=None,
                  text_delta=None,
                  scroll_speed=None, scroll_sync=None, battery_level=None, battery_color=None, image_path=None,
                  network_connected=None, vpn_connected=None, rag_icon_visible=None, image_icon_visible=None, transaction_id=None,
                  wifi_signal_level=None, tool_placeholders=None,
                  music_progress=None, music_duration_ms=None, approval_mode=None, terminal_text=None,
                  model_ui=None, model_ui_title=None, model_ui_label=None, model_ui_description=None, model_ui_percent=None,
                  model_ui_index=None, model_ui_total=None, model_ui_active=None,
                  help_ui=None, help_ui_body=None, help_ui_page=None, help_ui_total=None,
                  top_bar_mode=None):
    global current_status, current_emoji, current_text, current_battery_level
    global current_terminal_text
    global current_tool_placeholders
    global current_battery_color, current_scroll_top, current_scroll_speed, current_image_path
    global current_scroll_sync_char_end, current_scroll_sync_duration_ms
    global current_scroll_sync_target_top, current_scroll_sync_speed
    global current_scroll_sync_hold_until
    global current_network_connected, current_vpn_connected, current_rag_icon_visible, current_image_icon_visible, current_transaction_id
    global current_wifi_signal_level
    global current_music_progress, current_music_duration_ms
    global current_approval_mode
    global current_model_ui, current_model_ui_title, current_model_ui_label, current_model_ui_description, current_model_ui_percent
    global current_model_ui_index, current_model_ui_total, current_model_ui_active
    global current_help_ui, current_help_ui_body, current_help_ui_page, current_help_ui_total
    global current_top_bar_mode
    global render_thread

    next_text = text
    if text is None and text_delta is not None:
        next_text = (current_text or "") + (text_delta or "")
    if text is not None:
        previous_text = current_text or ""
        incoming_text = text or ""
        same_transaction = (
            transaction_id is not None
            and current_transaction_id is not None
            and transaction_id == current_transaction_id
        )
        regressive_update = (
            len(incoming_text) > 0
            and len(incoming_text) < len(previous_text)
            and previous_text.startswith(incoming_text)
        )
        if same_transaction and regressive_update:
            next_text = previous_text
        elif (
            transaction_id is not None
            and current_transaction_id is not None
            and transaction_id != current_transaction_id
        ):
            current_scroll_top = 0
            current_scroll_sync_char_end = None
            current_scroll_sync_duration_ms = None
            current_scroll_sync_target_top = None
            current_scroll_sync_speed = None
            TextUtils.clean_line_image_cache()
        elif not incoming_text.startswith(previous_text):
            if not previous_text.startswith(incoming_text):
                current_scroll_top = 0
                current_scroll_sync_char_end = None
                current_scroll_sync_duration_ms = None
                current_scroll_sync_target_top = None
                current_scroll_sync_speed = None
                TextUtils.clean_line_image_cache()
    if scroll_sync is not None:
        try:
            char_end = scroll_sync.get("char_end", None)
            duration_ms = scroll_sync.get("duration_ms", None)
            if char_end is not None and duration_ms is not None:
                current_scroll_sync_char_end = int(char_end)
                current_scroll_sync_duration_ms = int(duration_ms)
                hold_seconds = max(0.3, (current_scroll_sync_duration_ms / 1000.0) + 0.2)
                current_scroll_sync_hold_until = max(
                    current_scroll_sync_hold_until,
                    time.time() + hold_seconds,
                )
        except Exception as e:
            print(f"[Display] Invalid scroll_sync payload: {e}")
    if scroll_speed is not None:
        try:
            requested_speed = float(scroll_speed)
            current_scroll_speed = min(MAX_SCROLL_SPEED, max(0.0, requested_speed))
        except (TypeError, ValueError):
            print(f"[Display] Invalid scroll_speed payload: {scroll_speed}")
    if network_connected is not None:
        current_network_connected = network_connected
    if wifi_signal_level is not None:
        try:
            current_wifi_signal_level = max(0, min(3, int(wifi_signal_level)))
        except (TypeError, ValueError):
            print(f"[Display] Invalid wifi_signal_level payload: {wifi_signal_level}")
    if vpn_connected is not None:
        current_vpn_connected = vpn_connected
    if rag_icon_visible is not None:
        current_rag_icon_visible = rag_icon_visible
    if image_icon_visible is not None:
        current_image_icon_visible = image_icon_visible
    if transaction_id is not None:
        current_transaction_id = transaction_id
    current_status = status if status is not None else current_status
    current_emoji = emoji if emoji is not None else current_emoji
    current_text = next_text if (text is not None or text_delta is not None) else current_text
    if tool_placeholders is not None:
        if isinstance(tool_placeholders, dict):
            current_tool_placeholders = {
                str(key): str(value)
                for key, value in tool_placeholders.items()
            }
        else:
            current_tool_placeholders = {}
    if terminal_text is not None:
        current_terminal_text = terminal_text or ""
    current_battery_level = battery_level if battery_level is not None else current_battery_level
    current_battery_color = battery_color if battery_color is not None else current_battery_color
    current_image_path = image_path if image_path is not None else current_image_path
    if music_progress is not None:
        current_music_progress = music_progress if music_progress >= 0 else None
    if music_duration_ms is not None:
        current_music_duration_ms = music_duration_ms if music_duration_ms > 0 else None
    if approval_mode is not None:
        current_approval_mode = bool(approval_mode)
    if model_ui is not None:
        current_model_ui = model_ui
    if model_ui_title is not None:
        current_model_ui_title = model_ui_title
    if model_ui_label is not None:
        current_model_ui_label = model_ui_label
    if model_ui_description is not None:
        current_model_ui_description = model_ui_description
    if model_ui_percent is not None:
        try:
            current_model_ui_percent = int(model_ui_percent)
        except (TypeError, ValueError):
            print(f"[Display] Invalid model_ui_percent payload: {model_ui_percent}")
    if model_ui_index is not None:
        current_model_ui_index = model_ui_index
    if model_ui_total is not None:
        current_model_ui_total = model_ui_total
    if model_ui_active is not None:
        current_model_ui_active = bool(model_ui_active)
    if help_ui is not None:
        current_help_ui = help_ui
    if help_ui_body is not None:
        current_help_ui_body = help_ui_body
    if help_ui_page is not None:
        try:
            current_help_ui_page = int(help_ui_page)
        except (TypeError, ValueError):
            print(f"[Display] Invalid help_ui_page payload: {help_ui_page}")
    if help_ui_total is not None:
        try:
            current_help_ui_total = int(help_ui_total)
        except (TypeError, ValueError):
            print(f"[Display] Invalid help_ui_total payload: {help_ui_total}")
    if top_bar_mode is not None:
        current_top_bar_mode = top_bar_mode
    if render_thread is not None:
        render_thread.request_render()


def send_to_all_clients(message):
    """Send message to all connected clients"""
    message_json = json.dumps(message).encode("utf-8") + b"\n"
    for addr, client_socket in clients.items():
        try:
            client_socket.sendall(message_json)
            # Use ellipsis for long messages
            if len(message_json) > 100:
                display_message = message_json[:50] + b"..." + message_json[-50:]
            else:
                display_message = message_json
            print(f"[Server] Sent notification to client {addr}: {display_message}")
        except Exception as e:
            print(f"[Server] Failed to send notification to client {addr}: {e}")

def exit_camera_mode():
    global camera_mode, camera_thread, render_thread
    print("[Camera] Exiting camera mode...")
    if camera_thread is not None:
        camera_thread.stop()
        camera_thread = None
    notification = {"event": "exit_camera_mode"}
    send_to_all_clients(notification)
    camera_mode = False
    if render_thread is not None:
        render_thread.request_render()

def on_button_pressed():
    """Function executed when button is pressed"""
    print("[Server] Button pressed")
    notification = {"event": "button_pressed"}
    send_to_all_clients(notification)

def on_button_release():
    """Function executed when button is released"""
    print("[Server] Button released")
    notification = {"event": "button_released"}
    send_to_all_clients(notification)


def on_app_exit_requested():
    global shutdown_requested, render_thread, whisplay
    if shutdown_requested:
        return
    shutdown_requested = True
    print("[Server] App exit requested by daemon")
    notification = {"event": "app_exit_requested"}
    send_to_all_clients(notification)
    if render_thread is not None:
        render_thread.stop()
    if hasattr(whisplay, "prepare_exit"):
        try:
            whisplay.prepare_exit()
        except Exception as e:
            print(f"[Server] Failed to prepare exit: {e}")
    def _delayed_exit():
        time.sleep(0.5)
        os._exit(0)
    threading.Thread(target=_delayed_exit, daemon=True).start()

def handle_client(client_socket, addr, whisplay):
    global camera_capture_image_path, camera_mode, camera_thread, render_thread
    print(f"[Socket] Client {addr} connected")
    clients[addr] = client_socket
    try:
        buffer = ""
        while True:
            data = client_socket.recv(4096).decode("utf-8")
            if not data:
                break
            buffer += data

            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                if not line.strip():
                    continue

                # print(f"[Socket - {addr}] Received data: {line}")
                try:
                    content = json.loads(line)
                    transaction_id = content.get("transaction_id", None)
                    status = content.get("status", None)
                    emoji = content.get("emoji", None)
                    text = content.get("text", None)
                    text_delta = content.get("text_delta", None)
                    tool_placeholders = content.get("tool_placeholders", None)
                    terminal_text = content.get("terminal_text", None)
                    rgbled = content.get("RGB", None)
                    brightness = content.get("brightness", None)
                    scroll_speed = content.get("scroll_speed", None)
                    scroll_sync = content.get("scroll_sync", None)
                    response_to_client = content.get("response", None)
                    battery_level = content.get("battery_level", None)
                    battery_color = content.get("battery_color", None)
                    image_path = content.get("image", None)
                    network_connected = content.get("network_connected", None)
                    wifi_signal_level = content.get("wifi_signal_level", None)
                    vpn_connected = content.get("vpn_connected", None)
                    rag_icon_visible = content.get("rag_icon_visible", None)
                    image_icon_visible = content.get("image_icon_visible", None)
                    music_progress = content.get("music_progress", None)
                    music_duration_ms = content.get("music_duration_ms", None)
                    approval_mode = content.get("approval_mode", None)
                    capture_image_path = content.get("capture_image_path", None)
                    trigger_camera_capture = content.get("camera_capture", None)
                    # boolean to enable camera mode
                    set_camera_mode = content.get("camera_mode", None)
                    model_ui = content.get("model_ui", None)
                    model_ui_title = content.get("model_ui_title", None)
                    model_ui_label = content.get("model_ui_label", None)
                    model_ui_description = content.get("model_ui_description", None)
                    model_ui_percent = content.get("model_ui_percent", None)
                    model_ui_index = content.get("model_ui_index", None)
                    model_ui_total = content.get("model_ui_total", None)
                    model_ui_active = content.get("model_ui_active", None)
                    help_ui = content.get("help_ui", None)
                    help_ui_body = content.get("help_ui_body", None)
                    help_ui_page = content.get("help_ui_page", None)
                    help_ui_total = content.get("help_ui_total", None)
                    top_bar_mode = content.get("top_bar_mode", None)

                    if rgbled:
                        rgb255_tuple = ColorUtils.get_rgb255_from_any(rgbled)
                        whisplay.set_rgb_fade(*rgb255_tuple, duration_ms=500)

                    if battery_color:
                        battery_tuple = ColorUtils.get_rgb255_from_any(battery_color)
                    else:
                        battery_tuple = None

                    if brightness:
                        whisplay.set_backlight(brightness)

                    if capture_image_path is not None:
                        camera_capture_image_path = capture_image_path

                    if set_camera_mode is not None:
                        if set_camera_mode:
                            print("[Camera] Entering camera mode...")
                            camera_mode = True
                            camera_thread = CameraThread(whisplay, camera_capture_image_path)
                            camera_thread.start()
                        else:
                            print("[Camera] Exiting camera mode...")
                            if camera_thread is not None:
                                camera_thread.stop()
                                camera_thread = None
                            camera_mode = False
                        if render_thread is not None:
                            render_thread.request_render()

                    if trigger_camera_capture:
                        print("[Camera] Capturing image by command...")
                        if camera_thread is not None:
                            camera_thread.capture()
                            notification = {"event": "camera_capture"}
                            send_to_all_clients(notification)

                    if (text is not None) or (text_delta is not None) or (status is not None) or (emoji is not None) or \
                       (battery_level is not None) or (battery_color is not None) or \
                              (image_path is not None) or (network_connected is not None) or \
                            (wifi_signal_level is not None) or \
                            (vpn_connected is not None) or \
                            (rag_icon_visible is not None) or (image_icon_visible is not None) or (scroll_sync is not None) or \
                            (tool_placeholders is not None) or \
                            (music_progress is not None) or (music_duration_ms is not None) or (approval_mode is not None) or \
                            (terminal_text is not None) or \
                            (model_ui is not None) or (model_ui_title is not None) or (model_ui_label is not None) or \
                            (model_ui_description is not None) or (model_ui_percent is not None) or \
                            (model_ui_index is not None) or (model_ui_total is not None) or (model_ui_active is not None) or \
                            (help_ui is not None) or (help_ui_body is not None) or \
                            (help_ui_page is not None) or (help_ui_total is not None) or (top_bar_mode is not None):
                        update_display_data(status=status, emoji=emoji,
                                     text=text, text_delta=text_delta, scroll_speed=scroll_speed, scroll_sync=scroll_sync,
                                     battery_level=battery_level, battery_color=battery_tuple,
                                                 image_path=image_path, network_connected=network_connected,
                                                 wifi_signal_level=wifi_signal_level,
                                     tool_placeholders=tool_placeholders,
                                     vpn_connected=vpn_connected,
                                                 rag_icon_visible=rag_icon_visible,
                                         image_icon_visible=image_icon_visible,
                                                 transaction_id=transaction_id,
                                                 music_progress=music_progress,
                                                 music_duration_ms=music_duration_ms,
                                                 approval_mode=approval_mode,
                                                 terminal_text=terminal_text,
                                                 model_ui=model_ui,
                                                 model_ui_title=model_ui_title,
                                                 model_ui_label=model_ui_label,
                                                 model_ui_description=model_ui_description,
                                                 model_ui_percent=model_ui_percent,
                                                 model_ui_index=model_ui_index,
                                                 model_ui_total=model_ui_total,
                                                 model_ui_active=model_ui_active,
                                                 help_ui=help_ui,
                                                 help_ui_body=help_ui_body,
                                                 help_ui_page=help_ui_page,
                                                 help_ui_total=help_ui_total,
                                                 top_bar_mode=top_bar_mode)

                    client_socket.send(b"OK\n")
                    if response_to_client:
                        try:
                            response_bytes = json.dumps({"response": response_to_client}).encode("utf-8") + b"\n"
                            client_socket.send(response_bytes)
                            print(f"[Socket - {addr}] Sent response: {response_to_client}")
                        except Exception as e:
                            print(f"[Socket - {addr}] Response sending error: {e}")

                except json.JSONDecodeError:
                    client_socket.send(b"ERROR: invalid JSON\n")
                except Exception as e:
                    print(f"[Socket - {addr}] Data processing error: {e}")
                    client_socket.send(f"ERROR: {e}\n".encode("utf-8"))

    except Exception as e:
        print(f"[Socket - {addr}] Connection error: {e}")
    finally:
        print(f"[Socket] Client {addr} disconnected")
        del clients[addr]
        client_socket.close()

def start_socket_server(render_thread, host='0.0.0.0', port=12345):
    # Register button events
    whisplay.on_button_press(on_button_pressed)
    whisplay.on_button_release(on_button_release)

    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_socket.bind((host, port))
    server_socket.listen(5)  # Allow more connections
    print(f"[Socket] Listening on {host}:{port} ...")

    try:
        while True:
            client_socket, addr = server_socket.accept()
            client_thread = threading.Thread(target=handle_client,
                                           args=(client_socket, addr, whisplay))
            client_thread.daemon = True
            client_thread.start()
    except KeyboardInterrupt:
        print("[Socket] Server stopped")
    finally:
        render_thread.stop()
        server_socket.close()


if __name__ == "__main__":
    whisplay = create_whisplay_hardware()
    print(f"[LCD] Initialization finished: {whisplay.LCD_WIDTH}x{whisplay.LCD_HEIGHT}")
    if hasattr(whisplay, "on_exit_request"):
        whisplay.on_exit_request(on_app_exit_requested)

    # read CUSTOM_FONT_PATH from environment variable
    custom_font_path = os.getenv("CUSTOM_FONT_PATH", None)

    # start render thread
    render_thread = RenderThread(whisplay, custom_font_path or "NotoSansSC-Bold.ttf", fps=30)
    render_thread.start()
    start_socket_server(render_thread, host='0.0.0.0', port=12345)

    def cleanup_and_exit(signum, frame):
        print("[System] Exiting...")
        render_thread.stop()
        whisplay.cleanup()
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup_and_exit)
    signal.signal(signal.SIGINT, cleanup_and_exit)
    signal.signal(signal.SIGKILL, cleanup_and_exit)
    signal.signal(signal.SIGQUIT, cleanup_and_exit)
    signal.signal(signal.SIGSTOP, cleanup_and_exit)
    try:
        # Keep the main thread alive
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        cleanup_and_exit(None, None)
