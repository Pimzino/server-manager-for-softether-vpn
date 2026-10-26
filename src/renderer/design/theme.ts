// Mantine theme: maps Mantine's scales onto the design tokens (tokens.css) and sets native-like defaults
// (13 px text, 26 px controls, quiet badges, compact menus).
import {
  ActionIcon, Badge, Button, Checkbox, Code, createTheme, Input, InputWrapper, Kbd, Loader, Menu, Modal, NavLink, Notification,
  Pagination, Paper, Popover, Radio, SegmentedControl, Select, Switch, Tabs, Tooltip, type MantineColorsTuple,
} from "@mantine/core";

const accent: MantineColorsTuple = ["#e7f2ff", "#cfe4ff", "#9ec8ff", "#6aabff", "#3d93ff", "#0a84ff", "#007aff", "#0066d6", "#0052ad", "#003d82"];
const gray: MantineColorsTuple = ["#f5f5f7", "#efeff1", "#e5e5ea", "#d1d1d6", "#c7c7cc", "#aeaeb2", "#8e8e93", "#636366", "#48484a", "#3a3a3c"];
const dark: MantineColorsTuple = ["#e6e6e8", "#c7c7cc", "#9a9aa0", "#6e6e73", "#4a4a4e", "#3a3a3d", "#2e2e31", "#1e1e20", "#18181a", "#111113"];
const red: MantineColorsTuple = ["#ffeceb", "#ffd6d4", "#ffaaa5", "#ff7c74", "#ff564c", "#ff453a", "#ff3b30", "#d70015", "#b0000f", "#8a000a"];
const green: MantineColorsTuple = ["#e8f9ec", "#d1f2d9", "#a3e5b3", "#72d78b", "#4bcb6a", "#34c759", "#28a745", "#1f8a37", "#176d2b", "#0f511f"];
const orange: MantineColorsTuple = ["#fff4e5", "#ffe6c7", "#ffcc8f", "#ffb157", "#ff9f2e", "#ff9f0a", "#ff9500", "#c65300", "#a34400", "#7a3300"];

/** Control metrics per size: height, font size, horizontal padding (px). */
const CONTROL: Record<string, { h: number; fz: number; px: number }> = {
  xs: { h: 22, fz: 12, px: 8 },
  sm: { h: 26, fz: 13, px: 11 },
  md: { h: 30, fz: 13, px: 14 },
  lg: { h: 36, fz: 15, px: 18 },
  xl: { h: 44, fz: 17, px: 22 },
};
const ctl = (size: unknown) => CONTROL[typeof size === "string" && size in CONTROL ? size : "sm"];

export const theme = createTheme({
  primaryColor: "accent",
  // Filled accent controls use shade 7 (#0066d6): white text stays above 4.5:1 in both schemes.
  primaryShade: { light: 7, dark: 7 },
  colors: { accent, gray, dark, red, green, orange },
  white: "#ffffff",
  black: "#1d1d1f",
  fontFamily: "var(--sem-font)",
  fontFamilyMonospace: "var(--sem-font-mono)",
  headings: {
    fontFamily: "var(--sem-font-display)",
    fontWeight: "600",
    sizes: {
      h1: { fontSize: "22px", lineHeight: "1.2" },
      h2: { fontSize: "17px", lineHeight: "1.25" },
      h3: { fontSize: "15px", lineHeight: "1.3" },
      h4: { fontSize: "13px", lineHeight: "1.35" },
      h5: { fontSize: "12px", lineHeight: "1.35" },
      h6: { fontSize: "11px", lineHeight: "1.35" },
    },
  },
  fontSizes: { xs: "11px", sm: "12px", md: "13px", lg: "15px", xl: "17px" },
  lineHeights: { xs: "1.35", sm: "1.4", md: "1.4", lg: "1.45", xl: "1.45" },
  spacing: { xs: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px" },
  radius: { xs: "3px", sm: "5px", md: "6px", lg: "9px", xl: "12px" },
  defaultRadius: "md",
  shadows: {
    xs: "var(--sem-shadow-1)", sm: "var(--sem-shadow-1)", md: "var(--sem-shadow-2)", lg: "var(--sem-shadow-2)", xl: "var(--sem-shadow-3)",
  },
  focusRing: "auto",
  cursorType: "default",
  respectReducedMotion: true,
  autoContrast: true,
  components: {
    Button: Button.extend({
      defaultProps: { size: "sm" },
      vars: (_t, p) => {
        const c = ctl(p.size);
        return { root: { "--button-height": `${c.h}px`, "--button-fz": `${c.fz}px`, "--button-padding-x": `${c.px}px` } };
      },
    }),
    ActionIcon: ActionIcon.extend({ defaultProps: { variant: "subtle", color: "gray" } }),
    Input: Input.extend({
      vars: (_t, p) => {
        const c = ctl(p.size);
        return { wrapper: { "--input-height": `${c.h}px`, "--input-fz": `${c.fz}px` } };
      },
    }),
    InputWrapper: InputWrapper.extend({
      defaultProps: { inputWrapperOrder: ["label", "input", "description", "error"] },
      vars: () => ({ label: { "--input-label-size": "13px", "--input-asterisk-color": "var(--sem-red)" }, description: { "--input-description-size": "12px" }, error: { "--input-error-size": "12px" }, success: {} }),
    }),
    Select: Select.extend({ defaultProps: { comboboxProps: { shadow: "md" }, allowDeselect: false } }),
    Checkbox: Checkbox.extend({ defaultProps: { size: "xs", radius: "sm" } }),
    Radio: Radio.extend({ defaultProps: { size: "xs" } }),
    Switch: Switch.extend({ defaultProps: { size: "sm", withThumbIndicator: false } }),
    SegmentedControl: SegmentedControl.extend({ defaultProps: { size: "xs", radius: "md" } }),
    Badge: Badge.extend({ defaultProps: { variant: "light", radius: "sm", size: "sm" }, styles: { root: { textTransform: "none", fontWeight: 500, letterSpacing: 0 } } }),
    Tooltip: Tooltip.extend({ defaultProps: { openDelay: 450, transitionProps: { duration: 120 }, multiline: false }, styles: { tooltip: { fontSize: 12, padding: "4px 8px" } } }),
    Popover: Popover.extend({ defaultProps: { shadow: "md", radius: "lg" } }),
    Menu: Menu.extend({ defaultProps: { shadow: "md", radius: "lg", transitionProps: { duration: 80 } }, classNames: { dropdown: "sem-menu", item: "sem-menu-item", label: "sem-menu-label", divider: "sem-menu-divider" } }),
    Modal: Modal.extend({ defaultProps: { radius: "xl", shadow: "xl", overlayProps: { backgroundOpacity: 0.2, blur: 0 }, transitionProps: { duration: 160 } }, classNames: { title: "sem-modal-title", header: "sem-modal-header" } }),
    Notification: Notification.extend({ defaultProps: { radius: "lg", withBorder: true }, classNames: { root: "sem-toast" } }),
    Paper: Paper.extend({ defaultProps: { radius: "lg" } }),
    Tabs: Tabs.extend({ classNames: { tab: "sem-tab" } }),
    NavLink: NavLink.extend({ classNames: { root: "sem-navlink" } }),
    Code: Code.extend({ classNames: { root: "sem-code" } }),
    Kbd: Kbd.extend({ defaultProps: { size: "xs" } }),
    Loader: Loader.extend({ defaultProps: { type: "oval", size: "sm", color: "gray" } }),
    Pagination: Pagination.extend({ defaultProps: { size: "sm" } }),
  },
});
