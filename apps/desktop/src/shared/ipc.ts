// Contract between the Electron main process, the preload bridge and the renderer.
// See docs/desktop-architecture.md.

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface ApiRequest { method: HttpMethod; path: string; body?: unknown }
export interface ApiResponse { status: number; body: unknown }
export interface FileFilter { name: string; extensions: string[] }
export interface SaveResult { saved: boolean; filePath?: string }
export interface AppInfo { version: string; platform: string; arch: string; electron: string; node: string; dataDir: string }

export interface SemBridge {
  /** REST-style call into the in-process API (same paths as apps/server, minus auth/admin/setup). */
  api(req: ApiRequest): Promise<ApiResponse>;
  /** GET `path` and save the response through a native Save dialog (filename from Content-Disposition). */
  download(path: string, opts?: { suggestedName?: string }): Promise<SaveResult>;
  /** Native Open dialog, then multipart POST of the chosen file to `path` (field "file", plus `fields`). null = cancelled. */
  upload(path: string, opts?: { fields?: Record<string, string>; filters?: FileFilter[]; title?: string }): Promise<ApiResponse | null>;
  /** Native Save dialog for content produced in the renderer. */
  saveFile(opts: { suggestedName: string; content: string; encoding?: "utf8" | "base64"; filters?: FileFilter[] }): Promise<SaveResult>;
  /** Native Open dialog returning the chosen file's content. null = cancelled. */
  openFile(opts?: { filters?: FileFilter[]; title?: string; encoding?: "utf8" | "base64" }): Promise<{ name: string; content: string } | null>;
  openExternal(url: string): Promise<void>;
  revealPath(filePath: string): Promise<void>;
  info(): Promise<AppInfo>;
  /** Native menu actions ("new-server", "preferences", "refresh", "navigate:<path>", ...). Returns an unsubscribe fn. */
  onMenu(cb: (action: string) => void): () => void;
}

export const CH = {
  api: "sem:api",
  download: "sem:download",
  upload: "sem:upload",
  saveFile: "sem:saveFile",
  openFile: "sem:openFile",
  openExternal: "sem:openExternal",
  revealPath: "sem:revealPath",
  info: "sem:info",
  menu: "sem:menu",
} as const;

declare global {
  interface Window { sem: SemBridge }
}
