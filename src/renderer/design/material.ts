// The macOS sidebar material (vibrancy) and Windows Mica are drawn by the window, and they follow the *system*
// appearance (Electron's nativeTheme), not Mantine's colour scheme. When the user picks Light or Dark in
// Preferences and it differs from the system appearance, the material has the wrong brightness under the
// transparent sidebar (white text on a light material, or the reverse). The bridge can't change nativeTheme,
// so in that case the renderer paints the sidebar itself: html[data-material="none"] (components.css).

/** Keep html[data-material] in sync with Mantine's scheme and the system appearance. Returns a cleanup function. */
export function syncWindowMaterial(): () => void {
  const html = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    const scheme = html.getAttribute("data-mantine-color-scheme");
    const system = media.matches ? "dark" : "light";
    if (scheme && scheme !== system) html.dataset.material = "none";
    else delete html.dataset.material;
  };
  const obs = new MutationObserver(update);
  obs.observe(html, { attributes: true, attributeFilter: ["data-mantine-color-scheme"] });
  media.addEventListener("change", update);
  update();
  return () => { obs.disconnect(); media.removeEventListener("change", update); };
}
