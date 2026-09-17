from utils import ColorUtils
from icon_constants import STATUS_ICON_HEIGHT


class BatteryStatusIcon:
    def __init__(self, battery_level, battery_color, battery_font, status_font_size):
        self.battery_level = battery_level
        self.battery_color = battery_color
        self.battery_font = battery_font
        self.status_font_size = status_font_size
        self.battery_width = 26
        self.battery_height = STATUS_ICON_HEIGHT
        self.corner_radius = 3
        self.line_width = 2
        self.head_width = 2
        self.head_height = 5
        self.outline_color = "white"

    def measure(self):
        return (self.battery_width + self.head_width, self.battery_height)

    def get_top_y(self):
        return self.status_font_size // 2

    def render(self, draw, x, y):
        fill_color = self.battery_color or (0, 0, 0)
        battery_x = x
        battery_y = y

        # Draw rounded corners
        draw.arc((battery_x, battery_y, battery_x + 2 * self.corner_radius, battery_y + 2 * self.corner_radius),
                 180, 270, fill=self.outline_color, width=self.line_width)
        draw.arc((battery_x + self.battery_width - 2 * self.corner_radius, battery_y,
                  battery_x + self.battery_width, battery_y + 2 * self.corner_radius),
                 270, 0, fill=self.outline_color, width=self.line_width)
        draw.arc((battery_x, battery_y + self.battery_height - 2 * self.corner_radius,
                  battery_x + 2 * self.corner_radius, battery_y + self.battery_height),
                 90, 180, fill=self.outline_color, width=self.line_width)
        draw.arc((battery_x + self.battery_width - 2 * self.corner_radius,
                  battery_y + self.battery_height - 2 * self.corner_radius,
                  battery_x + self.battery_width, battery_y + self.battery_height),
                 0, 90, fill=self.outline_color, width=self.line_width)

        # Draw top and bottom lines
        draw.line([(battery_x + self.corner_radius, battery_y),
                   (battery_x + self.battery_width - self.corner_radius, battery_y)],
                  fill=self.outline_color, width=self.line_width)
        draw.line([(battery_x + self.corner_radius, battery_y + self.battery_height),
                   (battery_x + self.battery_width - self.corner_radius, battery_y + self.battery_height)],
                  fill=self.outline_color, width=self.line_width)

        # Draw left and right lines
        draw.line([(battery_x, battery_y + self.corner_radius),
                   (battery_x, battery_y + self.battery_height - self.corner_radius)],
                  fill=self.outline_color, width=self.line_width)
        draw.line([(battery_x + self.battery_width, battery_y + self.corner_radius),
                   (battery_x + self.battery_width, battery_y + self.battery_height - self.corner_radius)],
                  fill=self.outline_color, width=self.line_width)

        if fill_color != (0, 0, 0):
            draw.rectangle([battery_x + self.line_width // 2, battery_y + self.line_width // 2,
                            battery_x + self.battery_width - self.line_width // 2,
                            battery_y + self.battery_height - self.line_width // 2],
                           fill=fill_color)

        # Battery head
        head_x = battery_x + self.battery_width
        head_y = battery_y + (self.battery_height - self.head_height) // 2
        draw.rectangle([head_x, head_y, head_x + self.head_width, head_y + self.head_height],
                       fill=self.outline_color)

        # Battery level text
        battery_text = str(self.battery_level)
        text_bbox = self.battery_font.getbbox(battery_text)
        text_w = text_bbox[2] - text_bbox[0]
        text_y = battery_y + (self.battery_height - (self.battery_font.getmetrics()[0] + self.battery_font.getmetrics()[1])) // 2
        text_x = battery_x + (self.battery_width - text_w) // 2

        luminance = ColorUtils.calculate_luminance(fill_color)
        text_fill_color = "black" if luminance > 128 else "white"
        draw.text((text_x, text_y), battery_text, font=self.battery_font, fill=text_fill_color)
