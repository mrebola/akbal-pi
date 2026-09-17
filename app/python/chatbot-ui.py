from PIL import Image, ImageDraw, ImageFont, ImageSequence
import os
import time
import socket
import json
import sys
import threading
import signal
import re

from camera import CameraThread
from utils import ColorUtils, ImageUtils, TextUtils
from whisplay_client import create_whisplay_hardware

IMG_DIR = os.path.join(os.path.dirname(__file__), "img")

# ==================== Minimalist idle/talking video UI ====================
# The top of the screen shows a looping GIF (character standing idle, or
# talking while the assistant is answering) and the bottom is a fixed black
# band with up to two lines of green terminal-style text for the current
# response. No header, no emoji, no status icons.
VIDEO_WIDTH = 240
VIDEO_HEIGHT = 216
TEXT_BAND_HEIGHT = 64  # LCD_HEIGHT (280) - VIDEO_HEIGHT (216)
BOTTOM_TEXT_MAX_LINES = 2
BOTTOM_TEXT_FONT_SIZE = 16
BOTTOM_TEXT_MARGIN_X = 10
GIF_FPS = 10
TERMINAL_FG = (80, 255, 120, 255)
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
current_text = "Waiting for message..."
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
        # Clear logo after 1 second and start running loop
        time.sleep(1)
        self.running = True
        self.bottom_text_font = ImageFont.truetype(self.font_path, BOTTOM_TEXT_FONT_SIZE)
        ascent, descent = self.bottom_text_font.getmetrics()
        self.bottom_text_line_height = ascent + descent
        self.gif_frames = {
            "standing": load_gif_frames(os.path.join(IMG_DIR, "standing.gif"), VIDEO_WIDTH, VIDEO_HEIGHT),
            "talking": load_gif_frames(os.path.join(IMG_DIR, "talking.gif"), VIDEO_WIDTH, VIDEO_HEIGHT),
        }
        self.gif_start_time = time.time()
        self.last_drawn_gif_key = None
        self.last_drawn_frame_index = -1
        self.bottom_text_cache_key = None
        self.pending_auto_scroll_after_hold = False
        self.render_event = threading.Event()

    def render_init_screen(self):
        # Display logo on startup
        logo_path = os.path.join(IMG_DIR, "logo.png")
        if os.path.exists(logo_path):
            logo_image = Image.open(logo_path).convert("RGBA")
            logo_image = logo_image.resize((whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT), Image.LANCZOS)
            rgb565_data = ImageUtils.image_to_rgb565(logo_image, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT)
            whisplay.set_backlight(100)
            whisplay.draw_image(0, 0, whisplay.LCD_WIDTH, whisplay.LCD_HEIGHT, rgb565_data)

    def render_frame(self, status, text):
        global current_image_path, current_image, camera_mode
        self.pending_auto_scroll_after_hold = False
        if camera_mode:
            return False  # Skip rendering if in camera mode
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

    def render_idle_screen(self, status, text):
        """Full-screen looping GIF (standing / talking) with a two-line
        green terminal-style caption band at the bottom."""
        gif_key = "talking" if is_answering_status(status) else "standing"
        frames = self.gif_frames.get(gif_key) or []
        if frames:
            elapsed = time.time() - self.gif_start_time
            frame_index = int(elapsed * GIF_FPS) % len(frames)
            if gif_key != self.last_drawn_gif_key or frame_index != self.last_drawn_frame_index:
                self.whisplay.draw_image(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT, frames[frame_index])
                self.last_drawn_gif_key = gif_key
                self.last_drawn_frame_index = frame_index
        elif self.last_drawn_gif_key != gif_key:
            black = bytes(VIDEO_WIDTH * VIDEO_HEIGHT * 2)
            self.whisplay.draw_image(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT, black)
            self.last_drawn_gif_key = gif_key

        self.render_bottom_text(text)
        return True  # keep looping so the animation keeps playing

    def render_bottom_text(self, text):
        if text == self.bottom_text_cache_key:
            return
        self.bottom_text_cache_key = text
        band = Image.new("RGBA", (self.whisplay.LCD_WIDTH, TEXT_BAND_HEIGHT), (0, 0, 0, 255))
        draw = ImageDraw.Draw(band)
        if text:
            font = self.bottom_text_font
            max_width = self.whisplay.LCD_WIDTH - 2 * BOTTOM_TEXT_MARGIN_X
            lines = [line for line in TextUtils.wrap_text(draw, text, font, max_width) if line != ""]
            lines = lines[-BOTTOM_TEXT_MAX_LINES:]
            line_height = self.bottom_text_line_height
            block_height = line_height * len(lines)
            y = max(0, (TEXT_BAND_HEIGHT - block_height) // 2)
            for line in lines:
                draw.text((BOTTOM_TEXT_MARGIN_X, y), line, font=font, fill=TERMINAL_FG)
                y += line_height
        rgb565_data = ImageUtils.image_to_rgb565(band, self.whisplay.LCD_WIDTH, TEXT_BAND_HEIGHT)
        self.whisplay.draw_image(0, VIDEO_HEIGHT, self.whisplay.LCD_WIDTH, TEXT_BAND_HEIGHT, rgb565_data)

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
                  music_progress=None, music_duration_ms=None, approval_mode=None, terminal_text=None):
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
                            (terminal_text is not None):
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
                                                 terminal_text=terminal_text)

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
