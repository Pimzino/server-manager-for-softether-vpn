// Platform facts for copy and layout. html[data-platform] is set at start-up from window.sem.info().
export type Platform = "darwin" | "win32" | "linux";

export function platform(): Platform {
  const p = document.documentElement.dataset.platform;
  return p === "win32" || p === "linux" ? p : "darwin";
}

export const isMac = () => platform() === "darwin";

/** How saved passwords are protected, in the words each OS uses. */
export function secretStore(): { saveLabel: string; saved: string; long: string } {
  // No OS secret store available (or disabled with SEM_INSECURE_KEYSTORE): say so rather than claim Keychain/DPAPI.
  if (document.documentElement.dataset.keystore === "plain") {
    return { saveLabel: "Save password", saved: "Saved (local key file)", long: "encrypted with a key stored in a local file in the app's data folder" };
  }
  switch (platform()) {
    case "win32": return { saveLabel: "Save password", saved: "Saved (protected by Windows DPAPI)", long: "encrypted with Windows Data Protection (DPAPI) for your Windows account" };
    case "linux": return { saveLabel: "Save password", saved: "Saved (protected by the system keyring)", long: "encrypted with a key kept in the system keyring" };
    default: return { saveLabel: "Save password in Keychain", saved: "Saved in Keychain", long: "encrypted with a key kept in your macOS Keychain" };
  }
}
/** "⌘N" on macOS, "Ctrl+N" elsewhere. */
export function shortcutLabel(keys: string[]): string {
  const mac = isMac();
  const map: Record<string, string> = mac ? { mod: "⌘", shift: "⇧", alt: "⌥" } : { mod: "Ctrl", shift: "Shift", alt: "Alt" };
  const parts = keys.map((k) => map[k] ?? k.toUpperCase());
  return mac ? parts.join("") : parts.join("+");
}
